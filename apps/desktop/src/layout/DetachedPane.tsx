import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import BrowserPane from "../browser/BrowserPane";
import GraphPane from "../graph/GraphPane";
import NeovimEditor from "../editor/NeovimEditor";
import { assetRead, workspaceList, type LinkGraph, type WorkspaceEntry } from "../ipc";

export type FloatingPaneKind = "explorer" | "editor" | "preview" | "graph" | "browser";
export type FloatingPaneState = {
	workspaceName: string | null;
	documentPath: string | null;
	previewHtml: string;
	graph: LinkGraph | null;
	entries: WorkspaceEntry[];
	browserUrl?: string;
};

function FloatingExplorerEntry(props: { entry: WorkspaceEntry; open: (path: string) => void }) {
	const [expanded, setExpanded] = createSignal(false);
	const [children, setChildren] = createSignal<WorkspaceEntry[]>([]);
	const activate = async () => {
		if(props.entry.kind !== "directory"){ props.open(props.entry.relativePath); return; }
		if(!expanded()){
			try{ setChildren(await workspaceList(props.entry.relativePath)); }
			catch(error){ console.error("Explorer list failed:", error); }
		}
		setExpanded(!expanded());
	};
	return (
		<div>
			<button class="tree-entry" title={props.entry.relativePath} onClick={() => void activate()}>
				<span class="tree-icon">{props.entry.kind === "directory" ? expanded() ? "▾" : "▸" : "◇"}</span>
				<span>{props.entry.name}{props.entry.kind === "directory" ? "/" : ""}</span>
			</button>
			<Show when={expanded()}><div class="tree-children">
				<For each={children()}>{entry => <FloatingExplorerEntry entry={entry} open={props.open} />}</For>
			</div></Show>
		</div>
	);
}

export default function DetachedPane() {
	const kind = new URLSearchParams(window.location.search).get("pane") as FloatingPaneKind;
	const windowLabel = getCurrentWindow().label;
	const [state, setState] = createSignal<FloatingPaneState | null>(null);
	const [message, setMessage] = createSignal("");
	let previewElement!: HTMLDivElement;
	let active = true;
	const unlisteners: Array<() => void> = [];
	const send = (event: string, payload: unknown) => {
		void emitTo("main", event, payload).catch(error => setMessage(String(error)));
	};
	const dock = () => { send("quire:pane-dock", { kind, label: windowLabel }); };
	createEffect(() => {
		const current = state();
		if(kind !== "preview" || !current?.documentPath){ return; }
		requestAnimationFrame(() => {
			if(!previewElement){ return; }
			for(const image of Array.from(previewElement.querySelectorAll<HTMLImageElement>("img[data-quire-asset]"))){
				const source = image.dataset.quireAsset;
				if(!source){ continue; }
				void assetRead(current.documentPath!, source).then(url => {
					if(image.isConnected){ image.src = url; image.removeAttribute("data-quire-asset"); }
				}).catch(error => { image.title = String(error); });
			}
		});
	});
	onMount(() => {
		void listen<FloatingPaneState>("quire:pane-state", event => {
			if(active){ setState(event.payload); }
		}, { target: { kind: "Any" } }).then(unlisten => {
			unlisteners.push(unlisten);
			if(active){ send("quire:pane-ready", { kind, label: windowLabel }); }
		}).catch(error => setMessage(String(error)));
	});
	onCleanup(() => {
		active = false;
		for(const unlisten of unlisteners){ unlisten(); }
	});
	return (
		<div class="floating-pane-app">
			<header class="floating-pane-toolbar">
				<strong>{kind === "explorer" ? "Explorer" : kind === "editor" ? "Editor" : kind === "preview" ? "Preview" : kind === "graph" ? "Graph" : "Browser"}</strong>
				<span class="toolbar-spacer" />
				<button onClick={() => void dock()}>メインへ戻す</button>
			</header>
			<Show when={kind === "explorer"}>
				<div class="floating-pane-content floating-explorer">
					<For each={state()?.entries ?? []}>
						{entry => <FloatingExplorerEntry entry={entry} open={path => send("quire:pane-open-document", path)} />}
					</For>
				</div>
			</Show>
			<Show when={kind === "editor"}>
				<div class="floating-pane-content floating-editor">
					<Show when={state()?.documentPath} keyed fallback={<div class="empty-pane">Documentを開いてください。</div>}>
						{path => <NeovimEditor
							relativePath={path}
							onTextChange={content => send("quire:pane-editor-change", { path, content })}
							onViewportLineChange={line => send("quire:pane-editor-scroll", line)}
							onStatus={setMessage}
							onSave={() => send("quire:pane-editor-save", path)}
						/>}
					</Show>
				</div>
			</Show>
			<Show when={kind === "preview"}>
				<div class="floating-pane-content floating-preview">
					<Show when={state()?.documentPath} fallback={<div class="empty-pane">Documentを開いてください。</div>}>
						<div class="preview-scroll" ref={previewElement}>
							<article class="markdown-preview" innerHTML={state()?.previewHtml ?? ""} />
						</div>
					</Show>
				</div>
			</Show>
			<Show when={kind === "graph"}>
				<div class="floating-pane-content">
					<GraphPane graph={state()?.graph ?? null} currentPath={state()?.documentPath ?? undefined} onOpen={path => send("quire:pane-open-document", path)} />
				</div>
			</Show>
			<Show when={kind === "browser"}>
				<div class="floating-pane-content">
					<BrowserPane active={true} navigateTo={state()?.browserUrl} onUrlChange={url => send("quire:pane-browser-url", url)} onStatus={setMessage} />
				</div>
			</Show>
			<Show when={message()}><div class="floating-pane-message">{message()}</div></Show>
		</div>
	);
}
