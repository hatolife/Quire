import { Channel, invoke } from "@tauri-apps/api/core";

export type WorkspaceInfo = {
	root: string;
	name: string;
};

export type WorkspaceEntry = {
	name: string;
	relativePath: string;
	kind: "directory" | "markdown" | "file";
};

export type WorkspaceOpened = {
	info: WorkspaceInfo;
	entries: WorkspaceEntry[];
};

export type WorkspaceWatchMessage =
	| { kind: "changed"; paths: string[] }
	| { kind: "error"; message: string };

export type Document = {
	relativePath: string;
	content: string;
	revision: string;
};

export type DocumentMove = {
	document: Document;
	updatedLinks: string[];
};

export type SearchHit = {
	kind: "filename" | "content";
	relativePath: string;
	line?: number;
	preview: string;
};

export type Backlink = {
	sourcePath: string;
	line: number;
	preview: string;
};

export type AssetImport = {
	relativePath: string;
	markdownSource: string;
};

export type Snapshot = {
	id: string;
	timestamp: number;
	message: string;
};

export type DesktopSettings = {
	explorerWidth: number;
	editorRatio: number;
	lastWorkspace?: string | null;
	lastDocument?: string | null;
};

export type LogEntry = {
	id: number;
	timestampMs: number;
	level: string;
	source: string;
	message: string;
};

export function workspaceOpen(path: string) {
	return invoke<WorkspaceOpened>("workspace_open", { path });
}

export function workspaceList(relativePath: string) {
	return invoke<WorkspaceEntry[]>("workspace_list", { relativePath });
}

export function workspaceWatch(stream: Channel<WorkspaceWatchMessage>) {
	return invoke<void>("workspace_watch", { stream });
}

export function workspaceWatchStop() {
	return invoke<void>("workspace_watch_stop");
}

export function workspaceSearch(query: string, limit = 100) {
	return invoke<SearchHit[]>("workspace_search", { query, limit });
}

export function documentBacklinks(relativePath: string) {
	return invoke<Backlink[]>("document_backlinks", { relativePath });
}

export function documentResolveWikiLink(sourceRelativePath: string, target: string) {
	return invoke<string | null>("document_resolve_wiki_link", { sourceRelativePath, target });
}

export function documentOpen(relativePath: string) {
	return invoke<Document>("document_open", { relativePath });
}

export function documentCreate(relativePath: string) {
	return invoke<Document>("document_create", { relativePath });
}

export function documentMove(fromRelativePath: string, toRelativePath: string, expectedRevision: string) {
	return invoke<DocumentMove>("document_move", { fromRelativePath, toRelativePath, expectedRevision });
}

export function documentDelete(relativePath: string, expectedRevision: string) {
	return invoke<void>("document_delete", { relativePath, expectedRevision });
}

export function editorSave(expectedRevision: string) {
	return invoke<Document>("editor_save", { expectedRevision });
}

export function editorSetTopLine(line: number) {
	return invoke<void>("editor_set_top_line", { line });
}

export function editorInsertText(text: string) {
	return invoke<void>("editor_insert_text", { text });
}

export function settingsLoad() {
	return invoke<DesktopSettings>("settings_load");
}

export function settingsSave(settings: DesktopSettings) {
	return invoke<void>("settings_save", { settings });
}

export function logAppend(level: string, source: string, message: string) {
	return invoke<void>("log_append", { level, source, message });
}

export function logRecent() {
	return invoke<LogEntry[]>("log_recent");
}

export function logClear() {
	return invoke<void>("log_clear");
}

export function historyCreateSnapshot(message: string) {
	return invoke<Snapshot>("history_create_snapshot", { message });
}

export function historyList(limit = 100) {
	return invoke<Snapshot[]>("history_list", { limit });
}

export function historyReadFile(snapshotId: string, relativePath: string) {
	return invoke<string | null>("history_read_file", { snapshotId, relativePath });
}

export function historyRestoreFile(snapshotId: string, relativePath: string, expectedRevision?: string) {
	return invoke<Document>("history_restore_file", { snapshotId, relativePath, expectedRevision });
}

export function assetImport(documentRelativePath: string, sourcePath: string) {
	return invoke<AssetImport>("asset_import", { documentRelativePath, sourcePath });
}

export function assetRead(documentRelativePath: string, source: string) {
	return invoke<string>("asset_read", { documentRelativePath, source });
}
