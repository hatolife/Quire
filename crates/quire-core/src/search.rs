use crate::{Workspace, WorkspaceError};
use serde::Serialize;
use std::collections::HashMap;
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagInfo {
	pub name: String,
	pub count: usize,
}

#[derive(Debug, Clone)]
struct IndexedLine {
	original: String,
	lowercase: String,
}

#[derive(Debug, Clone)]
struct IndexedDocument {
	relative_path: String,
	lowercase_path: String,
	lines: Vec<IndexedLine>,
}

#[derive(Debug, Clone, Default)]
pub struct SearchIndex {
	documents: Vec<IndexedDocument>,
	tags: Vec<TagInfo>,
}

impl SearchIndex {
	pub fn build(workspace: &Workspace) -> Result<Self, WorkspaceError> {
		let mut files = Vec::new();
		collect_markdown_files(&workspace.root, &workspace.root, &mut files)?;
		files.sort();

		let mut documents = Vec::with_capacity(files.len());
		let mut tag_counts: HashMap<String, (String, usize)> = HashMap::new();
		for path in files {
			let relative = path
				.strip_prefix(&workspace.root)
				.map_err(|_| WorkspaceError::InvalidRelativePath(path.display().to_string()))?;
			let relative_path = portable_path(relative);
			let bytes = match fs::read(&path) {
				Ok(bytes) => bytes,
				Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => continue,
				Err(error) => return Err(WorkspaceError::Io(error)),
			};
			let content = match String::from_utf8(bytes) {
				Ok(content) => content,
				Err(_) => continue,
			};
			let mut in_fence = false;
			for line in content.lines() {
				if is_fence(line) {
					in_fence = !in_fence;
					continue;
				}
				if in_fence {
					continue;
				}
				for tag in extract_tags(line) {
					let key = tag.to_lowercase();
					let entry = tag_counts.entry(key).or_insert_with(|| (tag, 0));
					entry.1 += 1;
				}
			}
			let lines = content
				.lines()
				.map(|line| IndexedLine {
					original: line.to_string(),
					lowercase: line.to_lowercase(),
				})
				.collect();
			documents.push(IndexedDocument {
				lowercase_path: relative_path.to_lowercase(),
				relative_path,
				lines,
			});
		}
		let mut tags = tag_counts
			.into_values()
			.map(|(name, count)| TagInfo { name, count })
			.collect::<Vec<_>>();
		tags.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
		Ok(Self { documents, tags })
	}

	pub fn tags(&self) -> Vec<TagInfo> {
		self.tags.clone()
	}

	pub fn document_count(&self) -> usize {
		self.documents.len()
	}

	pub fn search(&self, query: &str, limit: usize) -> Vec<SearchHit> {
		let query = query.trim();
		if query.is_empty() || limit == 0 {
			return Vec::new();
		}
		let query_lower = query.to_lowercase();
		let mut hits = Vec::new();

		for document in &self.documents {
			if !document.lowercase_path.contains(&query_lower) {
				continue;
			}
			hits.push(SearchHit {
				kind: SearchKind::Filename,
				relative_path: document.relative_path.clone(),
				line: None,
				preview: document.relative_path.clone(),
			});
			if hits.len() >= limit {
				return hits;
			}
		}

		for document in &self.documents {
			for (index, line) in document.lines.iter().enumerate() {
				if !line.lowercase.contains(&query_lower) {
					continue;
				}
				hits.push(SearchHit {
					kind: SearchKind::Content,
					relative_path: document.relative_path.clone(),
					line: Some(index + 1),
					preview: compact_preview(&line.original, 180),
				});
				if hits.len() >= limit {
					return hits;
				}
			}
		}
		hits
	}
}

impl Workspace {
	pub fn build_search_index(&self) -> Result<SearchIndex, WorkspaceError> {
		SearchIndex::build(self)
	}

	pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>, WorkspaceError> {
		Ok(self.build_search_index()?.search(query, limit))
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

fn is_fence(line: &str) -> bool {
	let trimmed = line.trim_start().as_bytes();
	trimmed.starts_with(&[126, 126, 126]) || trimmed.starts_with(&[96, 96, 96])
}

fn extract_tags(line: &str) -> Vec<String> {
	let chars = line.char_indices().collect::<Vec<_>>();
	let mut tags = Vec::new();
	for (position, (start, ch)) in chars.iter().copied().enumerate() {
		if ch != '#' {
			continue;
		}
		if position > 0 {
			let previous = chars[position - 1].1;
			if previous.is_alphanumeric() || matches!(previous, '_' | '-' | '/' | '#') {
				continue;
			}
		}
		let mut end = start + ch.len_utf8();
		for (_, candidate) in chars.iter().copied().skip(position + 1) {
			if candidate.is_alphanumeric() || matches!(candidate, '_' | '-' | '/') {
				end += candidate.len_utf8();
			}else{
				break;
			}
		}
		if end <= start + 1 {
			continue;
		}
		let tag = &line[start + 1..end];
		if !tag.chars().any(|value| value.is_alphabetic() || value == '_') {
			continue;
		}
		tags.push(tag.to_string());
	}
	tags
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
	fn search_index_finds_filename_and_content_recursively() {
		let temp = tempfile::tempdir().unwrap();
		fs::create_dir_all(temp.path().join("notes")).unwrap();
		fs::write(temp.path().join("notes").join("Alpha.md"), "# Heading\nneedle here\n").unwrap();
		fs::write(temp.path().join("other.md"), "No match\n").unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();
		let index = workspace.build_search_index().unwrap();

		assert_eq!(index.document_count(), 2);
		let filename_hits = index.search("alpha", 20);
		assert!(filename_hits.iter().any(|hit| hit.kind == SearchKind::Filename && hit.relative_path == "notes/Alpha.md"));

		let content_hits = index.search("NEEDLE", 20);
		assert!(content_hits.iter().any(|hit| {
			hit.kind == SearchKind::Content
				&& hit.relative_path == "notes/Alpha.md"
				&& hit.line == Some(2)
		}));
	}

	#[test]
	fn filename_matches_are_ranked_before_content_matches() {
		let temp = tempfile::tempdir().unwrap();
		fs::write(temp.path().join("a.md"), "target\ntarget\ntarget\n").unwrap();
		fs::write(temp.path().join("target-note.md"), "no body match\n").unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();
		let index = workspace.build_search_index().unwrap();

		let hits = index.search("target", 2);

		assert_eq!(hits.len(), 2);
		assert_eq!(hits[0].kind, SearchKind::Filename);
		assert_eq!(hits[0].relative_path, "target-note.md");
		assert_eq!(hits[1].kind, SearchKind::Content);
		assert_eq!(hits[1].relative_path, "a.md");
	}

	#[test]
	fn search_index_collects_tags_outside_fences() {
		let temp = tempfile::tempdir().unwrap();
		fs::write(
			temp.path().join("tags.md"),
			"# Heading\n#alpha #日本語/sub #123\n~~~md\n#ignored\n~~~\n#Alpha\n",
		).unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();
		let index = workspace.build_search_index().unwrap();

		let tags = index.tags();

		assert_eq!(tags.len(), 2);
		assert_eq!(tags[0].name.to_lowercase(), "alpha");
		assert_eq!(tags[0].count, 2);
		assert_eq!(tags[1].name, "日本語/sub");
		assert_eq!(tags[1].count, 1);
	}

	#[test]
	fn search_index_is_stable_until_rebuilt() {
		let temp = tempfile::tempdir().unwrap();
		fs::write(temp.path().join("a.md"), "before\n").unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();
		let first = workspace.build_search_index().unwrap();

		fs::write(temp.path().join("a.md"), "after\n").unwrap();

		assert!(first.search("after", 20).is_empty());
		let rebuilt = workspace.build_search_index().unwrap();
		assert_eq!(rebuilt.search("after", 20).len(), 1);
	}

	#[test]
	fn search_index_ignores_git_and_non_markdown_files() {
		let temp = tempfile::tempdir().unwrap();
		fs::create_dir(temp.path().join(".git")).unwrap();
		fs::write(temp.path().join(".git").join("hidden.md"), "secret needle").unwrap();
		fs::write(temp.path().join("plain.txt"), "needle").unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();

		assert!(workspace.build_search_index().unwrap().search("needle", 20).is_empty());
	}

	#[test]
	fn search_index_respects_limit() {
		let temp = tempfile::tempdir().unwrap();
		fs::write(temp.path().join("a.md"), "needle\nneedle\nneedle\n").unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();

		assert_eq!(workspace.build_search_index().unwrap().search("needle", 2).len(), 2);
	}
}
