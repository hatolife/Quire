mod editor;
mod logging;
mod settings;
mod watcher;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use quire_core::{Document, SearchHit, Workspace, WorkspaceEntry, WorkspaceInfo};
use serde::Serialize;
use std::path::Path;
use tauri::ipc::Channel;
use std::sync::Mutex;

struct AppState {
	workspace: Mutex<Option<Workspace>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceOpened {
	info: WorkspaceInfo,
	entries: Vec<WorkspaceEntry>,
}

#[tauri::command]
fn workspace_open(path: String, state: tauri::State<'_, AppState>) -> Result<WorkspaceOpened, String> {
	let workspace = Workspace::open(path).map_err(|error| error.to_string())?;
	let info = workspace.info();
	let entries = workspace.list_directory("").map_err(|error| error.to_string())?;
	let mut current = state.workspace.lock().map_err(|_| "Workspace state lock failed.".to_string())?;
	*current = Some(workspace);
	Ok(WorkspaceOpened { info, entries })
}

#[tauri::command]
fn workspace_list(relative_path: String, state: tauri::State<'_, AppState>) -> Result<Vec<WorkspaceEntry>, String> {
	with_workspace(&state, |workspace| workspace.list_directory(&relative_path).map_err(|error| error.to_string()))
}

#[tauri::command]
fn workspace_watch(
	stream: Channel<watcher::WatchMessage>,
	state: tauri::State<'_, AppState>,
	watcher_state: tauri::State<'_, watcher::WatcherState>,
) -> Result<(), String> {
	let root = with_workspace(&state, |workspace| Ok(std::path::PathBuf::from(workspace.info().root)))?;
	watcher_state.start(root, stream)
}

#[tauri::command]
fn workspace_watch_stop(watcher_state: tauri::State<'_, watcher::WatcherState>) -> Result<(), String> {
	watcher_state.stop()
}

#[tauri::command]
fn workspace_search(query: String, limit: usize, state: tauri::State<'_, AppState>) -> Result<Vec<SearchHit>, String> {
	with_workspace(&state, |workspace| workspace.search(&query, limit).map_err(|error| error.to_string()))
}

#[tauri::command]
fn document_open(relative_path: String, state: tauri::State<'_, AppState>) -> Result<Document, String> {
	with_workspace(&state, |workspace| workspace.read_document(&relative_path).map_err(|error| error.to_string()))
}

#[tauri::command]
fn document_save(relative_path: String, content: String, expected_revision: String, state: tauri::State<'_, AppState>) -> Result<Document, String> {
	with_workspace(&state, |workspace| workspace.save_document(&relative_path, &content, &expected_revision).map_err(|error| error.to_string()))
}

#[tauri::command]
fn document_create(relative_path: String, state: tauri::State<'_, AppState>) -> Result<Document, String> {
	with_workspace(&state, |workspace| {
		workspace.create_document(&relative_path, "").map_err(|error| error.to_string())
	})
}

#[tauri::command]
fn document_move(
	from_relative_path: String,
	to_relative_path: String,
	expected_revision: String,
	state: tauri::State<'_, AppState>,
	editor_state: tauri::State<'_, editor::EditorState>,
) -> Result<Document, String> {
	editor::stop(&editor_state)?;
	with_workspace(&state, |workspace| {
		workspace
			.move_document(&from_relative_path, &to_relative_path, Some(&expected_revision))
			.map_err(|error| error.to_string())
	})
}

#[tauri::command]
fn document_delete(
	relative_path: String,
	expected_revision: String,
	state: tauri::State<'_, AppState>,
	editor_state: tauri::State<'_, editor::EditorState>,
) -> Result<(), String> {
	editor::stop(&editor_state)?;
	with_workspace(&state, |workspace| {
		workspace
			.delete_document(&relative_path, Some(&expected_revision))
			.map_err(|error| error.to_string())
	})
}

#[tauri::command]
fn asset_read(
	document_relative_path: String,
	source: String,
	state: tauri::State<'_, AppState>,
) -> Result<String, String> {
	const MAX_PREVIEW_ASSET_BYTES: usize = 32 * 1024 * 1024;

	let bytes = with_workspace(&state, |workspace| {
		workspace.read_asset(&document_relative_path, &source).map_err(|error| error.to_string())
	})?;
	if bytes.len() > MAX_PREVIEW_ASSET_BYTES {
		return Err(format!("Preview asset is too large: {source}"));
	}
	let mime = asset_mime(&source).ok_or_else(|| format!("Unsupported preview asset type: {source}"))?;
	Ok(format!("data:{mime};base64,{}", BASE64.encode(bytes)))
}

fn asset_mime(source: &str) -> Option<&'static str> {
	match Path::new(source).extension()?.to_str()?.to_ascii_lowercase().as_str() {
		"png" => Some("image/png"),
		"jpg" | "jpeg" => Some("image/jpeg"),
		"gif" => Some("image/gif"),
		"webp" => Some("image/webp"),
		"bmp" => Some("image/bmp"),
		"avif" => Some("image/avif"),
		"svg" => Some("image/svg+xml"),
		"ico" => Some("image/x-icon"),
		_ => None,
	}
}

