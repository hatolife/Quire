import { Channel } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import MarkdownIt from "markdown-it";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import BrowserPane from "./browser/BrowserPane";
import NeovimEditor from "./editor/NeovimEditor";
import {
	assetRead,
	documentBacklinks,
	documentCreate,
	documentDelete,
	documentMove,
	documentOpen,
	documentResolveWikiLink,
	editorSave,
	editorSetTopLine,
	historyCreateSnapshot,
	historyList,
	historyRestoreFile,
	logAppend,
	logClear,
	logRecent,
	settingsLoad,
	settingsSave,
	workspaceList,
	workspaceOpen,
	workspaceSearch,
	workspaceWatch,
	workspaceWatchStop,
	type Backlink,
	type DesktopSettings,
	type Document,
	type LogEntry,
	type SearchHit,
	type Snapshot,
	type WorkspaceEntry,
	type WorkspaceInfo,
	type WorkspaceWatchMessage,
} from "./ipc";

const markdown = new MarkdownIt({
	html: false,
	linkify: true,
	typographer: false,
});

markdown.inline.ruler.before("emphasis", "quire_wiki_link", (state, silent) => {
	if(state.src.slice(state.pos, state.pos + 2) !== "[["){ return false; }
	const end = state.src.indexOf("]]", state.pos + 2);
	if(end < 0){ return false; }
	const body = state.src.slice(state.pos + 2, end).trim();
	if(!body){ return false; }
	const separator = body.indexOf("|");
	const target = (separator >= 0 ? body.slice(0, separator) : body).trim();
	const label = (separator >= 0 ? body.slice(separator + 1) : target).trim() || target;
	if(!target){ return false; }
	if(!silent){
		const open = state.push("link_open", "a", 1);
		open.attrSet("href", "quire-wiki:" + encodeURIComponent(target));
		open.attrSet("class", "wiki-link");
		const text = state.push("text", "", 0);
		text.content = label;
		state.push("link_close", "a", -1);
	}
	state.pos = end + 2;
	return true;
});

const PREVIEW_IMAGE_PLACEHOLDER = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

function isLocalAssetSource(source: string): boolean {
	if(!source || source.startsWith("/") || source.startsWith("\\")){ return false; }
	if(source.startsWith("#") || source.startsWith("//")){ return false; }
	return !/^[a-z][a-z0-9+.-]*:/i.test(source);
}

function decoratePreviewTokens(tokens: any[]) {
	for(const token of tokens){
		if(token.map && token.nesting === 1){
			token.attrSet("data-source-line", String(token.map[0]));
		}
		if(token.type === "image"){
			const source = token.attrGet("src");
			if(source && isLocalAssetSource(source)){
				token.attrSet("data-quire-asset", source);
				token.attrSet("src", PREVIEW_IMAGE_PLACEHOLDER);
			}
		}
		if(token.children){
			decoratePreviewTokens(token.children);
		}
	}
}

function renderPreview(source: string): string {
	const environment = {};
	const tokens = markdown.parse(source, environment);
	decoratePreviewTokens(tokens);
	return markdown.renderer.render(tokens, markdown.options, environment);
}

function contentForEditor(content: string): string {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	return normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
}

