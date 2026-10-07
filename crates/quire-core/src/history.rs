use crate::scan;
use serde::Serialize;
use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use tempfile::NamedTempFile;
use thiserror::Error;

const HISTORY_REF: &str = "refs/quire/history/latest";

#[derive(Debug, Error)]
pub enum HistoryError {
	#[error("Git is unavailable: {0}")]
	GitUnavailable(String),

	#[error("Git command failed: {0}")]
	GitFailed(String),

	#[error("Invalid history path: {0}")]
	InvalidPath(String),

	#[error("Snapshot does not exist: {0}")]
	InvalidSnapshot(String),

	#[error("Document changed outside Quire: {0}")]
	Conflict(String),

	#[error(transparent)]
	Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
	pub id: String,
	pub timestamp: i64,
	pub message: String,
}

#[derive(Debug, Clone)]
pub struct HistoryStore {
	workspace_root: PathBuf,
	git_dir: PathBuf,
}

impl HistoryStore {
	pub fn open(workspace_root: impl AsRef<Path>, git_dir: impl AsRef<Path>) -> Result<Self, HistoryError> {
		let workspace_root = fs::canonicalize(workspace_root)?;
		if !workspace_root.is_dir() {
			return Err(HistoryError::InvalidPath(workspace_root.display().to_string()));
		}
		let git_dir = git_dir.as_ref().to_path_buf();
		if !git_dir.exists() {
			if let Some(parent) = git_dir.parent() {
				fs::create_dir_all(parent)?;
			}
			let output = Command::new("git")
				.args(["init", "--bare"])
				.arg(&git_dir)
				.output()
				.map_err(|error| HistoryError::GitUnavailable(error.to_string()))?;
			if !output.status.success() {
				return Err(HistoryError::GitFailed(command_error("git init --bare", &output)));
			}
		}
		Ok(Self { workspace_root, git_dir })
	}

	pub fn create_snapshot(&self, message: &str) -> Result<Snapshot, HistoryError> {
		let index = self.git_dir.join("quire-index.tmp");
		if index.exists() {
			fs::remove_file(&index)?;
		}
		self.git_with_index(&["read-tree", "--empty"], &index)?;

		let mut files = scan::workspace_files(&self.workspace_root)?;
		files = files
			.into_iter()
			.map(|path| {
				path.strip_prefix(&self.workspace_root)
					.map(Path::to_path_buf)
					.map_err(|_| HistoryError::InvalidPath(path.display().to_string()))
			})
			.collect::<Result<Vec<_>, _>>()?;
		files.sort();
		for relative in files {
			let relative_os = relative.as_os_str().to_os_string();
			let git_path = portable_path(&relative);
			let hash = self.git_os(
				[
					OsString::from("hash-object"),
					OsString::from("-w"),
					OsString::from("--no-filters"),
					OsString::from("--"),
					relative_os,
				],
				None,
			)?;
			self.git_os(
				[
					OsString::from("update-index"),
					OsString::from("--add"),
					OsString::from("--cacheinfo"),
					OsString::from("100644"),
					OsString::from(hash.trim()),
					OsString::from(git_path),
				],
				Some(&index),
			)?;
		}

		let tree = self.git_with_index(&["write-tree"], &index)?;
		let parent = self.resolve_latest().ok();
		if let Some(parent) = parent.as_deref() {
			let parent_tree = self.git(&["rev-parse", &format!("{parent}^{{tree}}")])?;
			if parent_tree.trim() == tree.trim() {
				let _ = fs::remove_file(index);
				return self.snapshot(parent);
			}
		}
		let mut args = vec!["commit-tree".to_string(), tree.trim().to_string()];
		if let Some(parent) = parent.as_deref() {
			args.push("-p".to_string());
			args.push(parent.to_string());
		}
		let commit = self.git_strings_with_stdin(&args, message.as_bytes(), None)?;
		self.git(&["update-ref", HISTORY_REF, commit.trim()])?;
		let _ = fs::remove_file(index);
		self.snapshot(commit.trim())
	}

