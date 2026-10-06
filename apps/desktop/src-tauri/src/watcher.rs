use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::ipc::Channel;

#[derive(Default)]
pub struct WatcherState {
	watcher: Mutex<Option<RecommendedWatcher>>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WatchMessage {
	Changed { paths: Vec<String> },
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
					let _ = stream_for_callback.send(WatchMessage::Changed { paths });
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

fn relative_path(root: &Path, path: &Path) -> Option<String> {
	path.strip_prefix(root)
		.ok()
		.map(|relative| relative.to_string_lossy().replace('\\', "/"))
}
