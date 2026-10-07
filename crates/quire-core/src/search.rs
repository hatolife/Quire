use crate::{scan, Workspace, WorkspaceError};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

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
	tags: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SearchIndex {
	documents: Vec<IndexedDocument>,
	tags: Vec<TagInfo>,
}

impl SearchIndex {
	pub fn build(workspace: &Workspace) -> Result<Self, WorkspaceError> {
		let mut files = scan::markdown_files(&workspace.root).map_err(WorkspaceError::Io)?;
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
			for tag in extract_frontmatter_tags(&content) {
				let key = tag.to_lowercase();
				let entry = tag_counts.entry(key).or_insert_with(|| (tag, 0));
				entry.1 += 1;
			}
			let mut in_fence = false;
			let body_start = frontmatter_body_start(&content);
			for line in content[body_start..].lines() {
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
			documents.push(indexed_document(relative_path, &content));
		}
		let mut tags = tag_counts
			.into_values()
			.map(|(name, count)| TagInfo { name, count })
			.collect::<Vec<_>>();
		tags.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
		Ok(Self { documents, tags })
	}

	pub fn refresh_document(&mut self, workspace: &Workspace, relative_path: &str) -> Result<(), WorkspaceError> {
		let path = workspace.document_path(relative_path)?;
		let bytes = fs::read(&path)?;
		let content = match String::from_utf8(bytes) {
			Ok(content) => content,
			Err(_) => return Ok(()),
		};
		let indexed = indexed_document(relative_path.to_string(), &content);
		if let Some(existing) = self.documents.iter_mut().find(|document| document.relative_path == relative_path) {
			*existing = indexed;
		}else{
			self.documents.push(indexed);
			self.documents.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
		}
		self.rebuild_tags();
		Ok(())
	}

