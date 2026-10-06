use crate::{Workspace, WorkspaceError};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchKind {
	Filename,
	Content,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
	pub kind: SearchKind,
	pub relative_path: String,
	pub line: Option<usize>,
	pub preview: String,
}

impl Workspace {
	pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>, WorkspaceError> {
		let query = query.trim();
		if query.is_empty() || limit == 0 {
			return Ok(Vec::new());
		}

		let query_lower = query.to_lowercase();
		let mut files = Vec::new();
		collect_markdown_files(&self.root, &self.root, &mut files)?;
		files.sort();

		let mut hits = Vec::new();
		for path in files {
			let relative = path
				.strip_prefix(&self.root)
				.map_err(|_| WorkspaceError::InvalidRelativePath(path.display().to_string()))?;
			let relative_path = portable_path(relative);
			if relative_path.to_lowercase().contains(&query_lower) {
				hits.push(SearchHit {
					kind: SearchKind::Filename,
					relative_path: relative_path.clone(),
					line: None,
					preview: relative_path.clone(),
				});
				if hits.len() >= limit {
					break;
				}
			}

			let bytes = match fs::read(&path) {
				Ok(bytes) => bytes,
				Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => continue,
				Err(error) => return Err(WorkspaceError::Io(error)),
			};
			let content = match String::from_utf8(bytes) {
				Ok(content) => content,
				Err(_) => continue,
			};
			for (index, line) in content.lines().enumerate() {
				if !line.to_lowercase().contains(&query_lower) {
					continue;
				}
				hits.push(SearchHit {
					kind: SearchKind::Content,
					relative_path: relative_path.clone(),
					line: Some(index + 1),
					preview: compact_preview(line, 180),
				});
				if hits.len() >= limit {
					break;
				}
			}
			if hits.len() >= limit {
				break;
			}
		}
		Ok(hits)
	}
}

fn collect_markdown_files(root: &Path, directory: &Path, files: &mut Vec<PathBuf>) -> Result<(), WorkspaceError> {
	for entry in fs::read_dir(directory)? {
		let entry = entry?;
		let file_type = entry.file_type()?;
		if file_type.is_symlink() {
			continue;
		}
		let name = entry.file_name();
		if name == ".git" {
			continue;
		}
		let path = entry.path();
		if file_type.is_dir() {
			collect_markdown_files(root, &path, files)?;
			continue;
		}
		if !file_type.is_file() || !is_markdown(&path) {
			continue;
		}
		let canonical = fs::canonicalize(&path)?;
		if canonical.starts_with(root) {
			files.push(canonical);
		}
	}
	Ok(())
}

fn is_markdown(path: &Path) -> bool {
	path.extension()
		.and_then(|extension| extension.to_str())
		.is_some_and(|extension| extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown"))
}

fn compact_preview(line: &str, max_chars: usize) -> String {
	let trimmed = line.trim();
	let mut chars = trimmed.chars();
	let preview = chars.by_ref().take(max_chars).collect::<String>();
	if chars.next().is_some() {
		format!("{preview}…")
	}else{
		preview
	}
}

fn portable_path(path: &Path) -> String {
	path.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn search_finds_filename_and_content_recursively() {
		let temp = tempfile::tempdir().unwrap();
		fs::create_dir_all(temp.path().join("notes")).unwrap();
		fs::write(temp.path().join("notes").join("Alpha.md"), "# Heading\nneedle here\n").unwrap();
		fs::write(temp.path().join("other.md"), "No match\n").unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();

		let filename_hits = workspace.search("alpha", 20).unwrap();
		assert!(filename_hits.iter().any(|hit| hit.kind == SearchKind::Filename && hit.relative_path == "notes/Alpha.md"));

		let content_hits = workspace.search("NEEDLE", 20).unwrap();
		assert!(content_hits.iter().any(|hit| {
			hit.kind == SearchKind::Content
				&& hit.relative_path == "notes/Alpha.md"
				&& hit.line == Some(2)
		}));
	}

	#[test]
	fn search_ignores_git_and_non_markdown_files() {
		let temp = tempfile::tempdir().unwrap();
		fs::create_dir(temp.path().join(".git")).unwrap();
		fs::write(temp.path().join(".git").join("hidden.md"), "secret needle").unwrap();
		fs::write(temp.path().join("plain.txt"), "needle").unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();

		assert!(workspace.search("needle", 20).unwrap().is_empty());
	}

	#[test]
	fn search_respects_limit() {
		let temp = tempfile::tempdir().unwrap();
		fs::write(temp.path().join("a.md"), "needle\nneedle\nneedle\n").unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();

		assert_eq!(workspace.search("needle", 2).unwrap().len(), 2);
	}
}
