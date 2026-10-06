mod editor;
mod settings;

use quire_core::{Document, Workspace, WorkspaceEntry, WorkspaceInfo};
use serde::Serialize;
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
fn document_open(relative_path: String, state: tauri::State<'_, AppState>) -> Result<Document, String> {
	with_workspace(&state, |workspace| workspace.read_document(&relative_path).map_err(|error| error.to_string()))
}

#[tauri::command]
fn document_save(relative_path: String, content: String, expected_revision: String, state: tauri::State<'_, AppState>) -> Result<Document, String> {
	with_workspace(&state, |workspace| workspace.save_document(&relative_path, &content, &expected_revision).map_err(|error| error.to_string()))
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
		.invoke_handler(tauri::generate_handler![
			workspace_open,
			workspace_list,
			document_open,
			document_save,
			editor_start_document,
			editor_input,
			editor_resize,
			editor_mouse,
			editor_save,
			editor_get_top_line,
			editor_set_top_line,
			editor_stop,
			settings_load,
			settings_save,
		])
		.run(tauri::generate_context!())
		.expect("failed to run Quire");
}