	fn rebuild_tags(&mut self) {
		let mut tag_counts: HashMap<String, (String, usize)> = HashMap::new();
		for document in &self.documents {
			let content = document.lines.iter().map(|line| line.original.as_str()).collect::<Vec<_>>().join("\n");
			for tag in extract_frontmatter_tags(&content) {
				let key = tag.to_lowercase();
				let entry = tag_counts.entry(key).or_insert_with(|| (tag, 0));
				entry.1 += 1;
			}
			let mut in_fence = false;
			let body_start = frontmatter_body_start(&content);
			for line in content[body_start..].lines() {
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
		}
		self.tags = tag_counts
			.into_values()
			.map(|(name, count)| TagInfo { name, count })
			.collect();
		self.tags.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
	}

	pub fn tags(&self) -> Vec<TagInfo> {
		self.tags.clone()
	}

	pub fn documents(&self) -> Vec<String> {
		self.documents.iter().map(|document| document.relative_path.clone()).collect()
	}

	pub fn document_count(&self) -> usize {
		self.documents.len()
	}

	pub fn search(&self, query: &str, limit: usize) -> Vec<SearchHit> {
		let query = query.trim();
		if query.is_empty() || limit == 0 {
			return Vec::new();
		}
		if is_advanced_query(query) {
			return self.search_advanced(query, limit);
		}
		self.search_legacy(query, limit)
	}

	fn search_legacy(&self, query: &str, limit: usize) -> Vec<SearchHit> {
		let query_lower = query.to_lowercase();
		let mut hits = Vec::new();

		for document in &self.documents {
			if !document.lowercase_path.contains(&query_lower) {
				continue;
			}
			hits.push(filename_hit(document));
			if hits.len() >= limit {
				return hits;
			}
		}

		for document in &self.documents {
			for (index, line) in document.lines.iter().enumerate() {
				if !line.lowercase.contains(&query_lower) {
					continue;
				}
				hits.push(content_hit(document, index, line));
				if hits.len() >= limit {
					return hits;
				}
			}
		}
		hits
	}

	fn search_advanced(&self, query: &str, limit: usize) -> Vec<SearchHit> {
		let parsed = parse_advanced_query(query);
		let mut hits = Vec::new();

		for document in self.documents.iter().filter(|document| matches_filters(document, &parsed)) {
			if parsed.terms.is_empty() || parsed.terms.iter().all(|term| document.lowercase_path.contains(term)) {
				hits.push(filename_hit(document));
				if hits.len() >= limit {
					return hits;
				}
			}
		}

		if parsed.terms.is_empty() {
			return hits;
		}

		for document in self.documents.iter().filter(|document| matches_filters(document, &parsed)) {
			for (index, line) in document.lines.iter().enumerate() {
				if !parsed.terms.iter().all(|term| line.lowercase.contains(term)) {
					continue;
				}
				hits.push(content_hit(document, index, line));
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

fn indexed_document(relative_path: String, content: &str) -> IndexedDocument {
	let lines = content
		.lines()
		.map(|line| IndexedLine {
			original: line.to_string(),
			lowercase: line.to_lowercase(),
		})
		.collect();
	IndexedDocument {
		lowercase_path: relative_path.to_lowercase(),
		relative_path,
		lines,
		tags: document_tag_keys(content),
	}
}

#[derive(Debug, Default)]
struct ParsedSearchQuery {
	terms: Vec<String>,
	path_filters: Vec<String>,
	tag_filters: Vec<String>,
}

fn is_advanced_query(query: &str) -> bool {
	let lower = query.to_lowercase();
	query.contains('"') || lower.contains("path:") || lower.contains("tag:")
}

fn parse_advanced_query(query: &str) -> ParsedSearchQuery {
	let mut parsed = ParsedSearchQuery::default();
	for token in tokenize_query(query) {
		let lower = token.to_lowercase();
		if let Some(value) = lower.strip_prefix("path:") {
			let value = value.trim();
			if !value.is_empty() {
				parsed.path_filters.push(value.replace('\\', "/"));
			}
			continue;
		}
		if let Some(value) = lower.strip_prefix("tag:") {
			let value = value.trim().trim_start_matches('#');
			if !value.is_empty() {
				parsed.tag_filters.push(value.to_string());
			}
			continue;
		}
		let term = token.trim().to_lowercase();
		if !term.is_empty() {
			parsed.terms.push(term);
		}
	}
	parsed
}

fn tokenize_query(query: &str) -> Vec<String> {
	let mut tokens = Vec::new();
	let mut current = String::new();
	let mut quoted = false;
	let mut escaped = false;
	for ch in query.chars() {
		if escaped {
			current.push(ch);
			escaped = false;
			continue;
		}
		if ch == '\\' && quoted {
			escaped = true;
			continue;
		}
		if ch == '"' {
			quoted = !quoted;
			continue;
		}
		if ch.is_whitespace() && !quoted {
			if !current.is_empty() {
				tokens.push(std::mem::take(&mut current));
			}
			continue;
		}
		current.push(ch);
	}
	if !current.is_empty() {
		tokens.push(current);
	}
	tokens
}

fn matches_filters(document: &IndexedDocument, query: &ParsedSearchQuery) -> bool {
	if !query.path_filters.iter().all(|filter| document.lowercase_path.contains(filter)) {
		return false;
	}
	query.tag_filters.iter().all(|filter| {
		document.tags.iter().any(|tag| tag == filter || tag.starts_with(&format!("{filter}/")))
	})
}

fn filename_hit(document: &IndexedDocument) -> SearchHit {
	SearchHit {
		kind: SearchKind::Filename,
		relative_path: document.relative_path.clone(),
		line: None,
		preview: document.relative_path.clone(),
	}
}

fn content_hit(document: &IndexedDocument, index: usize, line: &IndexedLine) -> SearchHit {
	SearchHit {
		kind: SearchKind::Content,
		relative_path: document.relative_path.clone(),
		line: Some(index + 1),
		preview: compact_preview(&line.original, 180),
	}
}

fn document_tag_keys(content: &str) -> Vec<String> {
	let mut tags = std::collections::HashSet::new();
	for tag in extract_frontmatter_tags(content) {
		tags.insert(tag.to_lowercase());
	}
	let body_start = frontmatter_body_start(content);
	let mut in_fence = false;
	for line in content[body_start..].lines() {
		if is_fence(line) {
			in_fence = !in_fence;
			continue;
		}
		if in_fence {
			continue;
		}
		for tag in extract_tags(line) {
			tags.insert(tag.to_lowercase());
		}
	}
	let mut tags = tags.into_iter().collect::<Vec<_>>();
	tags.sort();
	tags
}

fn is_fence(line: &str) -> bool {
	let trimmed = line.trim_start().as_bytes();
	trimmed.starts_with(&[126, 126, 126]) || trimmed.starts_with(&[96, 96, 96])
}

fn frontmatter_body_start(content: &str) -> usize {
	if !content.starts_with("---\n") && !content.starts_with("---\r\n") {
		return 0;
	}
	let mut offset = 0usize;
	for (index, line) in content.split_inclusive('\n').enumerate() {
		offset += line.len();
		if index == 0 {
			continue;
		}
		let trimmed = line.trim_end_matches(['\r', '\n']);
		if trimmed == "---" || trimmed == "..." {
			return offset;
		}
	}
	0
}

fn extract_frontmatter_tags(content: &str) -> Vec<String> {
	let body_start = frontmatter_body_start(content);
	if body_start == 0 {
		return Vec::new();
	}
	let header = &content[..body_start];
	let mut tags = Vec::new();
	let mut collecting_list = false;
	for line in header.lines().skip(1) {
		let trimmed = line.trim();
		if trimmed == "---" || trimmed == "..." {
			break;
		}
		if collecting_list {
			if let Some(value) = trimmed.strip_prefix("- ") {
				push_frontmatter_tag(&mut tags, value);
				continue;
			}
			if !trimmed.is_empty() && !line.starts_with(' ') && !line.starts_with('\t') {
				collecting_list = false;
			}else if trimmed.is_empty() {
				continue;
			}else{
				collecting_list = false;
			}
		}
		let Some((key, value)) = trimmed.split_once(':') else { continue; };
		if !key.eq_ignore_ascii_case("tags") && !key.eq_ignore_ascii_case("tag") {
			continue;
		}
		let value = value.trim();
		if value.is_empty() {
			collecting_list = true;
			continue;
		}
		if value.starts_with('[') && value.ends_with(']') {
			for item in value[1..value.len() - 1].split(',') {
				push_frontmatter_tag(&mut tags, item);
			}
		}else{
			push_frontmatter_tag(&mut tags, value);
		}
	}
	tags
}

fn push_frontmatter_tag(tags: &mut Vec<String>, value: &str) {
	let tag = value
		.trim()
		.trim_matches(|ch| matches!(ch, '"' | '\''))
		.trim_start_matches('#')
		.trim();
	if tag.is_empty() || tag.chars().any(char::is_whitespace) {
		return;
	}
	tags.push(tag.to_string());
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
	fn advanced_search_filters_by_path_tag_and_phrase() {
		let temp = tempfile::tempdir().unwrap();
		fs::create_dir_all(temp.path().join("notes").join("work")).unwrap();
		fs::create_dir_all(temp.path().join("notes").join("personal")).unwrap();
		fs::write(
			temp.path().join("notes").join("work").join("alpha.md"),
			"---\ntags: [project/quire]\n---\nexact phrase here\nother words\n",
		).unwrap();
		fs::write(
			temp.path().join("notes").join("personal").join("beta.md"),
			"#project/personal\nexact phrase here\n",
		).unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();
		let index = workspace.build_search_index().unwrap();

		let path_hits = index.search("path:work", 20);
		assert!(!path_hits.is_empty());
		assert!(path_hits.iter().all(|hit| hit.relative_path.contains("/work/")));

		let tag_hits = index.search("tag:project", 20);
		assert!(tag_hits.iter().any(|hit| hit.relative_path.ends_with("alpha.md")));
		assert!(tag_hits.iter().any(|hit| hit.relative_path.ends_with("beta.md")));

		let exact_tag_hits = index.search("tag:project/quire", 20);
		assert!(exact_tag_hits.iter().all(|hit| hit.relative_path.ends_with("alpha.md")));

		let combined = index.search("path:work tag:project/quire \"exact phrase\"", 20);
		assert_eq!(combined.iter().filter(|hit| hit.kind == SearchKind::Content).count(), 1);
		assert_eq!(combined.iter().find(|hit| hit.kind == SearchKind::Content).unwrap().line, Some(5));
	}

	#[test]
	fn plain_multiword_search_keeps_legacy_literal_behavior() {
		let temp = tempfile::tempdir().unwrap();
		fs::write(temp.path().join("a.md"), "foo middle bar\nfoo bar\n").unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();
		let index = workspace.build_search_index().unwrap();

		let hits = index.search("foo bar", 20);

		assert_eq!(hits.iter().filter(|hit| hit.kind == SearchKind::Content).count(), 1);
		assert_eq!(hits.iter().find(|hit| hit.kind == SearchKind::Content).unwrap().line, Some(2));
	}

	#[test]
	fn advanced_filter_only_query_returns_documents() {
		let temp = tempfile::tempdir().unwrap();
		fs::write(temp.path().join("tagged.md"), "---\ntags: [alpha]\n---\nbody\n").unwrap();
		fs::write(temp.path().join("other.md"), "body\n").unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();
		let index = workspace.build_search_index().unwrap();

		let hits = index.search("tag:alpha", 20);

		assert_eq!(hits.len(), 1);
		assert_eq!(hits[0].kind, SearchKind::Filename);
		assert_eq!(hits[0].relative_path, "tagged.md");
	}

	#[test]
	fn search_index_can_refresh_one_document() {
		let temp = tempfile::tempdir().unwrap();
		fs::write(temp.path().join("a.md"), "#old\nbefore\n").unwrap();
		fs::write(temp.path().join("b.md"), "untouched\n").unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();
		let mut index = workspace.build_search_index().unwrap();

		fs::write(temp.path().join("a.md"), "#new\nafter\n").unwrap();
		index.refresh_document(&workspace, "a.md").unwrap();

		assert!(index.search("before", 20).is_empty());
		assert_eq!(index.search("after", 20).len(), 1);
		assert!(index.search("untouched", 20).iter().any(|hit| hit.relative_path == "b.md"));
		assert!(index.tags().iter().any(|tag| tag.name == "new"));
		assert!(!index.tags().iter().any(|tag| tag.name == "old"));
	}

	#[test]
	fn search_index_collects_frontmatter_tags() {
		let temp = tempfile::tempdir().unwrap();
		fs::write(
			temp.path().join("properties.md"),
			"---\ntags:\n  - alpha\n  - project/test\ntag: beta\n---\nbody #inline\n",
		).unwrap();
		fs::write(
			temp.path().join("inline-properties.md"),
			"---\ntags: [gamma, #delta]\n---\ntext\n",
		).unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();
		let index = workspace.build_search_index().unwrap();
		let tags = index.tags();

		for expected in ["alpha", "project/test", "beta", "gamma", "delta", "inline"] {
			assert!(tags.iter().any(|tag| tag.name.eq_ignore_ascii_case(expected)), "missing {expected}");
		}
		assert!(!index.search("tags:", 20).is_empty());
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