	pub fn list_snapshots(&self, limit: usize) -> Result<Vec<Snapshot>, HistoryError> {
		if limit == 0 || self.resolve_latest().is_err() {
			return Ok(Vec::new());
		}
		let format = "--format=%H%x09%ct%x09%s";
		let count = format!("-n{limit}");
		let output = self.git(&["log", HISTORY_REF, format, &count])?;
		let mut snapshots = Vec::new();
		for line in output.lines() {
			let mut parts = line.splitn(3, '\t');
			let Some(id) = parts.next() else { continue; };
			let timestamp = parts.next().and_then(|value| value.parse::<i64>().ok()).unwrap_or(0);
			let message = parts.next().unwrap_or("").to_string();
			snapshots.push(Snapshot { id: id.to_string(), timestamp, message });
		}
		Ok(snapshots)
	}

	pub fn list_documents(&self, snapshot_id: &str) -> Result<Vec<String>, HistoryError> {
		self.snapshot(snapshot_id)?;
		let bytes = self.git_bytes(&["ls-tree", "-r", "-z", "--name-only", snapshot_id])?;
		let mut documents = Vec::new();
		for raw in bytes.split(|value| *value == 0) {
			if raw.is_empty() {
				continue;
			}
			let path = String::from_utf8(raw.to_vec())
				.map_err(|error| HistoryError::GitFailed(format!("Snapshot path is not UTF-8: {error}")))?;
			let extension = Path::new(&path)
				.extension()
				.and_then(|value| value.to_str())
				.unwrap_or("");
			if extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown") {
				documents.push(path);
			}
		}
		Ok(documents)
	}

	pub fn read_file_text(&self, snapshot_id: &str, relative_path: &str) -> Result<Option<String>, HistoryError> {
		self.snapshot(snapshot_id)?;
		let relative = normalize_relative(relative_path)?;
		let spec = format!("{snapshot_id}:{}", portable_path(&relative));
		let output = self
			.command(None)
			.args(["show", &spec])
			.output()
			.map_err(|error| HistoryError::GitUnavailable(error.to_string()))?;
		if !output.status.success() {
			return Ok(None);
		}
		String::from_utf8(output.stdout)
			.map(Some)
			.map_err(|error| HistoryError::GitFailed(format!("Snapshot file is not UTF-8: {error}")))
	}

	pub fn restore_file(
		&self,
		snapshot_id: &str,
		relative_path: &str,
		expected_revision: Option<&str>,
	) -> Result<(), HistoryError> {
		validate_snapshot_id(snapshot_id)?;
		let relative = normalize_relative(relative_path)?;
		let target = self.workspace_root.join(&relative);
		if let Some(expected_revision) = expected_revision {
			if target.exists() {
				let current = fs::read(&target)?;
				if blake3::hash(&current).to_hex().as_str() != expected_revision {
					return Err(HistoryError::Conflict(relative_path.to_string()));
				}
			}
		}

		let spec = format!("{snapshot_id}:{}", portable_path(&relative));
		let bytes = self.git_bytes(&["show", &spec])?;
		let parent = target.parent().ok_or_else(|| HistoryError::InvalidPath(relative_path.to_string()))?;
		fs::create_dir_all(parent)?;
		let mut temporary = NamedTempFile::new_in(parent)?;
		temporary.write_all(&bytes)?;
		temporary.as_file().sync_all()?;
		temporary.persist(&target).map_err(|error| HistoryError::Io(error.error))?;
		Ok(())
	}

	pub fn snapshot(&self, snapshot_id: &str) -> Result<Snapshot, HistoryError> {
		validate_snapshot_id(snapshot_id)?;
		let format = "--format=%H%x09%ct%x09%s";
		let output = self.git(&["show", "-s", format, snapshot_id])?;
		let mut parts = output.trim().splitn(3, '\t');
		let id = parts.next().unwrap_or("").to_string();
		if id.is_empty() {
			return Err(HistoryError::InvalidSnapshot(snapshot_id.to_string()));
		}
		Ok(Snapshot {
			id,
			timestamp: parts.next().and_then(|value| value.parse::<i64>().ok()).unwrap_or(0),
			message: parts.next().unwrap_or("").to_string(),
		})
	}

	fn resolve_latest(&self) -> Result<String, HistoryError> {
		self.git(&["rev-parse", "--verify", HISTORY_REF])
	}

	fn git(&self, args: &[&str]) -> Result<String, HistoryError> {
		let args = args.iter().map(OsString::from).collect::<Vec<_>>();
		self.git_os(args, None)
	}

	fn git_with_index(&self, args: &[&str], index: &Path) -> Result<String, HistoryError> {
		let args = args.iter().map(OsString::from).collect::<Vec<_>>();
		self.git_os(args, Some(index))
	}

	fn git_os<I>(&self, args: I, index: Option<&Path>) -> Result<String, HistoryError>
	where
		I: IntoIterator<Item = OsString>,
	{
		let output = self.command(index).args(args).output().map_err(|error| HistoryError::GitUnavailable(error.to_string()))?;
		if !output.status.success() {
			return Err(HistoryError::GitFailed(command_error("git", &output)));
		}
		String::from_utf8(output.stdout)
			.map(|value| value.trim().to_string())
			.map_err(|error| HistoryError::GitFailed(format!("Git returned non UTF-8 output: {error}")))
	}

	fn git_bytes(&self, args: &[&str]) -> Result<Vec<u8>, HistoryError> {
		let output = self.command(None).args(args).output().map_err(|error| HistoryError::GitUnavailable(error.to_string()))?;
		if !output.status.success() {
			return Err(HistoryError::GitFailed(command_error("git", &output)));
		}
		Ok(output.stdout)
	}

	fn git_strings_with_stdin(&self, args: &[String], input: &[u8], index: Option<&Path>) -> Result<String, HistoryError> {
		let mut child = self
			.command(index)
			.args(args)
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.stderr(Stdio::piped())
			.env("GIT_AUTHOR_NAME", "Quire")
			.env("GIT_AUTHOR_EMAIL", "quire@localhost")
			.env("GIT_COMMITTER_NAME", "Quire")
			.env("GIT_COMMITTER_EMAIL", "quire@localhost")
			.spawn()
			.map_err(|error| HistoryError::GitUnavailable(error.to_string()))?;
		if let Some(stdin) = child.stdin.as_mut() {
			stdin.write_all(input)?;
		}
		let output = child.wait_with_output()?;
		if !output.status.success() {
			return Err(HistoryError::GitFailed(command_error("git commit-tree", &output)));
		}
		String::from_utf8(output.stdout)
			.map(|value| value.trim().to_string())
			.map_err(|error| HistoryError::GitFailed(format!("Git returned non UTF-8 output: {error}")))
	}

	fn command(&self, index: Option<&Path>) -> Command {
		let mut command = Command::new("git");
		command
			.current_dir(&self.workspace_root)
			.env("GIT_DIR", &self.git_dir)
			.env("GIT_WORK_TREE", &self.workspace_root);
		if let Some(index) = index {
			command.env("GIT_INDEX_FILE", index);
		}
		command
	}
}

