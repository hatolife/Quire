use crate::{Workspace, WorkspaceError};
use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiLink {
	pub target: String,
	pub label: Option<String>,
	pub resolved_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Backlink {
	pub source_path: String,
	pub line: usize,
	pub preview: String,
}

impl Workspace {
	pub fn wiki_links(&self, source_relative_path: &str) -> Result<Vec<WikiLink>, WorkspaceError> {
		let document = self.read_document(source_relative_path)?;
		let mut links = Vec::new();
		let mut in_fence = false;
		for line in document.content.lines() {
			if is_fence(line) {
				in_fence = !in_fence;
				continue;
			}
			if in_fence {
				continue;
			}
			for (target, label) in extract_links(line) {
				let resolved_path = self.resolve_wiki_target(source_relative_path, &target)?;
				links.push(WikiLink { target, label, resolved_path });
			}
		}
		Ok(links)
	}

	pub fn backlinks(&self, target_relative_path: &str) -> Result<Vec<Backlink>, WorkspaceError> {
		let target = self.document_path(target_relative_path)?;
		let target_relative = portable_path(
			target
				.strip_prefix(&self.root)
				.map_err(|_| WorkspaceError::InvalidRelativePath(target.display().to_string()))?,
		);
		let mut files = Vec::new();
		collect_markdown_files(&self.root, &mut files)?;
		files.sort();

		let mut backlinks = Vec::new();
		for source in files {
			let source_relative = portable_path(
				source
					.strip_prefix(&self.root)
					.map_err(|_| WorkspaceError::InvalidRelativePath(source.display().to_string()))?,
			);
			if source_relative == target_relative {
				continue;
			}
			let content = match fs::read_to_string(&source) {
				Ok(content) => content,
				Err(error) if error.kind() == std::io::ErrorKind::InvalidData => continue,
				Err(error) => return Err(WorkspaceError::Io(error)),
			};
			let mut in_fence = false;
			for (line_index, line) in content.lines().enumerate() {
				if is_fence(line) {
					in_fence = !in_fence;
					continue;
				}
				if in_fence {
					continue;
				}
				let matched = extract_links(line).into_iter().any(|(raw_target, _)| {
					self.resolve_wiki_target(&source_relative, &raw_target)
						.ok()
						.flatten()
						.as_deref()
						== Some(target_relative.as_str())
				});
				if matched {
					backlinks.push(Backlink {
						source_path: source_relative.clone(),
						line: line_index + 1,
						preview: compact_preview(line, 180),
					});
				}
			}
		}
		Ok(backlinks)
	}

	fn resolve_wiki_target(&self, source_relative_path: &str, raw_target: &str) -> Result<Option<String>, WorkspaceError> {
		let target = raw_target
			.split('#')
			.next()
			.unwrap_or("")
			.trim()
			.replace('\\', "/");
		if target.is_empty() {
			return Ok(None);
		}

		if target.contains('/') || target.starts_with('.') {
			let source_parent = Path::new(source_relative_path).parent().unwrap_or_else(|| Path::new(""));
			let base = if target.starts_with("./") || target.starts_with("../") {
				source_parent.to_path_buf()
			}else{
				PathBuf::new()
			};
			let relative = normalize_relative(&base.join(&target))?;
			let with_extension = if has_markdown_extension(&relative) {
				relative
			}else{
				relative.with_extension("md")
			};
			let candidate = self.root.join(with_extension);
			if !candidate.exists() {
				return Ok(None);
			}
			let canonical = fs::canonicalize(candidate)?;
			if !canonical.starts_with(&self.root) || !canonical.is_file() {
				return Ok(None);
			}
			return Ok(Some(portable_path(
				canonical
					.strip_prefix(&self.root)
					.map_err(|_| WorkspaceError::InvalidRelativePath(raw_target.to_string()))?,
			)));
		}

		let wanted = Path::new(&target)
			.file_stem()
			.and_then(|stem| stem.to_str())
			.unwrap_or(&target)
			.to_lowercase();
		let mut files = Vec::new();
		collect_markdown_files(&self.root, &mut files)?;
		files.sort();
		for file in files {
			let stem = file.file_stem().and_then(|stem| stem.to_str()).unwrap_or("");
			if stem.to_lowercase() == wanted {
				return Ok(Some(portable_path(
					file.strip_prefix(&self.root)
						.map_err(|_| WorkspaceError::InvalidRelativePath(raw_target.to_string()))?,
				)));
			}
		}
		Ok(None)
	}
}

fn is_fence(line: &str) -> bool {
	let trimmed = line.trim_start().as_bytes();
	trimmed.starts_with(&[126, 126, 126]) || trimmed.starts_with(&[96, 96, 96])
}

fn extract_links(line: &str) -> Vec<(String, Option<String>)> {
	let mut links = Vec::new();
	let mut rest = line;
	while let Some(start) = rest.find("[[") {
		let after_start = &rest[start + 2..];
		let Some(end) = after_start.find("]]") else { break; };
		let body = after_start[..end].trim();
		if !body.is_empty() {
			let mut parts = body.splitn(2, '|');
			let target = parts.next().unwrap_or("").trim().to_string();
			let label = parts.next().map(str::trim).filter(|value| !value.is_empty()).map(str::to_string);
			if !target.is_empty() {
				links.push((target, label));
			}
		}
		rest = &after_start[end + 2..];
	}
	links
}

fn collect_markdown_files(directory: &Path, files: &mut Vec<PathBuf>) -> Result<(), WorkspaceError> {
	for entry in fs::read_dir(directory)? {
		let entry = entry?;
		let file_type = entry.file_type()?;
		if file_type.is_symlink() {
			continue;
		}
		if entry.file_name() == ".git" {
			continue;
		}
		let path = entry.path();
		if file_type.is_dir() {
			collect_markdown_files(&path, files)?;
		}else if file_type.is_file() && has_markdown_extension(&path) {
			files.push(fs::canonicalize(path)?);
		}
	}
	Ok(())
}

fn normalize_relative(path: &Path) -> Result<PathBuf, WorkspaceError> {
	let mut normalized = PathBuf::new();
	for component in path.components() {
		match component {
			Component::CurDir => {}
			Component::Normal(value) => normalized.push(value),
			Component::ParentDir => {
				if !normalized.pop() {
					return Err(WorkspaceError::InvalidRelativePath(path.display().to_string()));
				}
			}
			_ => return Err(WorkspaceError::InvalidRelativePath(path.display().to_string())),
		}
	}
	Ok(normalized)
}

fn has_markdown_extension(path: &Path) -> bool {
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
	fn wiki_links_resolve_filename_path_alias_and_heading() {
		let temp = tempfile::tempdir().unwrap();
		fs::create_dir_all(temp.path().join("notes")).unwrap();
		fs::write(temp.path().join("Target.md"), "# Target").unwrap();
		fs::write(temp.path().join("notes").join("Other.md"), "# Other").unwrap();
		fs::write(temp.path().join("Source.md"), "[[Target]] [[notes/Other|Other label]] [[Target#Heading]]").unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();

		let links = workspace.wiki_links("Source.md").unwrap();

		assert_eq!(links.len(), 3);
		assert_eq!(links[0].resolved_path.as_deref(), Some("Target.md"));
		assert_eq!(links[1].label.as_deref(), Some("Other label"));
		assert_eq!(links[1].resolved_path.as_deref(), Some("notes/Other.md"));
		assert_eq!(links[2].resolved_path.as_deref(), Some("Target.md"));
	}

	#[test]
	fn wiki_links_resolve_relative_parent_path_inside_workspace() {
		let temp = tempfile::tempdir().unwrap();
		fs::create_dir_all(temp.path().join("notes").join("nested")).unwrap();
		fs::write(temp.path().join("notes").join("Target.md"), "# Target").unwrap();
		fs::write(temp.path().join("notes").join("nested").join("Source.md"), "[[../Target]]").unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();

		let links = workspace.wiki_links("notes/nested/Source.md").unwrap();

		assert_eq!(links[0].resolved_path.as_deref(), Some("notes/Target.md"));
	}

	#[test]
	fn backlinks_ignore_fenced_code() {
		let temp = tempfile::tempdir().unwrap();
		fs::write(temp.path().join("Target.md"), "# Target").unwrap();
		fs::write(temp.path().join("Source.md"), "real [[Target]]\n~~~md\nignored [[Target]]\n~~~\n").unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();

		let backlinks = workspace.backlinks("Target.md").unwrap();

		assert_eq!(backlinks.len(), 1);
		assert_eq!(backlinks[0].source_path, "Source.md");
		assert_eq!(backlinks[0].line, 1);
	}

	#[test]
	fn unresolved_wiki_link_is_preserved() {
		let temp = tempfile::tempdir().unwrap();
		fs::write(temp.path().join("Source.md"), "[[Missing|label]]").unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();

		let links = workspace.wiki_links("Source.md").unwrap();

		assert_eq!(links[0].target, "Missing");
		assert_eq!(links[0].label.as_deref(), Some("label"));
		assert_eq!(links[0].resolved_path, None);
	}
}
