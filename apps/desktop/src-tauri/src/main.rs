use quire_core::{Document, Workspace, WorkspaceEntry, WorkspaceInfo};
use serde::Serialize;
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
		.invoke_handler(tauri::generate_handler![
			workspace_open,
			workspace_list,
			document_open,
			document_save,
		])
		.run(tauri::generate_context!())
		.expect("failed to run Quire");
}
