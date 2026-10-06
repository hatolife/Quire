import { invoke } from "@tauri-apps/api/core";

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

export type Document = {
	relativePath: string;
	content: string;
	revision: string;
};

export type DesktopSettings = {
	explorerWidth: number;
	editorRatio: number;
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

export function documentOpen(relativePath: string) {
	return invoke<Document>("document_open", { relativePath });
}

export function documentCreate(relativePath: string) {
	return invoke<Document>("document_create", { relativePath });
}

export function documentMove(fromRelativePath: string, toRelativePath: string, expectedRevision: string) {
	return invoke<Document>("document_move", { fromRelativePath, toRelativePath, expectedRevision });
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

export function assetRead(documentRelativePath: string, source: string) {
	return invoke<string>("asset_read", { documentRelativePath, source });
}
