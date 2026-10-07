use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tempfile::NamedTempFile;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryDraft {
	pub relative_path: String,
	pub base_revision: String,
	pub content: String,
}

pub fn load(path: &Path) -> Result<Option<RecoveryDraft>, String> {
	if !path.exists() {
		return Ok(None);
	}
	let content = fs::read_to_string(path)
		.map_err(|error| format!("Failed to read recovery draft {}: {error}", path.display()))?;
	let recovery = toml::from_str(&content)
		.map_err(|error| format!("Failed to parse recovery draft {}: {error}", path.display()))?;
	Ok(Some(recovery))
}

pub fn save(path: &Path, recovery: &RecoveryDraft) -> Result<(), String> {
	let parent = path.parent().ok_or_else(|| "Recovery path has no parent.".to_string())?;
	fs::create_dir_all(parent)
		.map_err(|error| format!("Failed to create recovery directory {}: {error}", parent.display()))?;
	let content = toml::to_string(recovery)
		.map_err(|error| format!("Failed to serialize recovery draft: {error}"))?;
	let mut temporary = NamedTempFile::new_in(parent)
		.map_err(|error| format!("Failed to create recovery temporary file: {error}"))?;
	temporary.write_all(content.as_bytes())
		.map_err(|error| format!("Failed to write recovery temporary file: {error}"))?;
	temporary.as_file().sync_all()
		.map_err(|error| format!("Failed to sync recovery temporary file: {error}"))?;
	temporary.persist(path)
		.map_err(|error| format!("Failed to replace recovery draft {}: {}", path.display(), error.error))?;
	Ok(())
}

pub fn clear(path: &Path) -> Result<(), String> {
	if !path.exists() {
		return Ok(());
	}
	fs::remove_file(path)
		.map_err(|error| format!("Failed to remove recovery draft {}: {error}", path.display()))
}

pub fn path(data_root: PathBuf, workspace_id: &str) -> PathBuf {
	data_root.join("workspaces").join(workspace_id).join("recovery.toml")
}
