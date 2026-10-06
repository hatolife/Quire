import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import MarkdownIt from "markdown-it";
import { createMemo, createSignal, For, Show } from "solid-js";
import NeovimEditor from "./editor/NeovimEditor";

type WorkspaceInfo = {
	root: string;
	name: string;
};

type WorkspaceEntry = {
	name: string;
	relativePath: string;
	kind: "directory" | "markdown" | "file";
};

type WorkspaceOpened = {
	info: WorkspaceInfo;
	entries: WorkspaceEntry[];
};

type Document = {
	relativePath: string;
	content: string;
	revision: string;
};

const markdown = new MarkdownIt({
	html: false,
	linkify: true,
	typographer: false,
});

function renderPreview(source: string): string {
	const environment = {};
	const tokens = markdown.parse(source, environment);
	for(const token of tokens){
		if(token.map && token.nesting === 1){
			token.attrSet("data-source-line", String(token.map[0]));
		}
	}
	return markdown.renderer.render(tokens, markdown.options, environment);
}

function contentForEditor(content: string): string {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	return normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
}

function App() {
	let workspaceElement!: HTMLDivElement;
	let previewElement!: HTMLElement;
	let suppressEditorViewport = false;
	let suppressPreviewScroll = false;

	const [workspace, setWorkspace] = createSignal<WorkspaceInfo | null>(null);
	const [entries, setEntries] = createSignal<WorkspaceEntry[]>([]);
	const [document, setDocument] = createSignal<Document | null>(null);
	const [draft, setDraft] = createSignal("");
	const [status, setStatus] = createSignal("Workspaceを開いてください");
	const [saving, setSaving] = createSignal(false);
	const [explorerWidth, setExplorerWidth] = createSignal(260);
	const [editorRatio, setEditorRatio] = createSignal(0.5);
	const preview = createMemo(() => renderPreview(draft()));
	const dirty = createMemo(() => document() !== null && draft() !== contentForEditor(document()!.content));

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
		void invoke("editor_set_top_line", { line })
			.catch(error => setStatus("Editor viewport error: " + String(error)))
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
		};
		window.addEventListener("pointermove", handleMove);
		window.addEventListener("pointerup", handleUp, { once: true });
	};

	const chooseWorkspace = async () => {
		const selected = await open({
			directory: true,
			multiple: false,
			title: "Quire Workspaceを開く",
		});
		if(typeof selected !== "string"){ return; }
		try{
			const opened = await invoke<WorkspaceOpened>("workspace_open", { path: selected });
			setWorkspace(opened.info);
			setEntries(opened.entries);
			setDocument(null);
			setDraft("");
			setStatus(opened.info.name + " を開きました");
		}catch(error){
			setStatus("Workspace open error: " + String(error));
		}
	};

	const loadDirectory = async (relativePath: string) => {
		return invoke<WorkspaceEntry[]>("workspace_list", { relativePath });
	};

	const openDocument = async (relativePath: string) => {
		if(dirty() && !window.confirm("未保存の変更があります。破棄して別の文書を開きますか？")){ return; }
		try{
			const opened = await invoke<Document>("document_open", { relativePath });
			setDocument(opened);
			setDraft(contentForEditor(opened.content));
			setStatus(relativePath);
		}catch(error){
			setStatus("Document open error: " + String(error));
		}
	};

	const saveDocument = async () => {
		const current = document();
		if(!current || !dirty() || saving()){ return; }
		setSaving(true);
		try{
			const saved = await invoke<Document>("editor_save", {
				expectedRevision: current.revision,
			});
			setDocument(saved);
			setDraft(contentForEditor(saved.content));
			setStatus(saved.relativePath + " を保存しました");
		}catch(error){
			setStatus("Save error: " + String(error));
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
						<div class="pane-title">Explorer</div>
						<div class="tree">
							<For each={entries()}>
								{entry => <TreeEntry entry={entry} loadDirectory={loadDirectory} openDocument={openDocument} />}
							</For>
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
							<span>{document()?.relativePath ?? "Editor"}</span>
							<Show when={dirty()}><span class="dirty-mark">●</span></Show>
						</div>
						<Show
							when={document()?.relativePath}
							keyed
							fallback={<div class="empty-pane">左からMarkdownを選択してください。</div>}
						>
							{relativePath => (
								<NeovimEditor
									relativePath={relativePath}
									onTextChange={setDraft}
									onViewportLineChange={handleEditorViewportLine}
									onStatus={setStatus}
									onSave={() => void saveDocument()}
								/>
							)}
						</Show>
					</section>
					<div
						class="pane-splitter"
						role="separator"
						aria-orientation="vertical"
						onPointerDown={event => beginEditorPreviewResize(event as PointerEvent)}
					/>
					<section class="preview-pane">
						<div class="pane-title">Preview</div>
						<Show
							when={document()}
							fallback={<div class="empty-pane">Preview</div>}
						>
							<article
								ref={previewElement}
								class="markdown-preview"
								innerHTML={preview()}
								onScroll={handlePreviewScroll}
							/>
						</Show>
					</section>
				</div>
			</Show>

			<footer class="statusbar">
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
