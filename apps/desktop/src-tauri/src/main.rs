mod editor;
mod logging;
mod recovery;
mod settings;
mod watcher;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use quire_core::{AssetImport, Backlink, Document, DocumentMove, HistoryStore, LinkIndex, SearchHit, SearchIndex, Snapshot, TagInfo, Workspace, WorkspaceEntry, WorkspaceInfo};
use serde::Serialize;
use std::path::Path;
use tauri::ipc::Channel;
use tauri::Manager;
use std::sync::{
	atomic::{AtomicU64, Ordering},
	Mutex,
};

struct AppState {
	workspace: Mutex<Option<Workspace>>,
	search_index: Mutex<Option<SearchIndex>>,
	link_index: Mutex<Option<LinkIndex>>,
	search_generation: AtomicU64,
	history_lock: Mutex<()>,
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

	state.search_generation.fetch_add(1, Ordering::SeqCst);
	{
		let mut index = state.search_index.lock().map_err(|_| "Search index state lock failed.".to_string())?;
		*index = None;
	}
	{
		let mut index = state.link_index.lock().map_err(|_| "Link index state lock failed.".to_string())?;
		*index = None;
	}
	{
		let mut current = state.workspace.lock().map_err(|_| "Workspace state lock failed.".to_string())?;
		*current = Some(workspace);
	}
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
	let index = state.search_index.lock().map_err(|_| "Search index state lock failed.".to_string())?;
	let index = index.as_ref().ok_or_else(|| "Workspace search index is not ready.".to_string())?;
	Ok(index.search(&query, limit))
}

#[tauri::command]
fn workspace_tags(state: tauri::State<'_, AppState>) -> Result<Vec<TagInfo>, String> {
	let index = state.search_index.lock().map_err(|_| "Search index state lock failed.".to_string())?;
	Ok(index.as_ref().map(SearchIndex::tags).unwrap_or_default())
}

#[tauri::command]
fn workspace_documents(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
	let index = state.search_index.lock().map_err(|_| "Search index state lock failed.".to_string())?;
	Ok(index.as_ref().map(SearchIndex::documents).unwrap_or_default())
}

#[tauri::command]
async fn workspace_reindex(app: tauri::AppHandle) -> Result<Option<usize>, String> {
	let (generation, root) = {
		let state = app.state::<AppState>();
		let generation = state.search_generation.load(Ordering::SeqCst);
		let root = with_workspace(&state, |workspace| Ok(std::path::PathBuf::from(workspace.info().root)))?;
		(generation, root)
	};

	let rebuilt = tauri::async_runtime::spawn_blocking(move || -> Result<(SearchIndex, LinkIndex, usize), String> {
		let workspace = Workspace::open(root).map_err(|error| error.to_string())?;
		let rebuilt_search = workspace.build_search_index().map_err(|error| error.to_string())?;
		let rebuilt_links = workspace.build_link_index().map_err(|error| error.to_string())?;
		let count = rebuilt_search.document_count();
		Ok((rebuilt_search, rebuilt_links, count))
	})
	.await
	.map_err(|error| format!("Workspace index worker failed: {error}"))??;

	let (rebuilt_search, rebuilt_links, count) = rebuilt;
	let state = app.state::<AppState>();
	if state.search_generation.load(Ordering::SeqCst) != generation {
		return Ok(None);
	}

	let mut search_index = state.search_index.lock().map_err(|_| "Search index state lock failed.".to_string())?;
	let mut link_index = state.link_index.lock().map_err(|_| "Link index state lock failed.".to_string())?;
	if state.search_generation.load(Ordering::SeqCst) != generation {
		return Ok(None);
	}
	*search_index = Some(rebuilt_search);
	*link_index = Some(rebuilt_links);
	Ok(Some(count))
}

#[tauri::command]
fn workspace_refresh_document_index(
	relative_path: String,
	state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
	let mut search_index = state.search_index.lock().map_err(|_| "Search index state lock failed.".to_string())?;
	let mut link_index = state.link_index.lock().map_err(|_| "Link index state lock failed.".to_string())?;
	let (Some(search_index), Some(link_index)) = (search_index.as_mut(), link_index.as_mut()) else {
		return Ok(false);
	};
	with_workspace(&state, |workspace| {
		search_index.refresh_document(workspace, &relative_path).map_err(|error| error.to_string())?;
		link_index.refresh_document(workspace, &relative_path).map_err(|error| error.to_string())?;
		Ok(())
	})?;
	Ok(true)
}

#[tauri::command]
fn document_backlinks(relative_path: String, state: tauri::State<'_, AppState>) -> Result<Vec<Backlink>, String> {
	let index = state.link_index.lock().map_err(|_| "Link index state lock failed.".to_string())?;
	Ok(index.as_ref().map(|index| index.backlinks(&relative_path)).unwrap_or_default())
}

#[tauri::command]
fn document_resolve_markdown_link(
	source_relative_path: String,
	target: String,
	state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
	with_workspace(&state, |workspace| {
		workspace.resolve_markdown_target(&source_relative_path, &target).map_err(|error| error.to_string())
	})
}

