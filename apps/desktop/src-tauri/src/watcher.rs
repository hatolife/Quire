use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::ipc::Channel;

#[derive(Default)]
pub struct WatcherState {
	watcher: Mutex<Option<RecommendedWatcher>>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WatchChangeKind {
	Create,
	Modify,
	Remove,
	Other,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WatchMessage {
	Changed { change: WatchChangeKind, paths: Vec<String> },
	Error { message: String },
}

impl WatcherState {
	pub fn start(&self, root: PathBuf, stream: Channel<WatchMessage>) -> Result<(), String> {
		let root_for_callback = root.clone();
		let stream_for_callback = stream.clone();
		let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
			match result {
				Ok(event) => {
					let paths = event
						.paths
						.iter()
						.filter_map(|path| relative_path(&root_for_callback, path))
						.collect::<Vec<_>>();
					if !paths.is_empty() {
						let _ = stream_for_callback.send(WatchMessage::Changed {
							change: classify_change(&event.kind),
							paths,
						});
					}
				}
				Err(error) => {
					let _ = stream_for_callback.send(WatchMessage::Error {
						message: error.to_string(),
					});
				}
			}
		})
		.map_err(|error| format!("Failed to create Workspace watcher: {error}"))?;

		watcher
			.watch(&root, RecursiveMode::Recursive)
			.map_err(|error| format!("Failed to watch {}: {error}", root.display()))?;

		let mut slot = self.watcher.lock().map_err(|_| "Watcher state lock failed.".to_string())?;
		*slot = Some(watcher);
		Ok(())
	}

	pub fn stop(&self) -> Result<(), String> {
		let mut slot = self.watcher.lock().map_err(|_| "Watcher state lock failed.".to_string())?;
		*slot = None;
		Ok(())
	}
}

fn classify_change(kind: &EventKind) -> WatchChangeKind {
	match kind {
		EventKind::Create(_) => WatchChangeKind::Create,
		EventKind::Modify(_) => WatchChangeKind::Modify,
		EventKind::Remove(_) => WatchChangeKind::Remove,
		_ => WatchChangeKind::Other,
	}
}

fn relative_path(root: &Path, path: &Path) -> Option<String> {
	let relative = path.strip_prefix(root).ok()?;
	if relative.components().next().is_some_and(|component| component.as_os_str() == ".git") {
		return None;
	}
	Some(relative.to_string_lossy().replace('\\', "/"))
}