function App() {
	let workspaceElement!: HTMLDivElement;
	let previewElement!: HTMLDivElement;
	let suppressEditorViewport = false;
	let suppressPreviewScroll = false;
	let closeUnlisten: (() => void) | undefined;
	let reconcileTimer: number | undefined;
	let searchTimer: number | undefined;
	let settingsTimer: number | undefined;
	let autoSnapshotTimer: number | undefined;
	let watchGeneration = 0;
	const assetCache = new Map<string, Promise<string>>();

	const [workspace, setWorkspace] = createSignal<WorkspaceInfo | null>(null);
	const [entries, setEntries] = createSignal<WorkspaceEntry[]>([]);
	const [document, setDocument] = createSignal<Document | null>(null);
	const [draft, setDraft] = createSignal("");
	const [status, setStatus] = createSignal("Workspaceを開いてください");
	const [saving, setSaving] = createSignal(false);
	const [externalConflict, setExternalConflict] = createSignal(false);
	const [editorSession, setEditorSession] = createSignal(0);
	const [explorerWidth, setExplorerWidth] = createSignal(260);
	const [editorRatio, setEditorRatio] = createSignal(0.5);
	const [logOpen, setLogOpen] = createSignal(false);
	const [logs, setLogs] = createSignal<LogEntry[]>([]);
	const [searchQuery, setSearchQuery] = createSignal("");
	const [searchResults, setSearchResults] = createSignal<SearchHit[]>([]);
	const [searching, setSearching] = createSignal(false);
	const [initialEditorLine, setInitialEditorLine] = createSignal<number | undefined>();
	const [backlinks, setBacklinks] = createSignal<Backlink[]>([]);
	const [historyOpen, setHistoryOpen] = createSignal(false);
	const [historyBusy, setHistoryBusy] = createSignal(false);
	const [snapshots, setSnapshots] = createSignal<Snapshot[]>([]);
	const [settingsReady, setSettingsReady] = createSignal(false);
	const [rightPaneMode, setRightPaneMode] = createSignal<"preview" | "browser">("preview");
	const preview = createMemo(() => renderPreview(draft()));
	const dirty = createMemo(() => document() !== null && draft() !== contentForEditor(document()!.content));

	const decodeAssetSource = (source: string) => {
		const pathOnly = source.split("#", 1)[0].split("?", 1)[0];
		try{
			return decodeURIComponent(pathOnly);
		}catch{
			return pathOnly;
		}
	};

	const loadPreviewAsset = (documentRelativePath: string, source: string) => {
		const decoded = decodeAssetSource(source);
		const key = documentRelativePath + "\n" + decoded;
		let pending = assetCache.get(key);
		if(!pending){
			pending = assetRead(documentRelativePath, decoded).catch(error => {
				assetCache.delete(key);
				throw error;
			});
			assetCache.set(key, pending);
		}
		return pending;
	};

	const resolvePreviewAssets = async (documentRelativePath: string) => {
		if(!previewElement){ return; }
		const images = Array.from(previewElement.querySelectorAll<HTMLImageElement>("img[data-quire-asset]"));
		await Promise.all(images.map(async image => {
			const source = image.dataset.quireAsset;
			if(!source){ return; }
			try{
				image.src = await loadPreviewAsset(documentRelativePath, source);
				image.removeAttribute("data-quire-asset");
			}catch(error){
				image.alt = (image.alt ? image.alt + " — " : "") + "画像を読み込めません";
				image.classList.add("preview-asset-error");
				void appendLog("warn", "preview", "Asset load error: " + source + " / " + String(error));
			}
		}));
	};

	const appendLog = async (level: string, source: string, message: string) => {
		try{
			await logAppend(level, source, message);
		}catch{
			// Logging must never break the primary UI flow.
		}
	};

	const updateStatus = (message: string, level = "info", source = "app") => {
		setStatus(message);
		void appendLog(level, source, message);
	};

	const refreshLogs = async () => {
		try{
			setLogs(await logRecent());
		}catch(error){
			setStatus("Log read error: " + String(error));
		}
	};

	const toggleLogs = () => {
		const next = !logOpen();
		setLogOpen(next);
		if(next){ void refreshLogs(); }
	};

	const clearLogs = async () => {
		try{
			await logClear();
			setLogs([]);
		}catch(error){
			setStatus("Log clear error: " + String(error));
		}
	};

	const refreshHistory = async () => {
		if(!workspace()){
			setSnapshots([]);
			return;
		}
		setHistoryBusy(true);
		try{
			setSnapshots(await historyList());
		}catch(error){
			setSnapshots([]);
			updateStatus("History error: " + String(error), "error", "history");
		}finally{
			setHistoryBusy(false);
		}
	};

	const createHistorySnapshot = async (message = "Manual snapshot") => {
		if(!workspace()){ return false; }
		setHistoryBusy(true);
		try{
			const snapshot = await historyCreateSnapshot(message);
			updateStatus("Snapshot created: " + snapshot.id.slice(0, 7), "info", "history");
			if(historyOpen()){ await refreshHistory(); }
			return true;
		}catch(error){
			updateStatus("Snapshot error: " + String(error), "error", "history");
			return false;
		}finally{
			setHistoryBusy(false);
		}
	};

	const createSafetySnapshot = async (reason: string) => {
		const ok = await createHistorySnapshot(reason);
		if(ok){ return true; }
		return window.confirm("Safety Snapshotを作成できませんでした。履歴なしで操作を続行しますか？");
	};

	const scheduleAutoSnapshot = (relativePath: string) => {
		if(autoSnapshotTimer !== undefined){ window.clearTimeout(autoSnapshotTimer); }
		autoSnapshotTimer = window.setTimeout(() => {
			autoSnapshotTimer = undefined;
			void createHistorySnapshot("Auto save " + relativePath);
		}, 5000);
	};

	const toggleHistory = () => {
		const next = !historyOpen();
		setHistoryOpen(next);
		if(next){ void refreshHistory(); }
	};

	const restoreCurrentDocument = async (snapshot: Snapshot) => {
		const current = document();
		if(!current || dirty()){
			updateStatus("History復元の前に現在の変更を保存してください。", "warn", "history");
			return;
		}
		if(!window.confirm(snapshot.message + "\n" + new Date(snapshot.timestamp * 1000).toLocaleString() + "\n\n" + current.relativePath + " をこのSnapshotへ復元しますか？")){ return; }
		setHistoryBusy(true);
		try{
			await createHistorySnapshot("Before restore " + current.relativePath);
			const restored = await historyRestoreFile(snapshot.id, current.relativePath, current.revision);
			setDocument(restored);
			setDraft(contentForEditor(restored.content));
			setExternalConflict(false);
			setEditorSession(value => value + 1);
			assetCache.clear();
			void refreshBacklinks(restored.relativePath);
			updateStatus("Historyから復元しました: " + restored.relativePath, "info", "history");
		}catch(error){
			updateStatus("History restore error: " + String(error), "error", "history");
		}finally{
			setHistoryBusy(false);
		}
	};

	createEffect(() => {
		preview();
		const relativePath = document()?.relativePath;
		if(!relativePath){ return; }
		requestAnimationFrame(() => { void resolvePreviewAssets(relativePath); });
	});

	createEffect(() => {
		if(!settingsReady()){ return; }
		explorerWidth();
		editorRatio();
		workspace()?.root;
		document()?.relativePath;
		scheduleSettingsSave();
	});

	createEffect(() => {
		const query = searchQuery().trim();
		if(searchTimer !== undefined){ window.clearTimeout(searchTimer); }
		if(!query || !workspace()){
			setSearchResults([]);
			setSearching(false);
			return;
		}
		setSearching(true);
		searchTimer = window.setTimeout(async () => {
			try{
				setSearchResults(await workspaceSearch(query));
			}catch(error){
				updateStatus("Search error: " + String(error), "error", "search");
			}finally{
				setSearching(false);
			}
		}, 150);
	});

	const currentSettings = (): DesktopSettings => ({
		explorerWidth: explorerWidth(),
		editorRatio: editorRatio(),
		lastWorkspace: workspace()?.root ?? null,
		lastDocument: document()?.relativePath ?? null,
	});

	const persistSettings = async () => {
		if(!settingsReady()){ return; }
		try{
			await settingsSave(currentSettings());
		}catch(error){
			updateStatus("Settings save error: " + String(error), "error", "settings");
		}
	};

	const scheduleSettingsSave = () => {
		if(!settingsReady()){ return; }
		if(settingsTimer !== undefined){ window.clearTimeout(settingsTimer); }
		settingsTimer = window.setTimeout(() => {
			settingsTimer = undefined;
			void persistSettings();
		}, 200);
	};

	onMount(() => {
		void settingsLoad()
			.then(async settings => {
				setExplorerWidth(Math.max(180, Math.min(420, settings.explorerWidth)));
				setEditorRatio(Math.max(0.25, Math.min(0.75, settings.editorRatio)));
				if(settings.lastWorkspace){
					try{
						const opened = await workspaceOpen(settings.lastWorkspace);
						setWorkspace(opened.info);
						setEntries(opened.entries);
						assetCache.clear();
						setExternalConflict(false);
						void startWorkspaceWatcher();
						if(settings.lastDocument){
							try{
								const restored = await documentOpen(settings.lastDocument);
								setDocument(restored);
								setDraft(contentForEditor(restored.content));
								setInitialEditorLine(undefined);
								void refreshBacklinks(restored.relativePath);
								updateStatus("Session restored: " + restored.relativePath, "info", "session");
							}catch(error){
								setDocument(null);
								setDraft("");
								updateStatus("Last Document could not be restored: " + String(error), "warn", "session");
							}
						}else{
							updateStatus("Workspace restored: " + opened.info.name, "info", "session");
						}
					}catch(error){
						setWorkspace(null);
						setEntries([]);
						updateStatus("Last Workspace could not be restored: " + String(error), "warn", "session");
					}
				}
				setSettingsReady(true);
			})
			.catch(error => {
				setSettingsReady(true);
				updateStatus("Settings load error: " + String(error), "error", "settings");
			});

		void getCurrentWindow().onCloseRequested(event => {
			if(!dirty()){ return; }
			if(!window.confirm("未保存の変更があります。破棄してQuireを終了しますか？")){
				event.preventDefault();
			}
		}).then(unlisten => {
			closeUnlisten = unlisten;
		}).catch(error => {
			updateStatus("Window close handler error: " + String(error), "error", "window");
		});
	});

	onCleanup(() => {
		closeUnlisten?.();
		++watchGeneration;
		if(reconcileTimer !== undefined){ window.clearTimeout(reconcileTimer); }
		if(searchTimer !== undefined){ window.clearTimeout(searchTimer); }
		if(settingsTimer !== undefined){ window.clearTimeout(settingsTimer); }
		if(autoSnapshotTimer !== undefined){ window.clearTimeout(autoSnapshotTimer); }
		void workspaceWatchStop();
	});

	const previewAnchors = () => {
		const previewRect = previewElement.getBoundingClientRect();
		return Array.from(previewElement.querySelectorAll<HTMLElement>("[data-source-line]"))
			.map(element => ({
				line: Number.parseInt(element.dataset.sourceLine ?? "0", 10),
				top: element.getBoundingClientRect().top - previewRect.top + previewElement.scrollTop,
			}))
			.filter(anchor => Number.isFinite(anchor.line))
			.sort((left, right) => left.line - right.line);
	};

	const previewTopForLine = (line: number) => {
		const anchors = previewAnchors();
		if(anchors.length === 0){ return 0; }
		if(line <= anchors[0].line){ return anchors[0].top; }

		for(let index = 0; index + 1 < anchors.length; ++index){
			const current = anchors[index];
			const next = anchors[index + 1];
			if(line <= next.line){
				const lineSpan = Math.max(1, next.line - current.line);
				const ratio = Math.max(0, Math.min(1, (line - current.line) / lineSpan));
				return current.top + (next.top - current.top) * ratio;
			}
		}
		return anchors[anchors.length - 1].top;
	};

	const sourceLineForPreviewTop = (top: number) => {
		const anchors = previewAnchors();
		if(anchors.length === 0){ return 0; }
		if(top <= anchors[0].top){ return anchors[0].line; }

		for(let index = 0; index + 1 < anchors.length; ++index){
			const current = anchors[index];
			const next = anchors[index + 1];
			if(top <= next.top){
				const heightSpan = Math.max(1, next.top - current.top);
				const ratio = Math.max(0, Math.min(1, (top - current.top) / heightSpan));
				return current.line + (next.line - current.line) * ratio;
			}
		}
		return anchors[anchors.length - 1].line;
	};

	const handleEditorViewportLine = (line: number) => {
		if(suppressEditorViewport || !previewElement){ return; }
		suppressPreviewScroll = true;
		previewElement.scrollTop = previewTopForLine(line);
		requestAnimationFrame(() => { suppressPreviewScroll = false; });
	};

	const handlePreviewScroll = () => {
		if(suppressPreviewScroll || !document()){ return; }
		const line = Math.max(0, Math.floor(sourceLineForPreviewTop(previewElement.scrollTop)));
		suppressEditorViewport = true;
		void editorSetTopLine(line)
			.catch(error => updateStatus("Editor viewport error: " + String(error), "error", "editor"))
			.finally(() => requestAnimationFrame(() => { suppressEditorViewport = false; }));
	};

	const beginExplorerResize = (event: PointerEvent) => {
		event.preventDefault();
		const startX = event.clientX;
		const startWidth = explorerWidth();
		const handleMove = (moveEvent: PointerEvent) => {
			const next = Math.max(180, Math.min(420, startWidth + moveEvent.clientX - startX));
			setExplorerWidth(next);
		};
		const handleUp = () => {
			window.removeEventListener("pointermove", handleMove);
			window.removeEventListener("pointerup", handleUp);
			scheduleSettingsSave();
		};
		window.addEventListener("pointermove", handleMove);
		window.addEventListener("pointerup", handleUp, { once: true });
	};

	const beginEditorPreviewResize = (event: PointerEvent) => {
		event.preventDefault();
		const rect = workspaceElement.getBoundingClientRect();
		const explorer = explorerWidth();
		const splitters = 8;
		const remaining = Math.max(560, rect.width - explorer - splitters);
		const handleMove = (moveEvent: PointerEvent) => {
			const editorWidth = moveEvent.clientX - rect.left - explorer - 4;
			const ratio = editorWidth / remaining;
			setEditorRatio(Math.max(0.25, Math.min(0.75, ratio)));
		};
		const handleUp = () => {
			window.removeEventListener("pointermove", handleMove);
			window.removeEventListener("pointerup", handleUp);
			scheduleSettingsSave();
		};
		window.addEventListener("pointermove", handleMove);
		window.addEventListener("pointerup", handleUp, { once: true });
	};

	const chooseWorkspace = async () => {
		if(dirty() && !window.confirm("未保存の変更があります。破棄して別のWorkspaceを開きますか？")){ return; }
		const selected = await open({
			directory: true,
			multiple: false,
			title: "Quire Workspaceを開く",
		});
		if(typeof selected !== "string"){ return; }
		try{
			const opened = await workspaceOpen(selected);
			setWorkspace(opened.info);
			setEntries(opened.entries);
			assetCache.clear();
			setExternalConflict(false);
			void startWorkspaceWatcher();
			setDocument(null);
			setDraft("");
			updateStatus(opened.info.name + " を開きました", "info", "workspace");
		}catch(error){
			updateStatus("Workspace open error: " + String(error), "error", "workspace");
		}
	};

	const loadDirectory = async (relativePath: string) => {
		return workspaceList(relativePath);
	};

	const reconcileExternalChanges = async () => {
		await refreshExplorer();
		const current = document();
		if(!current){ return; }
		try{
			const disk = await documentOpen(current.relativePath);
			if(disk.revision === current.revision){
				setExternalConflict(false);
				return;
			}
			if(dirty()){
				setExternalConflict(true);
				updateStatus("外部変更を検出しました。未保存bufferは保持しています: " + current.relativePath, "warn", "watcher");
				return;
			}
			setDocument(disk);
			setDraft(contentForEditor(disk.content));
			setExternalConflict(false);
			setEditorSession(value => value + 1);
			assetCache.clear();
			updateStatus("外部変更を再読込しました: " + disk.relativePath, "info", "watcher");
		}catch(error){
			if(dirty()){
				setExternalConflict(true);
				updateStatus("外部変更を検出しました。Documentを再読込できません: " + String(error), "warn", "watcher");
			}else{
				setDocument(null);
				setDraft("");
				setExternalConflict(false);
				updateStatus("開いていたDocumentが外部で削除または移動されました。", "warn", "watcher");
			}
		}
	};

	const scheduleExternalReconcile = () => {
		if(reconcileTimer !== undefined){ window.clearTimeout(reconcileTimer); }
		reconcileTimer = window.setTimeout(() => {
			reconcileTimer = undefined;
			void reconcileExternalChanges();
		}, 200);
	};

	const startWorkspaceWatcher = async () => {
		const generation = ++watchGeneration;
		const stream = new Channel<WorkspaceWatchMessage>();
		stream.onmessage = message => {
			if(generation !== watchGeneration){ return; }
			if(message.kind === "error"){
				updateStatus("Watcher error: " + message.message, "error", "watcher");
				return;
			}
			scheduleExternalReconcile();
		};
		try{
			await workspaceWatch(stream);
			updateStatus("Workspace watcher started", "info", "watcher");
		}catch(error){
			updateStatus("Workspace watcher start error: " + String(error), "error", "watcher");
		}
	};

	const refreshExplorer = async () => {
		try{
			setEntries(await workspaceList(""));
		}catch(error){
			updateStatus("Explorer refresh error: " + String(error), "error", "explorer");
		}
	};

	const normalizeMarkdownPath = (value: string) => {
		const trimmed = value.trim().replace(/\\/g, "/");
		if(!trimmed){ return ""; }
		return /\.md(?:own)?$/i.test(trimmed) ? trimmed : trimmed + ".md";
	};

	const createDocument = async () => {
		if(!workspace()){ return; }
		const input = window.prompt("Workspaceからの相対pathを入力してください。", "新規.md");
		if(input === null){ return; }
		const relativePath = normalizeMarkdownPath(input);
		if(!relativePath){ return; }
		try{
			const created = await documentCreate(relativePath);
			await refreshExplorer();
			setDocument(created);
			setDraft(contentForEditor(created.content));
			setExternalConflict(false);
			setBacklinks([]);
			updateStatus(created.relativePath + " を作成しました", "info", "document");
		}catch(error){
			updateStatus("Document create error: " + String(error), "error", "document");
		}
	};

	const moveCurrentDocument = async () => {
		const current = document();
		if(!current || dirty()){ 
			if(dirty()){ updateStatus("移動・名前変更の前に保存してください。", "warn", "document"); }
			return;
		}
		const input = window.prompt("移動先をWorkspaceからの相対pathで入力してください。", current.relativePath);
		if(input === null){ return; }
		const relativePath = normalizeMarkdownPath(input);
		if(!relativePath || relativePath === current.relativePath){ return; }
		try{
			if(!await createSafetySnapshot("Before move " + current.relativePath)){ return; }
			const moved = await documentMove(current.relativePath, relativePath, current.revision);
			assetCache.clear();
			await refreshExplorer();
			setDocument(moved);
			setDraft(contentForEditor(moved.content));
			setExternalConflict(false);
			void refreshBacklinks(moved.relativePath);
			updateStatus(current.relativePath + " → " + moved.relativePath, "info", "document");
		}catch(error){
			updateStatus("Document move error: " + String(error), "error", "document");
		}
	};

	const deleteCurrentDocument = async () => {
		const current = document();
		if(!current){ return; }
		if(dirty()){
			updateStatus("削除の前に保存するか変更を破棄してください。", "warn", "document");
			return;
		}
		if(!window.confirm(current.relativePath + " を削除しますか？\n削除前にSafety Snapshotを作成します。")){ return; }
		try{
			if(!await createSafetySnapshot("Before delete " + current.relativePath)){ return; }
			await documentDelete(current.relativePath, current.revision);
			setDocument(null);
			setDraft("");
			setExternalConflict(false);
			setBacklinks([]);
			assetCache.clear();
			await refreshExplorer();
			updateStatus(current.relativePath + " を削除しました", "info", "document");
		}catch(error){
			updateStatus("Document delete error: " + String(error), "error", "document");
		}
	};

	const openDocument = async (relativePath: string, line?: number) => {
		if(dirty() && !window.confirm("未保存の変更があります。破棄して別の文書を開きますか？")){ return; }
		try{
			const opened = await documentOpen(relativePath);
			setDocument(opened);
			setDraft(contentForEditor(opened.content));
			setExternalConflict(false);
			setInitialEditorLine(line);
			if(line !== undefined || document()?.relativePath === relativePath){
				setEditorSession(value => value + 1);
			}
			void refreshBacklinks(relativePath);
			updateStatus(relativePath, "info", "document");
		}catch(error){
			updateStatus("Document open error: " + String(error), "error", "document");
		}
	};

	const openSearchHit = async (hit: SearchHit) => {
		await openDocument(hit.relativePath, hit.line);
	};

	const refreshBacklinks = async (relativePath: string) => {
		try{
			setBacklinks(await documentBacklinks(relativePath));
		}catch(error){
			setBacklinks([]);
			updateStatus("Backlink error: " + String(error), "error", "links");
		}
	};

	const handlePreviewClick = async (event: MouseEvent) => {
		const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[href^='quire-wiki:']");
		if(!anchor){ return; }
		event.preventDefault();
		const current = document();
		if(!current){ return; }
		const encoded = anchor.getAttribute("href")?.slice("quire-wiki:".length) ?? "";
		const target = decodeURIComponent(encoded);
		try{
			const resolved = await documentResolveWikiLink(current.relativePath, target);
			if(!resolved){
				updateStatus("未解決Wiki Link: [[" + target + "]]", "warn", "links");
				return;
			}
			await openDocument(resolved);
		}catch(error){
			updateStatus("Wiki Link error: " + String(error), "error", "links");
		}
	};

	const saveDocument = async () => {
		const current = document();
		if(!current || !dirty() || saving()){ return; }
		setSaving(true);
		try{
			const saved = await editorSave(current.revision);
			setDocument(saved);
			setDraft(contentForEditor(saved.content));
			setExternalConflict(false);
			updateStatus(saved.relativePath + " を保存しました", "info", "save");
			scheduleAutoSnapshot(saved.relativePath);
		}catch(error){
			updateStatus("Save error: " + String(error), "error", "save");
		}finally{
			setSaving(false);
		}
	};

	return (
		<div class="app">
			<header class="toolbar">
				<strong>Quire</strong>
				<button onClick={() => void chooseWorkspace()}>Workspaceを開く</button>
				<Show when={workspace()}>{value => <span class="workspace-path">{value().root}</span>}</Show>
				<span class="toolbar-spacer" />
				<Show when={workspace()}>
					<button disabled={historyBusy()} onClick={() => void createHistorySnapshot()}>Snapshot</button>
					<button onClick={toggleHistory}>履歴</button>
				</Show>
				<Show when={document()}>
					<button disabled={!dirty() || saving()} onClick={() => void saveDocument()}>
						{saving() ? "保存中..." : dirty() ? "保存 *" : "保存"}
					</button>
				</Show>
			</header>

			<Show
				when={workspace()}
				fallback={
					<main class="welcome">
						<h1>Quire</h1>
						<p>通常のフォルダを、そのままWorkspaceとして扱います。</p>
						<button class="primary" onClick={() => void chooseWorkspace()}>Workspaceを開く</button>
					</main>
				}
			>
				<div
					ref={workspaceElement}
					class="workspace"
					style={"grid-template-columns: " + explorerWidth() + "px 4px minmax(280px, " + editorRatio() + "fr) 4px minmax(280px, " + (1 - editorRatio()) + "fr)"}
				>
					<aside class="explorer">
						<div class="pane-title explorer-title">
							<span>Explorer</span>
							<span class="toolbar-spacer" />
							<button class="pane-action" title="新規Markdown" onClick={() => void createDocument()}>＋</button>
							<button class="pane-action" title="再読込" onClick={() => void refreshExplorer()}>↻</button>
						</div>
						<div class="explorer-search-row">
							<input
								class="explorer-search"
								type="search"
								value={searchQuery()}
								onInput={event => setSearchQuery(event.currentTarget.value)}
								placeholder="ファイル名・本文を検索"
							/>
						</div>
						<div class="tree explorer-body">
							<Show
								when={searchQuery().trim()}
								fallback={
									<For each={entries()}>
										{entry => <TreeEntry entry={entry} loadDirectory={loadDirectory} openDocument={openDocument} />}
									</For>
								}
							>
								<Show when={!searching()} fallback={<div class="search-state">検索中...</div>}>
									<For each={searchResults()}>
										{hit => (
											<button class="search-hit" onClick={() => void openSearchHit(hit)}>
												<span class="search-hit-path">
													{hit.relativePath}{hit.line ? ":" + hit.line : ""}
												</span>
												<span class="search-hit-preview">{hit.preview}</span>
											</button>
										)}
									</For>
									<Show when={searchResults().length === 0}>
										<div class="search-state">該当なし</div>
									</Show>
								</Show>
							</Show>
						</div>
					</aside>
					<div
						class="pane-splitter"
						role="separator"
						aria-orientation="vertical"
						onPointerDown={event => beginExplorerResize(event as PointerEvent)}
					/>
					<section class="editor-pane">
						<div class="pane-title">
							<span class="pane-document-path">{document()?.relativePath ?? "Editor"}</span>
							<Show when={dirty()}><span class="dirty-mark">●</span></Show>
							<Show when={externalConflict()}><span class="external-conflict">外部変更</span></Show>
							<span class="toolbar-spacer" />
							<Show when={document()}>
								<button class="pane-action" title="移動・名前変更" disabled={dirty()} onClick={() => void moveCurrentDocument()}>移動</button>
								<button class="pane-action danger" title="削除" disabled={dirty()} onClick={() => void deleteCurrentDocument()}>削除</button>
							</Show>
						</div>
						<For
							each={document() ? [{ relativePath: document()!.relativePath, session: editorSession() }] : []}
							fallback={<div class="empty-pane">左からMarkdownを選択してください。</div>}
						>
							{item => (
								<NeovimEditor
									relativePath={item.relativePath}
									initialLine={initialEditorLine()}
									onTextChange={setDraft}
									onViewportLineChange={handleEditorViewportLine}
									onStatus={message => updateStatus(message, message.toLowerCase().includes("error") || message.toLowerCase().includes("closed") ? "error" : "info", "editor")}
									onSave={() => void saveDocument()}
								/>
							)}
						</For>
					</section>
					<div
						class="pane-splitter"
						role="separator"
						aria-orientation="vertical"
						onPointerDown={event => beginEditorPreviewResize(event as PointerEvent)}
					/>
					<section class="preview-pane">
						<div class="pane-title right-pane-title">
							<button
								class="pane-tab"
								classList={{ active: rightPaneMode() === "preview" }}
								onClick={() => setRightPaneMode("preview")}
							>
								Preview
							</button>
							<button
								class="pane-tab"
								classList={{ active: rightPaneMode() === "browser" }}
								onClick={() => setRightPaneMode("browser")}
							>
								Browser
							</button>
						</div>
						<div class="right-pane-content">
							<div class="right-pane-layer" classList={{ hidden: rightPaneMode() !== "preview" }}>
								<Show
									when={document()}
									fallback={<div class="empty-pane">Preview</div>}
								>
									<div class="preview-scroll" ref={previewElement} onScroll={handlePreviewScroll}>
										<article
											class="markdown-preview"
											innerHTML={preview()}
											onClick={event => void handlePreviewClick(event as MouseEvent)}
										/>
										<Show when={backlinks().length > 0}>
											<section class="backlinks">
												<h3>Backlinks</h3>
												<For each={backlinks()}>
													{backlink => (
														<button class="backlink" onClick={() => void openDocument(backlink.sourcePath, backlink.line)}>
															<span>{backlink.sourcePath}:{backlink.line}</span>
															<small>{backlink.preview}</small>
														</button>
													)}
												</For>
											</section>
										</Show>
									</div>
								</Show>
							</div>
							<div class="right-pane-layer" classList={{ hidden: rightPaneMode() !== "browser" }}>
								<BrowserPane
									active={rightPaneMode() === "browser"}
									onStatus={message => updateStatus(message, message.toLowerCase().includes("error") ? "error" : "info", "browser")}
								/>
							</div>
						</div>
					</section>
				</div>
			</Show>

			<Show when={historyOpen()}>
				<div class="history-drawer">
					<div class="history-drawer-header">
						<strong>History</strong>
						<span>{snapshots().length} snapshots</span>
						<span class="toolbar-spacer" />
						<button disabled={historyBusy()} onClick={() => void createHistorySnapshot()}>Snapshot</button>
						<button disabled={historyBusy()} onClick={() => void refreshHistory()}>更新</button>
						<button onClick={() => setHistoryOpen(false)}>閉じる</button>
					</div>
					<div class="history-list">
						<Show when={!historyBusy()} fallback={<div class="history-empty">処理中...</div>}>
							<For each={snapshots()}>
								{snapshot => (
									<div class="history-entry">
										<div>
											<strong>{snapshot.message}</strong>
											<small>{new Date(snapshot.timestamp * 1000).toLocaleString()} · {snapshot.id.slice(0, 7)}</small>
										</div>
										<button disabled={!document() || dirty()} onClick={() => void restoreCurrentDocument(snapshot)}>現在の文書を復元</button>
									</div>
								)}
							</For>
							<Show when={snapshots().length === 0}>
								<div class="history-empty">Snapshotはありません。</div>
							</Show>
						</Show>
					</div>
				</div>
			</Show>

			<Show when={logOpen()}>
				<div class="log-drawer">
					<div class="log-drawer-header">
						<strong>Recent logs</strong>
						<span>{logs().length} / 300</span>
						<span class="toolbar-spacer" />
						<button onClick={() => void refreshLogs()}>更新</button>
						<button onClick={() => void clearLogs()}>クリア</button>
						<button onClick={() => setLogOpen(false)}>閉じる</button>
					</div>
					<div class="log-list">
						<For each={logs()}>
							{entry => (
								<div class={"log-entry " + entry.level}>
									<time>{new Date(entry.timestampMs).toLocaleTimeString()}</time>
									<span class="log-source">{entry.source}</span>
									<span>{entry.message}</span>
								</div>
							)}
						</For>
						<Show when={logs().length === 0}>
							<div class="log-empty">ログはありません。</div>
						</Show>
					</div>
				</div>
			</Show>

			<footer class="statusbar statusbar-clickable" onClick={toggleLogs} title="クリックで直近ログを表示">
				<span>{status()}</span>
				<span class="toolbar-spacer" />
				<span>Milestone 2 / Application Skeleton</span>
			</footer>
		</div>
	);
}

