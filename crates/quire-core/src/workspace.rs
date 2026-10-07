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
	pub(crate) root: PathBuf,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetImport {
	pub relative_path: String,
	pub markdown_source: String,
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

	pub fn local_id(&self) -> String {
		blake3::hash(self.root.to_string_lossy().as_bytes()).to_hex()[..32].to_string()
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
			let path = entry.path();
			let name = entry.file_name().to_string_lossy().into_owned();
			if name == ".git" {
				continue;
			}
			let file_type = entry.file_type()?;
			let kind = if file_type.is_dir() {
				EntryKind::Directory
			}else if path.extension().and_then(|extension| extension.to_str()).is_some_and(|extension| extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")) {
				EntryKind::Markdown
			}else{
				EntryKind::File
			};
			let relative = path.strip_prefix(&self.root).map_err(|_| WorkspaceError::InvalidRelativePath(path.display().to_string()))?;
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

	pub fn ensure_directory(&self, relative_directory: &str) -> Result<String, WorkspaceError> {
		let relative = Path::new(relative_directory);
		if relative.as_os_str().is_empty() {
			return Ok(String::new());
		}
		if relative.is_absolute()
			|| relative.components().any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
			|| relative.components().any(|component| matches!(component, Component::Normal(name) if name == ".git"))
		{
			return Err(WorkspaceError::InvalidRelativePath(relative_directory.to_string()));
		}
		let target = self.root.join(relative);
		fs::create_dir_all(&target)?;
		let canonical = fs::canonicalize(&target)?;
		if !canonical.starts_with(&self.root) || !canonical.is_dir() {
			return Err(WorkspaceError::InvalidRelativePath(relative_directory.to_string()));
		}
		let relative = canonical
			.strip_prefix(&self.root)
			.map_err(|_| WorkspaceError::InvalidRelativePath(relative_directory.to_string()))?;
		Ok(portable_path(relative))
	}

	pub fn markdown_documents_under(&self, relative_directory: &str) -> Result<Vec<String>, WorkspaceError> {
		let directory = match self.resolve_existing(relative_directory) {
			Ok(directory) => directory,
			Err(WorkspaceError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
			Err(error) => return Err(error),
		};
		if !directory.is_dir() {
			return Ok(Vec::new());
		}

		fn collect(root: &Path, directory: &Path, output: &mut Vec<String>) -> Result<(), WorkspaceError> {
			for entry in fs::read_dir(directory)? {
				let entry = entry?;
				if entry.file_name() == ".git" {
					continue;
				}
				let file_type = entry.file_type()?;
				if file_type.is_symlink() {
					continue;
				}
				let path = entry.path();
				if file_type.is_dir() {
					collect(root, &path, output)?;
					continue;
				}
				if !file_type.is_file() {
					continue;
				}
				let markdown = path.extension()
					.and_then(|extension| extension.to_str())
					.is_some_and(|extension| extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown"));
				if !markdown {
					continue;
				}
				let relative = path
					.strip_prefix(root)
					.map_err(|_| WorkspaceError::InvalidRelativePath(path.display().to_string()))?;
				output.push(portable_path(relative));
			}
			Ok(())
		}

		let mut documents = Vec::new();
		collect(&self.root, &directory, &mut documents)?;
		documents.sort_by(|left, right| left.to_lowercase().cmp(&right.to_lowercase()).then_with(|| left.cmp(right)));
		Ok(documents)
	}

	pub fn document_exists(&self, relative_path: &str) -> Result<bool, WorkspaceError> {
		let relative = Path::new(relative_path);
		if relative.as_os_str().is_empty()
			|| relative.is_absolute()
			|| relative.components().any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
		{
			return Err(WorkspaceError::InvalidRelativePath(relative_path.to_string()));
		}
		let candidate = self.root.join(relative);
		if !candidate.exists() {
			return Ok(false);
		}
		let canonical = fs::canonicalize(candidate)?;
		if !canonical.starts_with(&self.root) {
			return Err(WorkspaceError::InvalidRelativePath(relative_path.to_string()));
		}
		Ok(canonical.is_file())
	}

	pub fn document_path(&self, relative_path: &str) -> Result<PathBuf, WorkspaceError> {
		let path = self.resolve_existing(relative_path)?;
		if !path.is_file() {
			return Err(WorkspaceError::InvalidRelativePath(relative_path.to_string()));
		}
		Ok(path)
	}

	pub fn read_asset(&self, document_relative_path: &str, asset_relative_path: &str) -> Result<Vec<u8>, WorkspaceError> {
		let document = self.document_path(document_relative_path)?;
		let parent = document
			.parent()
			.ok_or_else(|| WorkspaceError::InvalidRelativePath(document_relative_path.to_string()))?;
		let asset = Path::new(asset_relative_path);
		if asset.is_absolute() {
			return Err(WorkspaceError::InvalidRelativePath(asset_relative_path.to_string()));
		}

		let path = fs::canonicalize(parent.join(asset))?;
		if !path.starts_with(&self.root) || !path.is_file() {
			return Err(WorkspaceError::InvalidRelativePath(asset_relative_path.to_string()));
		}
		Ok(fs::read(path)?)
	}

	pub fn read_document(&self, relative_path: &str) -> Result<Document, WorkspaceError> {
		let path = self.document_path(relative_path)?;
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
		let path = self.document_path(relative_path)?;

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

	pub fn create_document(&self, relative_path: &str, content: &str) -> Result<Document, WorkspaceError> {
		let path = self.resolve_new_file(relative_path)?;
		let mut file = fs::OpenOptions::new()
			.write(true)
			.create_new(true)
			.open(&path)?;
		if let Err(error) = file.write_all(content.as_bytes()).and_then(|_| file.sync_all()) {
			drop(file);
			let _ = fs::remove_file(&path);
			return Err(WorkspaceError::Io(error));
		}
		drop(file);
		self.read_document(relative_path)
	}

	pub fn move_document(
		&self,
		from_relative_path: &str,
		to_relative_path: &str,
		expected_revision: Option<&str>,
	) -> Result<Document, WorkspaceError> {
		let source = self.document_path(from_relative_path)?;
		if let Some(expected_revision) = expected_revision {
			let current = fs::read(&source)?;
			if revision(&current) != expected_revision {
				return Err(WorkspaceError::Conflict(from_relative_path.to_string()));
			}
		}
		let target = self.resolve_new_file(to_relative_path)?;
		fs::rename(source, target)?;
		self.read_document(to_relative_path)
	}

	pub fn delete_document(&self, relative_path: &str, expected_revision: Option<&str>) -> Result<(), WorkspaceError> {
		let path = self.document_path(relative_path)?;
		if let Some(expected_revision) = expected_revision {
			let current = fs::read(&path)?;
			if revision(&current) != expected_revision {
				return Err(WorkspaceError::Conflict(relative_path.to_string()));
			}
		}
		fs::remove_file(path)?;
		Ok(())
	}

	pub fn import_asset(&self, document_relative_path: &str, source_path: impl AsRef<Path>) -> Result<AssetImport, WorkspaceError> {
		let document = self.document_path(document_relative_path)?;
		let document_parent = document
			.parent()
			.ok_or_else(|| WorkspaceError::InvalidRelativePath(document_relative_path.to_string()))?;
		let source = source_path.as_ref();
		if !source.is_file() {
			return Err(WorkspaceError::InvalidRelativePath(source.display().to_string()));
		}
		let file_name = source
			.file_name()
			.ok_or_else(|| WorkspaceError::InvalidRelativePath(source.display().to_string()))?;
		let file_name = file_name.to_string_lossy();
		if file_name.is_empty() || file_name == "." || file_name == ".." {
			return Err(WorkspaceError::InvalidRelativePath(source.display().to_string()));
		}

		let asset_directory = document_parent.join("_assets");
		if asset_directory.exists() {
			let canonical = fs::canonicalize(&asset_directory)?;
			if !canonical.starts_with(&self.root) || !canonical.is_dir() {
				return Err(WorkspaceError::InvalidRelativePath(asset_directory.display().to_string()));
			}
		}else{
			fs::create_dir(&asset_directory)?;
		}

		let stem = Path::new(file_name.as_ref())
			.file_stem()
			.and_then(|value| value.to_str())
			.unwrap_or("asset");
		let extension = Path::new(file_name.as_ref())
			.extension()
			.and_then(|value| value.to_str());
		let mut sequence = 1usize;
		let (target, target_name) = loop {
			let candidate_name = if sequence == 1 {
				file_name.to_string()
			}else if let Some(extension) = extension {
				format!("{stem}-{sequence}.{extension}")
			}else{
				format!("{stem}-{sequence}")
			};
			let candidate = asset_directory.join(&candidate_name);
			if !candidate.exists() {
				break (candidate, candidate_name);
			}
			sequence += 1;
		};

		let mut input = fs::File::open(source)?;
		let mut output = fs::OpenOptions::new()
			.write(true)
			.create_new(true)
			.open(&target)?;
		if let Err(error) = std::io::copy(&mut input, &mut output).and_then(|_| output.sync_all()) {
			drop(output);
			let _ = fs::remove_file(&target);
			return Err(WorkspaceError::Io(error));
		}

		let relative = target
			.strip_prefix(&self.root)
			.map_err(|_| WorkspaceError::InvalidRelativePath(target.display().to_string()))?;
		Ok(AssetImport {
			relative_path: portable_path(relative),
			markdown_source: format!("_assets/{}", markdown_url_path(&target_name)),
		})
	}

	fn resolve_new_file(&self, relative_path: &str) -> Result<PathBuf, WorkspaceError> {
		let relative = Path::new(relative_path);
		if relative.as_os_str().is_empty()
			|| relative.is_absolute()
			|| relative.components().any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
			|| relative.components().any(|component| matches!(component, Component::Normal(name) if name == ".git"))
		{
			return Err(WorkspaceError::InvalidRelativePath(relative_path.to_string()));
		}

		let file_name = relative
			.file_name()
			.ok_or_else(|| WorkspaceError::InvalidRelativePath(relative_path.to_string()))?;
		let parent_relative = relative.parent().unwrap_or_else(|| Path::new(""));
		let parent = fs::canonicalize(self.root.join(parent_relative))?;
		if !parent.starts_with(&self.root) || !parent.is_dir() {
			return Err(WorkspaceError::InvalidRelativePath(relative_path.to_string()));
		}
		let target = parent.join(file_name);
		if target.exists() {
			return Err(WorkspaceError::Io(std::io::Error::new(
				std::io::ErrorKind::AlreadyExists,
				format!("Path already exists: {}", target.display()),
			)));
		}
		Ok(target)
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

fn markdown_url_path(value: &str) -> String {
	let mut encoded = String::new();
	for byte in value.as_bytes() {
		if byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b'.' | b'~') {
			encoded.push(*byte as char);
		}else{
			encoded.push_str(&format!("%{byte:02X}"));
		}
	}
	encoded
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
	fn ensure_directory_creates_nested_path_and_rejects_escape() {
		let temp = tempfile::tempdir().unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();

		assert_eq!(workspace.ensure_directory("Daily/2026").unwrap(), "Daily/2026");
		assert!(temp.path().join("Daily").join("2026").is_dir());
		assert!(matches!(
			workspace.ensure_directory("../outside"),
			Err(WorkspaceError::InvalidRelativePath(_))
		));
	}

	#[test]
	fn markdown_documents_under_lists_nested_templates_and_missing_directory_is_empty() {
		let temp = tempfile::tempdir().unwrap();
		fs::create_dir_all(temp.path().join("Templates").join("nested")).unwrap();
		fs::write(temp.path().join("Templates").join("Daily.md"), "# Daily").unwrap();
		fs::write(temp.path().join("Templates").join("nested").join("Meeting.markdown"), "# Meeting").unwrap();
		fs::write(temp.path().join("Templates").join("ignore.txt"), "x").unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();

		assert_eq!(
			workspace.markdown_documents_under("Templates").unwrap(),
			vec!["Templates/Daily.md".to_string(), "Templates/nested/Meeting.markdown".to_string()]
		);
		assert!(workspace.markdown_documents_under("Missing").unwrap().is_empty());
	}

	#[test]
	fn read_asset_allows_parent_segments_inside_workspace() {
		let temp = tempfile::tempdir().unwrap();
		let workspace_root = temp.path().join("workspace");
		fs::create_dir_all(workspace_root.join("notes")).unwrap();
		fs::create_dir_all(workspace_root.join("images")).unwrap();
		fs::write(workspace_root.join("notes").join("note.md"), "# Note").unwrap();
		fs::write(workspace_root.join("images").join("photo.png"), b"png").unwrap();

		let workspace = Workspace::open(&workspace_root).unwrap();
		let bytes = workspace.read_asset("notes/note.md", "../images/photo.png").unwrap();

		assert_eq!(bytes, b"png");
	}

	#[test]
	fn read_asset_rejects_escape_from_workspace() {
		let temp = tempfile::tempdir().unwrap();
		let workspace_root = temp.path().join("workspace");
		fs::create_dir_all(&workspace_root).unwrap();
		fs::write(workspace_root.join("note.md"), "# Note").unwrap();
		fs::write(temp.path().join("outside.png"), b"outside").unwrap();

		let workspace = Workspace::open(&workspace_root).unwrap();

		assert!(matches!(
			workspace.read_asset("note.md", "../outside.png"),
			Err(WorkspaceError::InvalidRelativePath(_))
		));
	}

	#[test]
	fn document_exists_distinguishes_missing_and_escape() {
		let temp = tempfile::tempdir().unwrap();
		fs::write(temp.path().join("note.md"), "# Note").unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();

		assert!(workspace.document_exists("note.md").unwrap());
		assert!(!workspace.document_exists("missing.md").unwrap());
		assert!(matches!(
			workspace.document_exists("../outside.md"),
			Err(WorkspaceError::InvalidRelativePath(_))
		));
	}

	#[test]
	fn create_move_and_delete_document() {
		let temp = tempfile::tempdir().unwrap();
		fs::create_dir(temp.path().join("notes")).unwrap();
		fs::create_dir(temp.path().join("archive")).unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();

		let created = workspace.create_document("notes/new.md", "# New\n").unwrap();
		assert_eq!(created.relative_path, "notes/new.md");
		assert_eq!(created.content, "# New\n");

		let moved = workspace
			.move_document("notes/new.md", "archive/renamed.md", Some(&created.revision))
			.unwrap();
		assert_eq!(moved.relative_path, "archive/renamed.md");
		assert!(!temp.path().join("notes").join("new.md").exists());

		workspace.delete_document("archive/renamed.md", Some(&moved.revision)).unwrap();
		assert!(!temp.path().join("archive").join("renamed.md").exists());
	}

	#[test]
	fn create_document_does_not_overwrite_existing_file() {
		let temp = tempfile::tempdir().unwrap();
		fs::write(temp.path().join("note.md"), "existing").unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();

		assert!(workspace.create_document("note.md", "replacement").is_err());
		assert_eq!(fs::read_to_string(temp.path().join("note.md")).unwrap(), "existing");
	}

	#[test]
	fn move_document_does_not_overwrite_target() {
		let temp = tempfile::tempdir().unwrap();
		fs::write(temp.path().join("a.md"), "a").unwrap();
		fs::write(temp.path().join("b.md"), "b").unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();
		let source = workspace.read_document("a.md").unwrap();

		assert!(workspace.move_document("a.md", "b.md", Some(&source.revision)).is_err());
		assert_eq!(fs::read_to_string(temp.path().join("a.md")).unwrap(), "a");
		assert_eq!(fs::read_to_string(temp.path().join("b.md")).unwrap(), "b");
	}

	#[test]
	fn delete_document_detects_external_change() {
		let temp = tempfile::tempdir().unwrap();
		let path = temp.path().join("note.md");
		fs::write(&path, "before").unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();
		let document = workspace.read_document("note.md").unwrap();
		fs::write(&path, "external").unwrap();

		assert!(matches!(
			workspace.delete_document("note.md", Some(&document.revision)),
			Err(WorkspaceError::Conflict(_))
		));
		assert!(path.exists());
	}

	#[test]
	fn create_document_rejects_workspace_escape() {
		let temp = tempfile::tempdir().unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();

		assert!(matches!(
			workspace.create_document("../escape.md", ""),
			Err(WorkspaceError::InvalidRelativePath(_))
		));
	}

	#[test]
	fn import_asset_copies_bytes_and_avoids_overwrite() {
		let temp = tempfile::tempdir().unwrap();
		let workspace_root = temp.path().join("workspace");
		let outside = temp.path().join("outside");
		fs::create_dir(&workspace_root).unwrap();
		fs::create_dir(&outside).unwrap();
		fs::write(workspace_root.join("note.md"), "# Note").unwrap();
		fs::write(outside.join("image one.png"), b"first").unwrap();
		let workspace = Workspace::open(&workspace_root).unwrap();

		let first = workspace.import_asset("note.md", outside.join("image one.png")).unwrap();
		fs::write(outside.join("image one.png"), b"second").unwrap();
		let second = workspace.import_asset("note.md", outside.join("image one.png")).unwrap();

		assert_eq!(first.relative_path, "_assets/image one.png");
		assert_eq!(first.markdown_source, "_assets/image%20one.png");
		assert_eq!(second.relative_path, "_assets/image one-2.png");
		assert_eq!(fs::read(workspace_root.join("_assets").join("image one.png")).unwrap(), b"first");
		assert_eq!(fs::read(workspace_root.join("_assets").join("image one-2.png")).unwrap(), b"second");
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
