use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use tempfile::NamedTempFile;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum WorkspaceError {
	#[error("Workspace path is not a directory: {0}")]
	NotDirectory(String),

	#[error("Path is outside the Workspace: {0}")]
	InvalidRelativePath(String),

	#[error("Document changed outside Quire: {0}")]
	Conflict(String),

	#[error(transparent)]
	Io(#[from] std::io::Error),
}

#[derive(Debug, Clone)]
pub struct Workspace {
	root: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
	pub root: String,
	pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
	Directory,
	Markdown,
	File,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
	pub name: String,
	pub relative_path: String,
	pub kind: EntryKind,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
	pub relative_path: String,
	pub content: String,
	pub revision: String,
}

impl Workspace {
	pub fn open(root: impl AsRef<Path>) -> Result<Self, WorkspaceError> {
		let requested = root.as_ref();
		if !requested.is_dir() {
			return Err(WorkspaceError::NotDirectory(requested.display().to_string()));
		}
		Ok(Self {
			root: fs::canonicalize(requested)?,
		})
	}

	pub fn info(&self) -> WorkspaceInfo {
		let name = self
			.root
			.file_name()
			.map(|name| name.to_string_lossy().into_owned())
			.unwrap_or_else(|| self.root.display().to_string());
		WorkspaceInfo {
			root: self.root.display().to_string(),
			name,
		}
	}

	pub fn list_directory(&self, relative_path: &str) -> Result<Vec<WorkspaceEntry>, WorkspaceError> {
		let directory = self.resolve_existing(relative_path)?;
		if !directory.is_dir() {
			return Err(WorkspaceError::NotDirectory(relative_path.to_string()));
		}

		let mut entries = Vec::new();
		for entry in fs::read_dir(directory)? {
			let entry = entry?;
			let name = entry.file_name().to_string_lossy().into_owned();
			if name == ".git" {
				continue;
			}
			let file_type = entry.file_type()?;
			let kind = if file_type.is_dir() {
				EntryKind::Directory
			}else if entry.path().extension().and_then(|extension| extension.to_str()).is_some_and(|extension| extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")) {
				EntryKind::Markdown
			}else{
				EntryKind::File
			};
			let relative = entry.path().strip_prefix(&self.root).map_err(|_| WorkspaceError::InvalidRelativePath(entry.path().display().to_string()))?;
			entries.push(WorkspaceEntry {
				name,
				relative_path: portable_path(relative),
				kind,
			});
		}

		entries.sort_by(|left, right| {
			let left_directory = left.kind == EntryKind::Directory;
			let right_directory = right.kind == EntryKind::Directory;
			right_directory
				.cmp(&left_directory)
				.then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
				.then_with(|| left.name.cmp(&right.name))
		});
		Ok(entries)
	}

	pub fn read_document(&self, relative_path: &str) -> Result<Document, WorkspaceError> {
		let path = self.resolve_existing(relative_path)?;
		let bytes = fs::read(&path)?;
		let content = String::from_utf8(bytes.clone()).map_err(|error| {
			WorkspaceError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, error))
		})?;
		Ok(Document {
			relative_path: portable_path(path.strip_prefix(&self.root).map_err(|_| WorkspaceError::InvalidRelativePath(relative_path.to_string()))?),
			content,
			revision: revision(&bytes),
		})
	}

	pub fn save_document(&self, relative_path: &str, content: &str, expected_revision: &str) -> Result<Document, WorkspaceError> {
		let path = self.resolve_existing(relative_path)?;
		if !path.is_file() {
			return Err(WorkspaceError::InvalidRelativePath(relative_path.to_string()));
		}

		let current = fs::read(&path)?;
		if revision(&current) != expected_revision {
			return Err(WorkspaceError::Conflict(relative_path.to_string()));
		}

		let parent = path.parent().ok_or_else(|| WorkspaceError::InvalidRelativePath(relative_path.to_string()))?;
		let mut temporary = NamedTempFile::new_in(parent)?;
		temporary.write_all(content.as_bytes())?;
		temporary.as_file().sync_all()?;
		temporary.persist(&path).map_err(|error| WorkspaceError::Io(error.error))?;

		self.read_document(relative_path)
	}

	fn resolve_existing(&self, relative_path: &str) -> Result<PathBuf, WorkspaceError> {
		let relative = Path::new(relative_path);
		if relative.is_absolute() || relative.components().any(|component| !matches!(component, Component::Normal(_) | Component::CurDir)) {
			return Err(WorkspaceError::InvalidRelativePath(relative_path.to_string()));
		}

		let path = fs::canonicalize(self.root.join(relative))?;
		if !path.starts_with(&self.root) {
			return Err(WorkspaceError::InvalidRelativePath(relative_path.to_string()));
		}
		Ok(path)
	}
}

fn revision(bytes: &[u8]) -> String {
	blake3::hash(bytes).to_hex().to_string()
}

fn portable_path(path: &Path) -> String {
	path.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::fs;

	#[test]
	fn workspace_lists_directories_before_files_and_hides_git() {
		let temp = tempfile::tempdir().unwrap();
		fs::create_dir(temp.path().join("z-dir")).unwrap();
		fs::create_dir(temp.path().join(".git")).unwrap();
		fs::write(temp.path().join("b.md"), "# B").unwrap();
		fs::write(temp.path().join("a.txt"), "A").unwrap();

		let workspace = Workspace::open(temp.path()).unwrap();
		let entries = workspace.list_directory("").unwrap();

		assert_eq!(entries.iter().map(|entry| entry.name.as_str()).collect::<Vec<_>>(), vec!["z-dir", "a.txt", "b.md"]);
		assert_eq!(entries[0].kind, EntryKind::Directory);
		assert_eq!(entries[2].kind, EntryKind::Markdown);
	}

	#[test]
	fn workspace_rejects_parent_traversal() {
		let temp = tempfile::tempdir().unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();

		assert!(matches!(
			workspace.list_directory("../"),
			Err(WorkspaceError::InvalidRelativePath(_))
		));
	}

	#[test]
	fn save_document_detects_external_change() {
		let temp = tempfile::tempdir().unwrap();
		let path = temp.path().join("note.md");
		fs::write(&path, "before").unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();
		let document = workspace.read_document("note.md").unwrap();

		fs::write(&path, "external").unwrap();

		assert!(matches!(
			workspace.save_document("note.md", "local", &document.revision),
			Err(WorkspaceError::Conflict(_))
		));
		assert_eq!(fs::read_to_string(path).unwrap(), "external");
	}

	#[test]
	fn save_document_replaces_matching_revision() {
		let temp = tempfile::tempdir().unwrap();
		let path = temp.path().join("note.md");
		fs::write(&path, "before").unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();
		let document = workspace.read_document("note.md").unwrap();

		let saved = workspace.save_document("note.md", "after", &document.revision).unwrap();

		assert_eq!(saved.content, "after");
		assert_ne!(saved.revision, document.revision);
		assert_eq!(fs::read_to_string(path).unwrap(), "after");
	}
}