function TreeEntry(props: {
	entry: WorkspaceEntry;
	loadDirectory: (relativePath: string) => Promise<WorkspaceEntry[]>;
	openDocument: (relativePath: string) => Promise<void>;
}) {
	const [expanded, setExpanded] = createSignal(false);
	const [children, setChildren] = createSignal<WorkspaceEntry[] | null>(null);

	const activate = async () => {
		if(props.entry.kind === "directory"){
			if(!expanded() && children() === null){
				setChildren(await props.loadDirectory(props.entry.relativePath));
			}
			setExpanded(!expanded());
			return;
		}
		if(props.entry.kind === "markdown"){
			await props.openDocument(props.entry.relativePath);
		}
	};

	return (
		<div>
			<button
				class={"tree-entry " + props.entry.kind}
				onClick={() => void activate()}
				title={props.entry.relativePath}
			>
				<span class="tree-icon">
					{props.entry.kind === "directory" ? (expanded() ? "▾" : "▸") : props.entry.kind === "markdown" ? "◇" : "·"}
				</span>
				<span>{props.entry.name}{props.entry.kind === "directory" ? "/" : ""}</span>
			</button>
			<Show when={expanded() && children()}>
				<div class="tree-children">
					<For each={children() ?? []}>
						{entry => <TreeEntry entry={entry} loadDirectory={props.loadDirectory} openDocument={props.openDocument} />}
					</For>
				</div>
			</Show>
		</div>
	);
}

export default App;