#[tauri::command]
fn document_resolve_wiki_link(
	source_relative_path: String,
	target: String,
	state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
	let normalized = target
		.split('#')
		.next()
		.unwrap_or("")
		.trim()
		.replace('\\', "/");
	if !normalized.is_empty() && !normalized.contains('/') && !normalized.starts_with('.') {
		let index = state.link_index.lock().map_err(|_| "Link index state lock failed.".to_string())?;
		if let Some(index) = index.as_ref() {
			return Ok(index.resolve_bare_wiki_target(&target));
		}
	}
	with_workspace(&state, |workspace| {
		workspace.resolve_wiki_target(&source_relative_path, &target).map_err(|error| error.to_string())
	})
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
) -> Result<DocumentMove, String> {
	editor::stop(&editor_state)?;
	with_workspace(&state, |workspace| {
		workspace
			.move_document_with_wiki_links(&from_relative_path, &to_relative_path, &expected_revision)
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
fn asset_import(
	document_relative_path: String,
	source_path: String,
	state: tauri::State<'_, AppState>,
) -> Result<AssetImport, String> {
	with_workspace(&state, |workspace| {
		workspace
			.import_asset(&document_relative_path, source_path)
			.map_err(|error| error.to_string())
	})
}

fn browser_webview(app: &tauri::AppHandle) -> Result<tauri::Webview, String> {
	app.get_webview("browser-pane")
		.ok_or_else(|| "Browser pane is not created.".to_string())
}

fn validated_browser_url(value: &str) -> Result<tauri::Url, String> {
	let url = tauri::Url::parse(value).map_err(|error| format!("Invalid Browser URL: {error}"))?;
	if !matches!(url.scheme(), "http" | "https") {
		return Err(format!("Unsupported Browser URL scheme: {}", url.scheme()));
	}
	Ok(url)
}

#[tauri::command]
fn browser_navigate(url: String, app: tauri::AppHandle) -> Result<(), String> {
	let url = validated_browser_url(&url)?;
	browser_webview(&app)?
		.navigate(url)
		.map_err(|error| format!("Browser navigation failed: {error}"))
}

#[tauri::command]
fn browser_reload(app: tauri::AppHandle) -> Result<(), String> {
	browser_webview(&app)?
		.reload()
		.map_err(|error| format!("Browser reload failed: {error}"))
}

#[tauri::command]
fn browser_back(app: tauri::AppHandle) -> Result<(), String> {
	browser_webview(&app)?
		.eval("history.back()")
		.map_err(|error| format!("Browser back failed: {error}"))
}

#[tauri::command]
fn browser_forward(app: tauri::AppHandle) -> Result<(), String> {
	browser_webview(&app)?
		.eval("history.forward()")
		.map_err(|error| format!("Browser forward failed: {error}"))
}

#[tauri::command]
fn browser_current_url(app: tauri::AppHandle) -> Result<String, String> {
	browser_webview(&app)?
		.url()
		.map(|url| url.to_string())
		.map_err(|error| format!("Browser URL read failed: {error}"))
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
fn editor_toggle_task(line: u64, checked: bool, editor_state: tauri::State<'_, editor::EditorState>) -> Result<(), String> {
	editor::toggle_task(line, checked, &editor_state)
}

#[tauri::command]
fn editor_insert_text(text: String, editor_state: tauri::State<'_, editor::EditorState>) -> Result<(), String> {
	editor::insert_text(text, &editor_state)
}

#[tauri::command]
fn editor_replace_content(content: String, editor_state: tauri::State<'_, editor::EditorState>) -> Result<(), String> {
	editor::replace_content(content, &editor_state)
}

#[tauri::command]
fn editor_stop(editor_state: tauri::State<'_, editor::EditorState>) -> Result<(), String> {
	editor::stop(&editor_state)
}

#[tauri::command]
fn recovery_load(
	app: tauri::AppHandle,
	state: tauri::State<'_, AppState>,
) -> Result<Option<recovery::RecoveryDraft>, String> {
	let path = recovery_path(&app, &state)?;
	recovery::load(&path)
}

#[tauri::command]
fn recovery_save(
	relative_path: String,
	base_revision: String,
	content: String,
	app: tauri::AppHandle,
	state: tauri::State<'_, AppState>,
) -> Result<(), String> {
	let path = recovery_path(&app, &state)?;
	recovery::save(&path, &recovery::RecoveryDraft {
		relative_path,
		base_revision,
		content,
	})
}

#[tauri::command]
fn recovery_clear(
	app: tauri::AppHandle,
	state: tauri::State<'_, AppState>,
) -> Result<(), String> {
	let path = recovery_path(&app, &state)?;
	recovery::clear(&path)
}

fn recovery_path(app: &tauri::AppHandle, state: &tauri::State<'_, AppState>) -> Result<std::path::PathBuf, String> {
	let workspace_id = with_workspace(state, |workspace| Ok(workspace.local_id()))?;
	let data = app
		.path()
		.app_local_data_dir()
		.map_err(|error| format!("Failed to resolve Quire app data directory: {error}"))?;
	Ok(recovery::path(data, &workspace_id))
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

#[tauri::command]
fn history_create_snapshot(
	message: String,
	retention_limit: usize,
	app: tauri::AppHandle,
	state: tauri::State<'_, AppState>,
) -> Result<Snapshot, String> {
	let _guard = state.history_lock.lock().map_err(|_| "History lock failed.".to_string())?;
	let store = history_store(&app, &state)?;
	let created = store.create_snapshot(&message).map_err(|error| error.to_string())?;
	let keep = retention_limit.max(1);
	let threshold = keep.saturating_add((keep / 5).max(20));
	if store.snapshot_count().map_err(|error| error.to_string())? > threshold {
		store.prune_snapshots(keep).map_err(|error| error.to_string())?;
		store.latest_snapshot().map_err(|error| error.to_string())
	}else{
		Ok(created)
	}
}

#[tauri::command]
fn history_prune(
	keep: usize,
	app: tauri::AppHandle,
	state: tauri::State<'_, AppState>,
) -> Result<usize, String> {
	let _guard = state.history_lock.lock().map_err(|_| "History lock failed.".to_string())?;
	let store = history_store(&app, &state)?;
	store.prune_snapshots(keep.max(1)).map_err(|error| error.to_string())
}

#[tauri::command]
fn history_list(
	limit: usize,
	app: tauri::AppHandle,
	state: tauri::State<'_, AppState>,
) -> Result<Vec<Snapshot>, String> {
	let _guard = state.history_lock.lock().map_err(|_| "History lock failed.".to_string())?;
	let store = history_store(&app, &state)?;
	store.list_snapshots(limit).map_err(|error| error.to_string())
}

#[tauri::command]
fn history_list_documents(
	snapshot_id: String,
	app: tauri::AppHandle,
	state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
	let _guard = state.history_lock.lock().map_err(|_| "History lock failed.".to_string())?;
	let store = history_store(&app, &state)?;
	store.list_documents(&snapshot_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn history_read_file(
	snapshot_id: String,
	relative_path: String,
	app: tauri::AppHandle,
	state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
	let _guard = state.history_lock.lock().map_err(|_| "History lock failed.".to_string())?;
	let store = history_store(&app, &state)?;
	store.read_file_text(&snapshot_id, &relative_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn history_restore_file(
	snapshot_id: String,
	relative_path: String,
	expected_revision: Option<String>,
	app: tauri::AppHandle,
	state: tauri::State<'_, AppState>,
	editor_state: tauri::State<'_, editor::EditorState>,
) -> Result<Document, String> {
	let current_editor_document = editor::current_document(&editor_state).ok();
	if current_editor_document.as_deref() == Some(relative_path.as_str()) {
		editor::stop(&editor_state)?;
	}
	let _guard = state.history_lock.lock().map_err(|_| "History lock failed.".to_string())?;
	let store = history_store(&app, &state)?;
	store
		.restore_file(&snapshot_id, &relative_path, expected_revision.as_deref())
		.map_err(|error| error.to_string())?;
	with_workspace(&state, |workspace| workspace.read_document(&relative_path).map_err(|error| error.to_string()))
}

fn history_store(app: &tauri::AppHandle, state: &tauri::State<'_, AppState>) -> Result<HistoryStore, String> {
	let (root, workspace_id) = with_workspace(state, |workspace| {
		Ok((std::path::PathBuf::from(workspace.info().root), workspace.local_id()))
	})?;
	let data = app
		.path()
		.app_local_data_dir()
		.map_err(|error| format!("Failed to resolve Quire app data directory: {error}"))?;
	let git_dir = data.join("workspaces").join(workspace_id).join("history.git");
	HistoryStore::open(root, git_dir).map_err(|error| error.to_string())
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
			search_index: Mutex::new(None),
			link_index: Mutex::new(None),
			search_generation: AtomicU64::new(0),
			history_lock: Mutex::new(()),
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
			workspace_tags,
			workspace_documents,
			workspace_reindex,
			workspace_refresh_document_index,
			document_backlinks,
			document_resolve_markdown_link,
			document_resolve_wiki_link,
			document_open,
			document_save,
			document_create,
			document_move,
			document_delete,
			asset_import,
			asset_read,
			browser_navigate,
			browser_reload,
			browser_back,
			browser_forward,
			browser_current_url,
			editor_start_document,
			editor_input,
			editor_resize,
			editor_mouse,
			editor_save,
			editor_get_top_line,
			editor_set_top_line,
			editor_goto_line,
			editor_toggle_task,
			editor_insert_text,
			editor_replace_content,
			editor_stop,
			recovery_load,
			recovery_save,
			recovery_clear,
			settings_load,
			settings_save,
			log_append,
			log_recent,
			log_clear,
			history_create_snapshot,
			history_prune,
			history_list,
			history_list_documents,
			history_read_file,
			history_restore_file,
		])
		.run(tauri::generate_context!())
		.expect("failed to run Quire");
}
