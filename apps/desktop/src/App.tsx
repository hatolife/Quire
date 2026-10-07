import { Channel } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import MarkdownIt from "markdown-it";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import BrowserPane from "./browser/BrowserPane";
import CommandPalette, { type AppCommand } from "./commands/CommandPalette";
import NeovimEditor from "./editor/NeovimEditor";
import {
	assetImport,
	assetRead,
	documentBacklinks,
	documentCreate,
	documentDelete,
	documentMove,
	documentOpen,
	documentResolveMarkdownLink,
	documentResolveWikiLink,
	editorGotoLine,
	editorInsertText,
	editorReplaceContent,
	editorSave,
	editorSetTopLine,
	historyCreateSnapshot,
	historyList,
	historyListDocuments,
	historyReadFile,
	historyRestoreFile,
	logAppend,
	logClear,
	logRecent,
	recoveryClear,
	recoveryLoad,
	recoverySave,
	settingsLoad,
	settingsSave,
	workspaceList,
	workspaceOpen,
	workspaceReindex,
	workspaceSearch,
	workspaceWatch,
	workspaceWatchStop,
	type Backlink,
	type DesktopSettings,
	type Document,
	type LogEntry,
	type RecoveryDraft,
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

markdown.inline.ruler.before("emphasis", "quire_wiki_embed", (state, silent) => {
	if(state.src.slice(state.pos, state.pos + 3) !== "![["){ return false; }
	const end = state.src.indexOf("]]", state.pos + 3);
	if(end < 0){ return false; }
	const body = state.src.slice(state.pos + 3, end).trim();
	if(!body){ return false; }
	const separator = body.indexOf("|");
	const target = (separator >= 0 ? body.slice(0, separator) : body).trim();
	const label = (separator >= 0 ? body.slice(separator + 1) : target).trim() || target;
	if(!target){ return false; }
	if(!silent){
		const token = state.push("quire_wiki_embed", "", 0);
		token.meta = { target, label };
	}
	state.pos = end + 2;
	return true;
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

function isPreviewImageTarget(target: string): boolean {
	const path = target.split("#", 1)[0].split("?", 1)[0];
	return /\.(?:png|jpe?g|gif|webp|bmp|avif|svg|ico)$/i.test(path);
}

markdown.renderer.rules.quire_wiki_embed = (tokens, index) => {
	const token = tokens[index];
	const target = String(token.meta?.target ?? "");
	const label = String(token.meta?.label ?? target);
	const sourceDocument = token.attrGet("data-quire-source-document") ?? "";
	const disabled = token.attrGet("data-quire-document-embed-disabled") === "true";
	const sourceAttr = sourceDocument ? ' data-quire-source-document="' + escapePreviewHtml(sourceDocument) + '"' : "";
	if(isPreviewImageTarget(target)){
		return '<img class="wiki-embed-image" src="' + PREVIEW_IMAGE_PLACEHOLDER
			+ '" data-quire-asset="' + escapePreviewHtml(target)
			+ '"' + sourceAttr
			+ ' alt="' + escapePreviewHtml(label) + '">';
	}
	if(disabled){
		return '<a class="wiki-link wiki-embed-fallback" href="quire-wiki:' + encodeURIComponent(target)
			+ '"' + sourceAttr + '>' + escapePreviewHtml(label) + '</a>';
	}
	return '<section class="wiki-document-embed" data-quire-wiki-embed-target="' + escapePreviewHtml(target)
		+ '"' + sourceAttr + '><div class="wiki-document-embed-loading">埋め込みを読み込み中: '
		+ escapePreviewHtml(label) + '</div></section>';
};

function isLocalAssetSource(source: string): boolean {
	if(!source || source.startsWith("/") || source.startsWith("\\")){ return false; }
	if(source.startsWith("#") || source.startsWith("//")){ return false; }
	return !/^[a-z][a-z0-9+.-]*:/i.test(source);
}

function decoratePreviewTokens(
	tokens: any[],
	lineOffset = 0,
	sourceDocument?: string,
	allowDocumentEmbeds = true,
) {
	for(const token of tokens){
		if(token.map && token.nesting === 1){
			token.attrSet("data-source-line", String(token.map[0] + lineOffset));
		}
		if(sourceDocument && token.type === "link_open"){
			token.attrSet("data-quire-source-document", sourceDocument);
		}
		if(token.type === "image"){
			const source = token.attrGet("src");
			if(source && isLocalAssetSource(source)){
				token.attrSet("data-quire-asset", source);
				if(sourceDocument){ token.attrSet("data-quire-source-document", sourceDocument); }
				token.attrSet("src", PREVIEW_IMAGE_PLACEHOLDER);
			}
		}
		if(token.type === "quire_wiki_embed"){
			if(sourceDocument){ token.attrSet("data-quire-source-document", sourceDocument); }
			if(!allowDocumentEmbeds){ token.attrSet("data-quire-document-embed-disabled", "true"); }
		}
		if(token.children){
			decoratePreviewTokens(token.children, lineOffset, sourceDocument, allowDocumentEmbeds);
		}
	}
}

function escapePreviewHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function splitFrontMatter(source: string): { body: string; lineOffset: number; frontMatter?: string } {
	const normalized = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if(!normalized.startsWith("---\n")){ return { body: normalized, lineOffset: 0 }; }
	const lines = normalized.split("\n");
	for(let index = 1; index < lines.length; ++index){
		if(lines[index] !== "---" && lines[index] !== "..."){ continue; }
		return {
			frontMatter: lines.slice(1, index).join("\n"),
			body: lines.slice(index + 1).join("\n"),
			lineOffset: index + 1,
		};
	}
	return { body: normalized, lineOffset: 0 };
}

function renderFrontMatter(frontMatter: string | undefined): string {
	if(frontMatter === undefined){ return ""; }
	return [
		'<details class="frontmatter" data-source-line="0">',
		"<summary>Properties</summary>",
		"<pre>",
		escapePreviewHtml(frontMatter),
		"</pre>",
		"</details>",
	].join("");
}

function decorateCalloutTokens(tokens: any[]) {
	for(let index = 0; index < tokens.length; ++index){
		if(tokens[index].type !== "blockquote_open"){ continue; }
		let depth = 1;
		let inlineIndex = -1;
		for(let cursor = index + 1; cursor < tokens.length && depth > 0; ++cursor){
			if(tokens[cursor].type === "blockquote_open"){ ++depth; }
			if(tokens[cursor].type === "blockquote_close"){ --depth; }
			if(depth === 1 && inlineIndex < 0 && tokens[cursor].type === "inline"){
				inlineIndex = cursor;
			}
		}
		if(inlineIndex < 0){ continue; }

		const inline = tokens[inlineIndex];
		const match = inline.content.match(/^\[!([A-Za-z0-9_-]+)\]([+-])?[ \t]*(.*)$/);
		if(!match){ continue; }

		const type = match[1].toLowerCase();
		const title = match[3].trim() || match[1].toUpperCase();
		tokens[index].attrJoin("class", "callout callout-" + type);
		tokens[index].attrSet("data-callout", type);
		if(match[2]){ tokens[index].attrSet("data-callout-fold", match[2]); }

		for(let cursor = index + 1; cursor < inlineIndex; ++cursor){
			if(tokens[cursor].type === "paragraph_open"){
				tokens[cursor].attrJoin("class", "callout-title");
				break;
			}
		}

		inline.content = title;
		if(Array.isArray(inline.children) && inline.children.length > 0){
			inline.children[0].content = title;
			for(let childIndex = 1; childIndex < inline.children.length; ++childIndex){
				inline.children[childIndex].content = "";
			}
		}
	}
}

function renderPreview(source: string, sourceDocument?: string, allowDocumentEmbeds = true): string {
	const parsed = splitFrontMatter(source);
	const environment = {};
	const tokens = markdown.parse(parsed.body, environment);
	decoratePreviewTokens(tokens, parsed.lineOffset, sourceDocument, allowDocumentEmbeds);
	decorateCalloutTokens(tokens);
	return renderFrontMatter(parsed.frontMatter) + markdown.renderer.render(tokens, markdown.options, environment);
}

function contentForEditor(content: string): string {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	return normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
}

function decodeHeadingFragment(fragment: string): string {
	const raw = fragment.startsWith("#") ? fragment.slice(1) : fragment;
	try{
		return decodeURIComponent(raw);
	}catch{
		return raw;
	}
}

function headingSlug(value: string): string {
	return value
		.normalize("NFKC")
		.toLocaleLowerCase()
		.trim()
		.replace(/[^\p{L}\p{N}\s_-]/gu, "")
		.replace(/[\s_]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

function cleanHeadingText(value: string): string {
	return value
		.replace(/\s+#+\s*$/, "")
		.replace(/[*_~]/g, "")
		.replace(new RegExp(String.fromCharCode(96), "g"), "")
		.trim();
}

function findHeadingLine(source: string, fragment: string): number | undefined {
	const wanted = decodeHeadingFragment(fragment).trim();
	if(!wanted || wanted.startsWith("^")){ return undefined; }
	const wantedLower = wanted.toLocaleLowerCase();
	const wantedSlug = headingSlug(wanted);
	const lines = source.split("\n");
	let inFence = false;
	const backtickFence = String.fromCharCode(96, 96, 96);

	const matches = (text: string) => {
		const cleaned = cleanHeadingText(text);
		return cleaned.toLocaleLowerCase() === wantedLower || headingSlug(cleaned) === wantedSlug;
	};

	for(let index = 0; index < lines.length; ++index){
		const line = lines[index];
		const trimmed = line.trimStart();
		if(trimmed.startsWith(backtickFence) || trimmed.startsWith("~~~")){
			inFence = !inFence;
			continue;
		}
		if(inFence){ continue; }

		const atx = line.match(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)\s*$/);
		if(atx && matches(atx[1])){ return index + 1; }

		if(index + 1 < lines.length && line.trim()){
			const underline = lines[index + 1];
			if(/^[ \t]{0,3}(?:=+|-+)[ \t]*$/.test(underline) && matches(line)){
				return index + 1;
			}
		}
	}
	return undefined;
}

function linkFragment(value: string): string | undefined {
	const index = value.indexOf("#");
	if(index < 0 || index + 1 >= value.length){ return undefined; }
	return value.slice(index + 1);
}

function App() {
	let workspaceElement!: HTMLDivElement;
	let previewElement!: HTMLDivElement;
	let explorerSearchInput!: HTMLInputElement;
	let suppressEditorViewport = false;
	let suppressPreviewScroll = false;
	let closeUnlisten: (() => void) | undefined;
	let commandKeyHandler: ((event: KeyboardEvent) => void) | undefined;
	let reconcileTimer: number | undefined;
	let searchTimer: number | undefined;
	let settingsTimer: number | undefined;
	let autoSnapshotTimer: number | undefined;
	let recoveryTimer: number | undefined;
	let watchGeneration = 0;
	let searchReindexPending = false;
	let previewResolveGeneration = 0;
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
	const [searchIndexReady, setSearchIndexReady] = createSignal(false);
	const [searchIndexBuilding, setSearchIndexBuilding] = createSignal(false);
	const [initialEditorLine, setInitialEditorLine] = createSignal<number | undefined>();
	const [backlinks, setBacklinks] = createSignal<Backlink[]>([]);
	const [historyOpen, setHistoryOpen] = createSignal(false);
	const [historyBusy, setHistoryBusy] = createSignal(false);
	const [snapshots, setSnapshots] = createSignal<Snapshot[]>([]);
	const [historyComparison, setHistoryComparison] = createSignal<{ snapshot: Snapshot; content: string | null } | null>(null);
	const [historyDocuments, setHistoryDocuments] = createSignal<{ snapshot: Snapshot; paths: string[] } | null>(null);
	const [settingsReady, setSettingsReady] = createSignal(false);
	const [settingsOpen, setSettingsOpen] = createSignal(false);
	const [autoSnapshotEnabled, setAutoSnapshotEnabled] = createSignal(true);
	const [autoSnapshotDelaySeconds, setAutoSnapshotDelaySeconds] = createSignal(5);
	const [rightPaneMode, setRightPaneMode] = createSignal<"preview" | "browser">("preview");
	const [browserTargetUrl, setBrowserTargetUrl] = createSignal<string | undefined>();
	const [commandPaletteOpen, setCommandPaletteOpen] = createSignal(false);
	const [recoveryDraft, setRecoveryDraft] = createSignal<RecoveryDraft | null>(null);
	const [recoveryTrackingReady, setRecoveryTrackingReady] = createSignal(false);
	const preview = createMemo(() => renderPreview(draft(), document()?.relativePath));
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

	const resolvePreviewAssets = async (documentRelativePath: string, generation = previewResolveGeneration) => {
		if(!previewElement){ return; }
		const images = Array.from(previewElement.querySelectorAll<HTMLImageElement>("img[data-quire-asset]"));
		await Promise.all(images.map(async image => {
			const source = image.dataset.quireAsset;
			if(!source){ return; }
			const sourceDocument = image.dataset.quireSourceDocument || documentRelativePath;
			try{
				const resolved = await loadPreviewAsset(sourceDocument, source);
				if(generation !== previewResolveGeneration){ return; }
				image.src = resolved;
				image.removeAttribute("data-quire-asset");
			}catch(error){
				if(generation !== previewResolveGeneration){ return; }
				image.alt = (image.alt ? image.alt + " — " : "") + "画像を読み込めません";
				image.classList.add("preview-asset-error");
				void appendLog("warn", "preview", "Asset load error: " + source + " / " + String(error));
			}
		}));
	};

	const resolvePreviewEmbeds = async (documentRelativePath: string, generation: number) => {
		if(!previewElement){ return; }
		const embeds = Array.from(previewElement.querySelectorAll<HTMLElement>("[data-quire-wiki-embed-target]"));
		await Promise.all(embeds.map(async element => {
			const rawTarget = element.dataset.quireWikiEmbedTarget;
			if(!rawTarget){ return; }
			const sourceDocument = element.dataset.quireSourceDocument || documentRelativePath;
			try{
				const resolved = await documentResolveWikiLink(sourceDocument, rawTarget);
				if(generation !== previewResolveGeneration){ return; }
				if(!resolved){
					element.innerHTML = '<div class="wiki-document-embed-error">未解決embed: '
						+ escapePreviewHtml(rawTarget) + "</div>";
					return;
				}
				const embedded = await documentOpen(resolved);
				if(generation !== previewResolveGeneration){ return; }
				element.dataset.quireEmbeddedDocument = resolved;
				element.removeAttribute("data-quire-wiki-embed-target");
				element.innerHTML = renderPreview(contentForEditor(embedded.content), resolved, false);
			}catch(error){
				if(generation !== previewResolveGeneration){ return; }
				element.innerHTML = '<div class="wiki-document-embed-error">embed読込失敗: '
					+ escapePreviewHtml(String(error)) + "</div>";
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

	const rebuildSearchIndex = async (reason = "manual") => {
		if(!workspace()){
			setSearchIndexReady(false);
			return;
		}
		if(searchIndexBuilding()){
			searchReindexPending = true;
			return;
		}
		setSearchIndexBuilding(true);
		try{
			do{
				searchReindexPending = false;
				const count = await workspaceReindex();
				if(count !== null){
					setSearchIndexReady(true);
					const current = document();
					if(current){
						void documentBacklinks(current.relativePath)
							.then(setBacklinks)
							.catch(error => updateStatus("Backlink index read error: " + String(error), "error", "links"));
					}
					void appendLog("info", "index", "Search/link indexes rebuilt: " + count + " documents / " + reason);
				}
			}while(searchReindexPending && workspace());
		}catch(error){
			setSearchIndexReady(false);
			updateStatus("Search index rebuild error: " + String(error), "error", "index");
		}finally{
			setSearchIndexBuilding(false);
		}
	};

	const invalidateSearchIndex = (reason: string) => {
		setSearchIndexReady(false);
		void rebuildSearchIndex(reason);
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
		if(!autoSnapshotEnabled()){ return; }
		autoSnapshotTimer = window.setTimeout(() => {
			autoSnapshotTimer = undefined;
			void createHistorySnapshot("Auto save " + relativePath);
		}, autoSnapshotDelaySeconds() * 1000);
	};

	const resetPaneLayout = () => {
		setExplorerWidth(260);
		setEditorRatio(0.5);
		scheduleSettingsSave();
	};

	const toggleHistory = () => {
		const next = !historyOpen();
		setHistoryOpen(next);
		if(!next){
			setHistoryComparison(null);
			setHistoryDocuments(null);
		}
		if(next){ void refreshHistory(); }
	};

	const showHistoryDocuments = async (snapshot: Snapshot) => {
		setHistoryBusy(true);
		try{
			const paths = await historyListDocuments(snapshot.id);
			setHistoryComparison(null);
			setHistoryDocuments({ snapshot, paths });
		}catch(error){
			updateStatus("History Document list error: " + String(error), "error", "history");
		}finally{
			setHistoryBusy(false);
		}
	};

	const compareHistorySnapshot = async (snapshot: Snapshot) => {
		setHistoryDocuments(null);
		const current = document();
		if(!current){ return; }
		setHistoryBusy(true);
		try{
			const content = await historyReadFile(snapshot.id, current.relativePath);
			setHistoryComparison({ snapshot, content });
		}catch(error){
			updateStatus("History compare error: " + String(error), "error", "history");
		}finally{
			setHistoryBusy(false);
		}
	};

	const restoreHistoryDocument = async (snapshot: Snapshot, relativePath: string) => {
		if(dirty()){
			updateStatus("History復元の前に現在の変更を保存してください。", "warn", "history");
			return;
		}
		if(!window.confirm(snapshot.message + "\n\n" + relativePath + " をこのSnapshotから復元しますか？")){ return; }
		setHistoryBusy(true);
		try{
			if(!await createSafetySnapshot("Before restore " + relativePath)){ return; }
			let expectedRevision: string | undefined;
			try{
				expectedRevision = (await documentOpen(relativePath)).revision;
			}catch{
				// Missing document is the expected case when recovering a deleted file.
			}
			const restored = await historyRestoreFile(snapshot.id, relativePath, expectedRevision);
			assetCache.clear();
			await refreshExplorer();
			invalidateSearchIndex("History document restore");
			if(document()?.relativePath === relativePath){
				setDocument(restored);
				setDraft(contentForEditor(restored.content));
				setExternalConflict(false);
				setEditorSession(value => value + 1);
				void refreshBacklinks(restored.relativePath);
			}
			updateStatus("Historyから復元しました: " + relativePath, "info", "history");
		}catch(error){
			updateStatus("History restore error: " + String(error), "error", "history");
		}finally{
			setHistoryBusy(false);
		}
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
			invalidateSearchIndex("History restore");
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
		const generation = ++previewResolveGeneration;
		if(!relativePath){ return; }
		requestAnimationFrame(() => {
			void (async () => {
				await resolvePreviewEmbeds(relativePath, generation);
				await resolvePreviewAssets(relativePath, generation);
			})();
		});
	});

	createEffect(() => {
		if(!settingsReady()){ return; }
		explorerWidth();
		editorRatio();
		workspace()?.root;
		document()?.relativePath;
		autoSnapshotEnabled();
		autoSnapshotDelaySeconds();
		rightPaneMode();
		browserTargetUrl();
		scheduleSettingsSave();
	});

	createEffect(() => {
		const trackingReady = recoveryTrackingReady();
		const current = document();
		const currentDraft = draft();
		const isDirty = dirty();
		if(recoveryTimer !== undefined){ window.clearTimeout(recoveryTimer); }
		if(!trackingReady || !current || !workspace()){
			return;
		}
		if(!isDirty){
			recoveryTimer = window.setTimeout(() => {
				recoveryTimer = undefined;
				void recoveryClear().catch(error => updateStatus("Recovery clear error: " + String(error), "error", "recovery"));
			}, 250);
			return;
		}
		recoveryTimer = window.setTimeout(() => {
			recoveryTimer = undefined;
			void recoverySave(current.relativePath, current.revision, currentDraft)
				.catch(error => updateStatus("Recovery save error: " + String(error), "error", "recovery"));
		}, 500);
	});

	createEffect(() => {
		const query = searchQuery().trim();
		const indexReady = searchIndexReady();
		if(searchTimer !== undefined){ window.clearTimeout(searchTimer); }
		if(!query || !workspace()){
			setSearchResults([]);
			setSearching(false);
			return;
		}
		if(!indexReady){
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
		autoSnapshotEnabled: autoSnapshotEnabled(),
		autoSnapshotDelaySeconds: autoSnapshotDelaySeconds(),
		lastRightPane: rightPaneMode(),
		lastBrowserUrl: browserTargetUrl() ?? null,
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
				setAutoSnapshotEnabled(settings.autoSnapshotEnabled);
				setAutoSnapshotDelaySeconds(Math.max(1, Math.min(300, settings.autoSnapshotDelaySeconds)));
				setRightPaneMode(settings.lastRightPane === "browser" ? "browser" : "preview");
				if(settings.lastBrowserUrl && /^https?:\/\//i.test(settings.lastBrowserUrl)){
					setBrowserTargetUrl(settings.lastBrowserUrl);
				}
				if(settings.lastWorkspace){
					try{
						const opened = await workspaceOpen(settings.lastWorkspace);
						setWorkspace(opened.info);
						setEntries(opened.entries);
						setSearchIndexReady(false);
						void rebuildSearchIndex("session restore");
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
								try{
									const recovery = await recoveryLoad();
									if(recovery && recovery.relativePath === restored.relativePath && recovery.content !== contentForEditor(restored.content)){
										setRecoveryDraft(recovery);
									}
								}catch(error){
									updateStatus("Recovery load error: " + String(error), "error", "recovery");
								}
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
				setRecoveryTrackingReady(true);
				setSettingsReady(true);
			})
			.catch(error => {
				setRecoveryTrackingReady(true);
				setSettingsReady(true);
				updateStatus("Settings load error: " + String(error), "error", "settings");
			});

		commandKeyHandler = (event: KeyboardEvent) => {
			if(!event.ctrlKey || event.altKey){ return; }
			const key = event.key.toLowerCase();
			if(event.shiftKey && key === "p"){
				event.preventDefault();
				setCommandPaletteOpen(true);
				return;
			}
			if(event.shiftKey && key === "f"){
				event.preventDefault();
				explorerSearchInput?.focus();
				explorerSearchInput?.select();
				return;
			}
			if(!event.shiftKey && key === "o"){
				event.preventDefault();
				void chooseWorkspace();
				return;
			}
			if(!event.shiftKey && key === "n"){
				event.preventDefault();
				if(workspace()){ void createDocument(); }
				return;
			}
			if(!event.shiftKey && event.key === ","){
				event.preventDefault();
				setSettingsOpen(true);
			}
		};
		window.addEventListener("keydown", commandKeyHandler);

		void getCurrentWindow().onCloseRequested(event => {
			if(!dirty()){ return; }
			if(!window.confirm("未保存の変更があります。終了しますか？未保存bufferは次回起動時の復元候補として保持されます。")){
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
		if(commandKeyHandler){ window.removeEventListener("keydown", commandKeyHandler); }
		++watchGeneration;
		if(reconcileTimer !== undefined){ window.clearTimeout(reconcileTimer); }
		if(searchTimer !== undefined){ window.clearTimeout(searchTimer); }
		if(settingsTimer !== undefined){ window.clearTimeout(settingsTimer); }
		if(autoSnapshotTimer !== undefined){ window.clearTimeout(autoSnapshotTimer); }
		if(recoveryTimer !== undefined){ window.clearTimeout(recoveryTimer); }
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
		const discardCurrent = dirty();
		if(discardCurrent && !window.confirm("未保存の変更があります。破棄して別のWorkspaceを開きますか？")){ return; }
		const selected = await open({
			directory: true,
			multiple: false,
			title: "Quire Workspaceを開く",
		});
		if(typeof selected !== "string"){ return; }
		if(discardCurrent){
			try{ await recoveryClear(); }catch(error){ updateStatus("Recovery clear error: " + String(error), "error", "recovery"); }
		}
		setRecoveryTrackingReady(false);
		if(recoveryTimer !== undefined){ window.clearTimeout(recoveryTimer); recoveryTimer = undefined; }
		try{
			const opened = await workspaceOpen(selected);
			setWorkspace(opened.info);
			setEntries(opened.entries);
			setSearchIndexReady(false);
			void rebuildSearchIndex("workspace open");
			assetCache.clear();
			setExternalConflict(false);
			void startWorkspaceWatcher();
			setDocument(null);
			setDraft("");
			setRecoveryDraft(null);
			try{
				const recovery = await recoveryLoad();
				if(recovery){
					try{
						const recoveredDocument = await documentOpen(recovery.relativePath);
						setDocument(recoveredDocument);
						setDraft(contentForEditor(recoveredDocument.content));
						setInitialEditorLine(undefined);
						void refreshBacklinks(recoveredDocument.relativePath);
						if(recovery.content !== contentForEditor(recoveredDocument.content)){
							setRecoveryDraft(recovery);
						}else{
							await recoveryClear();
						}
					}catch(error){
						updateStatus("Recovery Document could not be opened: " + String(error), "warn", "recovery");
					}
				}
			}catch(error){
				updateStatus("Recovery load error: " + String(error), "error", "recovery");
			}
			updateStatus(opened.info.name + " を開きました", "info", "workspace");
		}catch(error){
			updateStatus("Workspace open error: " + String(error), "error", "workspace");
		}finally{
			setRecoveryTrackingReady(true);
		}
	};

	const loadDirectory = async (relativePath: string) => {
		return workspaceList(relativePath);
	};

	const reconcileExternalChanges = async () => {
		await refreshExplorer();
		invalidateSearchIndex("file watcher");
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
			invalidateSearchIndex("Document create");
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
			setDocument(moved.document);
			setDraft(contentForEditor(moved.document.content));
			setExternalConflict(false);
			void refreshBacklinks(moved.document.relativePath);
			invalidateSearchIndex("Document move");
			const linkMessage = moved.updatedLinks.length > 0 ? " / Link更新 " + moved.updatedLinks.length + "件" : "";
			updateStatus(current.relativePath + " → " + moved.document.relativePath + linkMessage, "info", "document");
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
			invalidateSearchIndex("Document delete");
			updateStatus(current.relativePath + " を削除しました", "info", "document");
		}catch(error){
			updateStatus("Document delete error: " + String(error), "error", "document");
		}
	};

	const openDocument = async (relativePath: string, line?: number, heading?: string) => {
		const current = document();
		if(current?.relativePath === relativePath && heading){
			const headingLine = findHeadingLine(draft(), heading);
			if(headingLine !== undefined){
				try{
					await editorGotoLine(headingLine);
					updateStatus(relativePath + "#" + decodeHeadingFragment(heading), "info", "links");
				}catch(error){
					updateStatus("Heading navigation error: " + String(error), "error", "links");
				}
			}else{
				updateStatus("見出しが見つかりません: #" + decodeHeadingFragment(heading), "warn", "links");
			}
			return;
		}
		if(dirty() && !window.confirm("未保存の変更があります。破棄して別の文書を開きますか？")){ return; }
		try{
			const opened = await documentOpen(relativePath);
			const content = contentForEditor(opened.content);
			const targetLine = line ?? (heading ? findHeadingLine(content, heading) : undefined);
			setDocument(opened);
			setDraft(content);
			setExternalConflict(false);
			setInitialEditorLine(targetLine);
			if(targetLine !== undefined || document()?.relativePath === relativePath){
				setEditorSession(value => value + 1);
			}
			void refreshBacklinks(relativePath);
			if(heading && targetLine === undefined){
				updateStatus(relativePath + " を開きましたが見出しが見つかりません: #" + decodeHeadingFragment(heading), "warn", "links");
			}else{
				updateStatus(relativePath, "info", "document");
			}
		}catch(error){
			updateStatus("Document open error: " + String(error), "error", "document");
		}
	};

	const openSearchHit = async (hit: SearchHit) => {
		await openDocument(hit.relativePath, hit.line);
	};

	const addImageAsset = async () => {
		const current = document();
		if(!current){ return; }
		const selected = await open({
			multiple: false,
			directory: false,
			title: "Markdownへ追加する画像を選択",
			filters: [{
				name: "Images",
				extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg", "ico"],
			}],
		});
		if(typeof selected !== "string"){ return; }
		try{
			const imported = await assetImport(current.relativePath, selected);
			await editorInsertText("![](" + imported.markdownSource + ")");
			assetCache.clear();
			await refreshExplorer();
			updateStatus("画像を追加しました: " + imported.relativePath, "info", "asset");
		}catch(error){
			updateStatus("Asset import error: " + String(error), "error", "asset");
		}
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
		const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[href]");
		if(!anchor){ return; }
		const href = anchor.getAttribute("href") ?? "";
		if(!href){ return; }
		const current = document();
		if(!current){ return; }
		const sourceDocument = anchor.dataset.quireSourceDocument || current.relativePath;

		if(href.startsWith("quire-wiki:")){
			event.preventDefault();
			const target = decodeURIComponent(href.slice("quire-wiki:".length));
			const heading = linkFragment(target);
			try{
				const resolved = await documentResolveWikiLink(sourceDocument, target);
				if(!resolved){
					updateStatus("未解決Wiki Link: [[" + target + "]]", "warn", "links");
					return;
				}
				await openDocument(resolved, undefined, heading);
			}catch(error){
				updateStatus("Wiki Link error: " + String(error), "error", "links");
			}
			return;
		}

		if(/^https?:\/\//i.test(href)){
			event.preventDefault();
			setBrowserTargetUrl(href);
			setRightPaneMode("browser");
			updateStatus("Browserへ開きました: " + href, "info", "browser");
			return;
		}

		if(href.startsWith("#")){
			event.preventDefault();
			await openDocument(sourceDocument, undefined, href.slice(1));
			return;
		}

		if(/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")){
			event.preventDefault();
			updateStatus("このlink schemeはまだ開けません: " + href, "warn", "links");
			return;
		}

		event.preventDefault();
		const heading = linkFragment(href);
		try{
			const resolved = await documentResolveMarkdownLink(sourceDocument, href);
			if(!resolved){
				updateStatus("Workspace内Markdownとして解決できません: " + href, "warn", "links");
				return;
			}
			await openDocument(resolved, undefined, heading);
		}catch(error){
			updateStatus("Markdown link error: " + String(error), "error", "links");
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
			setRecoveryDraft(null);
			void recoveryClear().catch(error => updateStatus("Recovery clear error: " + String(error), "error", "recovery"));
			invalidateSearchIndex("Document save");
			updateStatus(saved.relativePath + " を保存しました", "info", "save");
			scheduleAutoSnapshot(saved.relativePath);
		}catch(error){
			updateStatus("Save error: " + String(error), "error", "save");
		}finally{
			setSaving(false);
		}
	};

	const applyRecoveryDraft = async () => {
		const recovery = recoveryDraft();
		const current = document();
		if(!recovery || !current){ return; }
		try{
			await editorReplaceContent(recovery.content);
			setRecoveryDraft(null);
			updateStatus(
				recovery.baseRevision === current.revision
					? "前回の未保存bufferを復元しました。"
					: "前回の未保存bufferを復元しました。disk側も変更されているため、保存前に内容を確認してください。",
				recovery.baseRevision === current.revision ? "info" : "warn",
				"recovery",
			);
		}catch(error){
			updateStatus("Recovery apply error: " + String(error), "error", "recovery");
		}
	};

	const discardRecoveryDraft = async () => {
		try{
			await recoveryClear();
			setRecoveryDraft(null);
			updateStatus("前回の未保存bufferを破棄しました。", "info", "recovery");
		}catch(error){
			updateStatus("Recovery clear error: " + String(error), "error", "recovery");
		}
	};

	const commands = (): AppCommand[] => [
		{
			id: "workspace.open",
			title: "Workspaceを開く",
			keywords: "folder vault open",
			shortcut: "Ctrl+O",
			run: () => chooseWorkspace(),
		},
		{
			id: "document.create",
			title: "新規Markdown",
			keywords: "new document note",
			shortcut: "Ctrl+N",
			enabled: workspace() !== null,
			run: () => createDocument(),
		},
		{
			id: "document.image.add",
			title: "画像をDocumentへ追加",
			keywords: "asset image attachment insert",
			enabled: document() !== null,
			run: () => addImageAsset(),
		},
		{
			id: "document.save",
			title: "Documentを保存",
			keywords: "save write",
			shortcut: "Ctrl+S",
			enabled: document() !== null && dirty(),
			run: () => saveDocument(),
		},
		{
			id: "workspace.search.focus",
			title: "検索欄へ移動",
			keywords: "search find full text",
			shortcut: "Ctrl+Shift+F",
			enabled: workspace() !== null,
			run: () => {
				explorerSearchInput?.focus();
				explorerSearchInput?.select();
			},
		},
		{
			id: "workspace.snapshot",
			title: "Snapshotを作成",
			keywords: "history snapshot",
			enabled: workspace() !== null && !historyBusy(),
			run: () => createHistorySnapshot(),
		},
		{
			id: "history.show",
			title: "履歴を表示",
			keywords: "history restore",
			enabled: workspace() !== null,
			run: () => {
				setHistoryOpen(true);
				void refreshHistory();
			},
		},
		{
			id: "pane.preview",
			title: "Preview paneを表示",
			keywords: "markdown preview pane",
			run: () => setRightPaneMode("preview"),
		},
		{
			id: "pane.browser",
			title: "Browser paneを表示",
			keywords: "web browser pane",
			run: () => setRightPaneMode("browser"),
		},
		{
			id: "settings.show",
			title: "設定を開く",
			keywords: "settings preferences",
			shortcut: "Ctrl+,",
			run: () => setSettingsOpen(true),
		},
		{
			id: "logs.show",
			title: "ログを表示",
			keywords: "diagnostic log",
			run: () => {
				setLogOpen(true);
				void refreshLogs();
			},
		},
	];

	return (
		<div class="app">
			<header class="toolbar">
				<strong>Quire</strong>
				<button onClick={() => void chooseWorkspace()}>Workspaceを開く</button>
				<button title="設定" onClick={() => setSettingsOpen(true)}>設定</button>
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
								ref={explorerSearchInput}
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
								<Show
									when={searchIndexReady()}
									fallback={
										<div class="search-state">
											{searchIndexBuilding() ? "検索indexを構築中..." : "検索indexを利用できません"}
										</div>
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
								<button class="pane-action" title="画像を追加" onClick={() => void addImageAsset()}>画像</button>
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
									active={rightPaneMode() === "browser" && !historyOpen() && !commandPaletteOpen() && !settingsOpen() && !logOpen() && !recoveryDraft()}
									navigateTo={browserTargetUrl()}
									onUrlChange={url => setBrowserTargetUrl(url)}
									onStatus={message => updateStatus(message, message.toLowerCase().includes("error") ? "error" : "info", "browser")}
								/>
							</div>
						</div>
					</section>
				</div>
			</Show>

			<Show when={recoveryDraft()}>
				{recovery => (
					<div class="recovery-backdrop">
						<div class="recovery-dialog">
							<h2>未保存bufferを検出しました</h2>
							<p>{recovery().relativePath}</p>
							<Show when={document() && recovery().baseRevision !== document()!.revision}>
								<div class="recovery-warning">前回終了後にdisk側Documentが変更されています。復元しても自動保存はしません。</div>
							</Show>
							<div class="recovery-preview">{recovery().content.slice(0, 600)}{recovery().content.length > 600 ? "…" : ""}</div>
							<div class="recovery-actions">
								<button onClick={() => void discardRecoveryDraft()}>破棄</button>
								<button class="primary" onClick={() => void applyRecoveryDraft()}>bufferを復元</button>
							</div>
						</div>
					</div>
				)}
			</Show>

			<Show when={settingsOpen()}>
				<div class="settings-backdrop" onMouseDown={event => {
					if(event.target === event.currentTarget){ setSettingsOpen(false); }
				}}>
					<div class="settings-panel">
						<div class="settings-header">
							<strong>Settings</strong>
							<span class="toolbar-spacer" />
							<button onClick={() => setSettingsOpen(false)}>閉じる</button>
						</div>
						<div class="settings-content">
							<section class="settings-section">
								<h3>History</h3>
								<label class="settings-toggle">
									<input
										type="checkbox"
										checked={autoSnapshotEnabled()}
										onChange={event => setAutoSnapshotEnabled(event.currentTarget.checked)}
									/>
									<span>保存後にAuto Snapshotを作成</span>
								</label>
								<label class="settings-field">
									<span>待ち時間（秒）</span>
									<input
										type="number"
										min="1"
										max="300"
										value={autoSnapshotDelaySeconds()}
										disabled={!autoSnapshotEnabled()}
										onChange={event => {
											const value = Number.parseInt(event.currentTarget.value, 10);
											setAutoSnapshotDelaySeconds(Number.isFinite(value) ? Math.max(1, Math.min(300, value)) : 5);
										}}
									/>
								</label>
							</section>
							<section class="settings-section">
								<h3>Layout</h3>
								<div class="settings-summary">Explorer {Math.round(explorerWidth())}px / Editor {Math.round(editorRatio() * 100)}%</div>
								<button onClick={resetPaneLayout}>pane layoutを初期値へ戻す</button>
							</section>
						</div>
					</div>
				</div>
			</Show>

			<CommandPalette
				open={commandPaletteOpen()}
				commands={commands()}
				onClose={() => setCommandPaletteOpen(false)}
			/>

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
										<div class="history-entry-actions">
											<button onClick={() => void showHistoryDocuments(snapshot)}>文書</button>
											<button disabled={!document()} onClick={() => void compareHistorySnapshot(snapshot)}>比較</button>
											<button disabled={!document() || dirty()} onClick={() => void restoreCurrentDocument(snapshot)}>復元</button>
										</div>
									</div>
								)}
							</For>
							<Show when={snapshots().length === 0}>
								<div class="history-empty">Snapshotはありません。</div>
							</Show>
						</Show>
					</div>
					<Show when={historyDocuments()}>
						{view => (
							<div class="history-documents-panel">
								<div class="history-comparison-header">
									<strong>Snapshot Documents</strong>
									<span>{view().snapshot.message}</span>
									<span class="toolbar-spacer" />
									<button onClick={() => setHistoryDocuments(null)}>閉じる</button>
								</div>
								<div class="history-document-list">
									<For each={view().paths}>
										{path => (
											<div class="history-document-entry">
												<span title={path}>{path}</span>
												<button disabled={dirty() || historyBusy()} onClick={() => void restoreHistoryDocument(view().snapshot, path)}>復元</button>
											</div>
										)}
									</For>
									<Show when={view().paths.length === 0}>
										<div class="history-empty">Markdown Documentはありません。</div>
									</Show>
								</div>
							</div>
						)}
					</Show>
					<Show when={historyComparison()}>
						{comparison => (
							<div class="history-comparison">
								<div class="history-comparison-header">
									<strong>{document()?.relativePath}</strong>
									<span>{comparison().snapshot.message}</span>
									<span class="toolbar-spacer" />
									<button onClick={() => setHistoryComparison(null)}>比較を閉じる</button>
								</div>
								<div class="history-comparison-columns">
									<section>
										<h4>Snapshot</h4>
										<pre>{comparison().content ?? "このSnapshotにはDocumentが存在しません。"}</pre>
									</section>
									<section>
										<h4>Current</h4>
										<pre>{draft()}</pre>
									</section>
								</div>
							</div>
						)}
					</Show>
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
				<span>Milestone 3 / Vertical Slice</span>
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