#[tauri::command]
fn editor_start_document(
	relative_path: String,
	stream: Channel<editor::StreamMessage>,
	state: tauri::State<'_, AppState>,
	editor_state: tauri::State<'_, editor::EditorState>,
) -> Result<(), String> {
	let path = with_workspace(&state, |workspace| {
		workspace.document_path(&relative_path).map_err(|error| error.to_string())
	})?;
	editor::start_document(path, relative_path, stream, &editor_state)
}

#[tauri::command]
fn editor_input(text: String, editor_state: tauri::State<'_, editor::EditorState>) -> Result<(), String> {
	editor::input(text, &editor_state)
}

#[tauri::command]
fn editor_resize(width: u64, height: u64, editor_state: tauri::State<'_, editor::EditorState>) -> Result<(), String> {
	editor::resize(width, height, &editor_state)
}

#[tauri::command]
fn editor_mouse(
	button: String,
	action: String,
	modifier: String,
	row: u64,
	col: u64,
	editor_state: tauri::State<'_, editor::EditorState>,
) -> Result<(), String> {
	editor::mouse(button, action, modifier, row, col, &editor_state)
}

#[tauri::command]
fn editor_save(
	expected_revision: String,
	state: tauri::State<'_, AppState>,
	editor_state: tauri::State<'_, editor::EditorState>,
) -> Result<Document, String> {
	let relative_path = editor::current_document(&editor_state)?;
	let before = with_workspace(&state, |workspace| {
		workspace.read_document(&relative_path).map_err(|error| error.to_string())
	})?;
	if before.revision != expected_revision {
		return Err(format!("Document changed outside Quire: {relative_path}"));
	}
	editor::write(&editor_state)?;
	with_workspace(&state, |workspace| {
		workspace.read_document(&relative_path).map_err(|error| error.to_string())
	})
}

#[tauri::command]
fn editor_get_top_line(editor_state: tauri::State<'_, editor::EditorState>) -> Result<u64, String> {
	editor::top_line(&editor_state)
}

#[tauri::command]
fn editor_set_top_line(line: u64, editor_state: tauri::State<'_, editor::EditorState>) -> Result<(), String> {
	editor::set_top_line(line, &editor_state)
}

#[tauri::command]
fn editor_goto_line(line: u64, editor_state: tauri::State<'_, editor::EditorState>) -> Result<(), String> {
	editor::goto_line(line, &editor_state)
}

#[tauri::command]
fn editor_stop(editor_state: tauri::State<'_, editor::EditorState>) -> Result<(), String> {
	editor::stop(&editor_state)
}

#[tauri::command]
fn settings_load(app: tauri::AppHandle) -> Result<settings::DesktopSettings, String> {
	settings::load(&app)
}

#[tauri::command]
fn settings_save(settings: settings::DesktopSettings, app: tauri::AppHandle) -> Result<(), String> {
	settings::save(&app, &settings)
}

#[tauri::command]
fn log_append(
	level: String,
	source: String,
	message: String,
	state: tauri::State<'_, logging::LogState>,
) -> Result<(), String> {
	state.push(level, source, message)
}

#[tauri::command]
fn log_recent(state: tauri::State<'_, logging::LogState>) -> Result<Vec<logging::LogEntry>, String> {
	state.recent()
}

#[tauri::command]
fn log_clear(state: tauri::State<'_, logging::LogState>) -> Result<(), String> {
	state.clear()
}

fn with_workspace<T>(state: &tauri::State<'_, AppState>, operation: impl FnOnce(&Workspace) -> Result<T, String>) -> Result<T, String> {
	let current = state.workspace.lock().map_err(|_| "Workspace state lock failed.".to_string())?;
	let workspace = current.as_ref().ok_or_else(|| "Workspace is not open.".to_string())?;
	operation(workspace)
}

fn main() {
	tauri::Builder::default()
		.plugin(tauri_plugin_dialog::init())
		.manage(AppState {
			workspace: Mutex::new(None),
		})
		.manage(editor::EditorState::default())
		.manage(logging::LogState::default())
		.manage(watcher::WatcherState::default())
		.invoke_handler(tauri::generate_handler![
			workspace_open,
			workspace_list,
			workspace_watch,
			workspace_watch_stop,
			workspace_search,
			document_open,
			document_save,
			document_create,
			document_move,
			document_delete,
			asset_read,
			editor_start_document,
			editor_input,
			editor_resize,
			editor_mouse,
			editor_save,
			editor_get_top_line,
			editor_set_top_line,
			editor_goto_line,
			editor_stop,
			settings_load,
			settings_save,
			log_append,
			log_recent,
			log_clear,
		])
		.run(tauri::generate_context!())
		.expect("failed to run Quire");
}