fn normalize_relative(relative_path: &str) -> Result<PathBuf, HistoryError> {
	let path = Path::new(relative_path);
	if path.as_os_str().is_empty() || path.is_absolute() {
		return Err(HistoryError::InvalidPath(relative_path.to_string()));
	}
	let mut normalized = PathBuf::new();
	for component in path.components() {
		match component {
			Component::CurDir => {}
			Component::Normal(value) => normalized.push(value),
			_ => return Err(HistoryError::InvalidPath(relative_path.to_string())),
		}
	}
	Ok(normalized)
}

fn validate_snapshot_id(snapshot_id: &str) -> Result<(), HistoryError> {
	let valid_length = snapshot_id.len() == 40 || snapshot_id.len() == 64;
	if !valid_length || !snapshot_id.bytes().all(|value| value.is_ascii_hexdigit()) {
		return Err(HistoryError::InvalidSnapshot(snapshot_id.to_string()));
	}
	Ok(())
}

fn command_error(command: &str, output: &std::process::Output) -> String {
	format!(
		"{command} failed with {}\nstdout:\n{}\nstderr:\n{}",
		output.status,
		String::from_utf8_lossy(&output.stdout),
		String::from_utf8_lossy(&output.stderr)
	)
}

fn portable_path(path: &Path) -> String {
	path.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
	use super::*;

	fn git_available() -> bool {
		Command::new("git").arg("--version").output().map(|output| output.status.success()).unwrap_or(false)
	}

	fn user_git(repo: &Path, args: &[&str]) -> String {
		let output = Command::new("git").current_dir(repo).args(args).output().unwrap();
		assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
		String::from_utf8_lossy(&output.stdout).trim().to_string()
	}

	#[test]
	fn snapshot_and_restore_preserve_exact_bytes() {
		if !git_available(){ return; }
		let temp = tempfile::tempdir().unwrap();
		let workspace = temp.path().join("workspace");
		let history = temp.path().join("history.git");
		fs::create_dir(&workspace).unwrap();
		fs::write(workspace.join("note.md"), b"line1\r\nline2\r\n").unwrap();
		let store = HistoryStore::open(&workspace, &history).unwrap();

		let first = store.create_snapshot("First").unwrap();
		fs::write(workspace.join("note.md"), b"changed\n").unwrap();
		store.create_snapshot("Second").unwrap();
		let current = fs::read(workspace.join("note.md")).unwrap();
		let revision = blake3::hash(&current).to_hex().to_string();

		store.restore_file(&first.id, "note.md", Some(&revision)).unwrap();

		assert_eq!(fs::read(workspace.join("note.md")).unwrap(), b"line1\r\nline2\r\n");
		assert_eq!(store.list_snapshots(10).unwrap().len(), 2);
	}

	#[test]
	fn history_respects_quireignore_but_not_gitignore() {
		if !git_available(){ return; }
		let temp = tempfile::tempdir().unwrap();
		let workspace = temp.path().join("workspace");
		let history = temp.path().join("history.git");
		fs::create_dir(&workspace).unwrap();
		fs::write(workspace.join(".quireignore"), "ignored.bin\n").unwrap();
		fs::write(workspace.join(".gitignore"), "kept.bin\n").unwrap();
		fs::write(workspace.join("ignored.bin"), b"ignored").unwrap();
		fs::write(workspace.join("kept.bin"), b"kept").unwrap();
		let store = HistoryStore::open(&workspace, &history).unwrap();

		let snapshot = store.create_snapshot("Ignore rules").unwrap();

		assert!(store.git(&["show", &format!("{}:kept.bin", snapshot.id)]).is_ok());
		assert!(store.git(&["show", &format!("{}:ignored.bin", snapshot.id)]).is_err());
	}

	#[test]
	fn unchanged_snapshot_reuses_latest_commit() {
		if !git_available(){ return; }
		let temp = tempfile::tempdir().unwrap();
		let workspace = temp.path().join("workspace");
		let history = temp.path().join("history.git");
		fs::create_dir(&workspace).unwrap();
		fs::write(workspace.join("note.md"), "same\n").unwrap();
		let store = HistoryStore::open(&workspace, &history).unwrap();

		let first = store.create_snapshot("First").unwrap();
		let second = store.create_snapshot("Duplicate").unwrap();

		assert_eq!(first.id, second.id);
		assert_eq!(store.list_snapshots(10).unwrap().len(), 1);
	}

	#[test]
	fn nested_snapshot_round_trip_preserves_bytes() {
		if !git_available(){ return; }
		let temp = tempfile::tempdir().unwrap();
		let workspace = temp.path().join("workspace");
		let history = temp.path().join("history.git");
		fs::create_dir_all(workspace.join("nested").join("deep")).unwrap();
		let path = workspace.join("nested").join("deep").join("note.md");
		fs::write(&path, b"nested\r\nbytes\r\n").unwrap();
		let store = HistoryStore::open(&workspace, &history).unwrap();

		let snapshot = store.create_snapshot("Nested").unwrap();
		fs::write(&path, b"changed\n").unwrap();
		let revision = blake3::hash(&fs::read(&path).unwrap()).to_hex().to_string();
		store.restore_file(&snapshot.id, "nested/deep/note.md", Some(&revision)).unwrap();

		assert_eq!(fs::read(path).unwrap(), b"nested\r\nbytes\r\n");
	}

	#[test]
	fn snapshot_lists_markdown_documents_only() {
		if !git_available(){ return; }
		let temp = tempfile::tempdir().unwrap();
		let workspace = temp.path().join("workspace");
		let history = temp.path().join("history.git");
		fs::create_dir_all(workspace.join("nested")).unwrap();
		fs::write(workspace.join("a.md"), "a").unwrap();
		fs::write(workspace.join("nested").join("b.markdown"), "b").unwrap();
		fs::write(workspace.join("image.png"), b"png").unwrap();
		let store = HistoryStore::open(&workspace, &history).unwrap();
		let snapshot = store.create_snapshot("Documents").unwrap();

		assert_eq!(
			store.list_documents(&snapshot.id).unwrap(),
			vec!["a.md".to_string(), "nested/b.markdown".to_string()]
		);
	}

	#[test]
	fn snapshot_file_text_returns_content_or_none() {
		if !git_available(){ return; }
		let temp = tempfile::tempdir().unwrap();
		let workspace = temp.path().join("workspace");
		let history = temp.path().join("history.git");
		fs::create_dir(&workspace).unwrap();
		fs::write(workspace.join("note.md"), "snapshot text\n").unwrap();
		let store = HistoryStore::open(&workspace, &history).unwrap();
		let snapshot = store.create_snapshot("First").unwrap();

		assert_eq!(
			store.read_file_text(&snapshot.id, "note.md").unwrap().as_deref(),
			Some("snapshot text\n")
		);
		assert_eq!(store.read_file_text(&snapshot.id, "missing.md").unwrap(), None);
	}

	#[test]
	fn external_history_does_not_touch_user_git_state() {
		if !git_available(){ return; }
		let temp = tempfile::tempdir().unwrap();
		let workspace = temp.path().join("workspace");
		let history = temp.path().join("history.git");
		fs::create_dir(&workspace).unwrap();
		user_git(&workspace, &["init"]);
		user_git(&workspace, &["config", "user.name", "Test"]);
		user_git(&workspace, &["config", "user.email", "test@example.invalid"]);
		fs::write(workspace.join("note.md"), "base\n").unwrap();
		user_git(&workspace, &["add", "note.md"]);
		user_git(&workspace, &["commit", "-m", "base"]);
		fs::write(workspace.join("note.md"), "staged\n").unwrap();
		user_git(&workspace, &["add", "note.md"]);
		fs::write(workspace.join("note.md"), "working\n").unwrap();
		fs::write(workspace.join("untracked.md"), "untracked\n").unwrap();

		let head_before = user_git(&workspace, &["rev-parse", "HEAD"]);
		let status_before = user_git(&workspace, &["status", "--porcelain=v2", "--untracked-files=all"]);
		let index_path = workspace.join(".git").join("index");
		let index_before = fs::read(&index_path).unwrap();

		let store = HistoryStore::open(&workspace, &history).unwrap();
		let snapshot = store.create_snapshot("Quire snapshot").unwrap();

		assert_eq!(head_before, user_git(&workspace, &["rev-parse", "HEAD"]));
		assert_eq!(status_before, user_git(&workspace, &["status", "--porcelain=v2", "--untracked-files=all"]));
		assert_eq!(index_before, fs::read(index_path).unwrap());
		assert_eq!(store.git(&["show", &format!("{}:note.md", snapshot.id)]).unwrap(), "working");
		assert_eq!(store.git(&["show", &format!("{}:untracked.md", snapshot.id)]).unwrap(), "untracked");
	}
}
