use crate::{scan, Workspace, WorkspaceError};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
	pub path: String,
	pub incoming: usize,
	pub outgoing: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
	pub source: String,
	pub target: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkGraph {
	pub nodes: Vec<GraphNode>,
	pub edges: Vec<GraphEdge>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentMove {
	pub document: crate::Document,
	pub updated_links: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct LinkIndex {
	wiki_by_stem: HashMap<String, Option<String>>,
	wiki_by_alias: HashMap<String, Option<String>>,
	aliases_by_document: BTreeMap<String, Vec<String>>,
	backlinks: HashMap<String, Vec<Backlink>>,
	document_count: usize,
}

impl LinkIndex {
	pub fn build(workspace: &Workspace) -> Result<Self, WorkspaceError> {
		let sources = scan::markdown_sources(&workspace.root).map_err(WorkspaceError::Io)?;
		Self::from_sources(workspace, &sources)
	}

	pub(crate) fn from_sources(
		workspace: &Workspace,
		sources: &[scan::MarkdownSource],
	) -> Result<Self, WorkspaceError> {
		let mut aliases_by_document = BTreeMap::new();
		for source in sources {
			aliases_by_document.insert(
				source.relative_path.clone(),
				extract_frontmatter_aliases(&source.content),
			);
		}
		let wiki_by_stem = build_stem_map(aliases_by_document.keys());
		let wiki_by_alias = build_alias_map(&aliases_by_document);

		let mut backlinks: HashMap<String, Vec<Backlink>> = HashMap::new();
		for source in sources {
			let source_relative = &source.relative_path;
			let mut in_fence = false;
			for (line_index, line) in source.content.lines().enumerate() {
				if is_fence(line) {
					in_fence = !in_fence;
					continue;
				}
				if in_fence {
					continue;
				}

				let mut targets = HashSet::new();
				for (raw_target, _) in extract_links(line) {
					if let Some(target) = resolve_indexed_wiki_target(
						workspace,
						source_relative,
						&raw_target,
						&wiki_by_stem,
						&wiki_by_alias,
					) {
						targets.insert(target);
					}
				}
				for raw_target in extract_markdown_targets(line) {
					if let Some(target) = workspace
						.resolve_markdown_target(source_relative, raw_target)
						.ok()
						.flatten()
					{
						targets.insert(target);
					}
				}

				for target in targets {
					if target == *source_relative {
						continue;
					}
					backlinks.entry(target).or_default().push(Backlink {
						source_path: source_relative.clone(),
						line: line_index + 1,
						preview: compact_preview(line, 180),
					});
				}
			}
		}

		Ok(Self {
			document_count: sources.len(),
			wiki_by_stem,
			wiki_by_alias,
			aliases_by_document,
			backlinks,
		})
	}

	pub fn refresh_document(&mut self, workspace: &Workspace, relative_path: &str) -> Result<(), WorkspaceError> {
		for backlinks in self.backlinks.values_mut() {
			backlinks.retain(|backlink| backlink.source_path != relative_path);
		}
		self.backlinks.retain(|_, backlinks| !backlinks.is_empty());

		let document = workspace.read_document(relative_path)?;
		self.aliases_by_document
			.insert(relative_path.to_string(), extract_frontmatter_aliases(&document.content));
		self.wiki_by_stem = build_stem_map(self.aliases_by_document.keys());
		self.wiki_by_alias = build_alias_map(&self.aliases_by_document);

		let mut in_fence = false;
		for (line_index, line) in document.content.lines().enumerate() {
			if is_fence(line) {
				in_fence = !in_fence;
				continue;
			}
			if in_fence {
				continue;
			}

			let mut targets = HashSet::new();
			for (raw_target, _) in extract_links(line) {
				if let Some(target) = resolve_indexed_wiki_target(workspace, relative_path, &raw_target, &self.wiki_by_stem, &self.wiki_by_alias) {
					targets.insert(target);
				}
			}
			for raw_target in extract_markdown_targets(line) {
				if let Some(target) = workspace.resolve_markdown_target(relative_path, raw_target).ok().flatten() {
					targets.insert(target);
				}
			}
			for target in targets {
				if target == relative_path {
					continue;
				}
				self.backlinks.entry(target).or_default().push(Backlink {
					source_path: relative_path.to_string(),
					line: line_index + 1,
					preview: compact_preview(line, 180),
				});
			}
		}
		Ok(())
	}

	pub fn document_count(&self) -> usize {
		self.document_count
	}

	pub fn backlinks(&self, target_relative_path: &str) -> Vec<Backlink> {
		self.backlinks.get(target_relative_path).cloned().unwrap_or_default()
	}

	pub fn graph(&self) -> LinkGraph {
		let mut edge_set = std::collections::BTreeSet::new();
		let mut incoming: HashMap<String, usize> = HashMap::new();
		let mut outgoing: HashMap<String, usize> = HashMap::new();

		for (target, backlinks) in &self.backlinks {
			for backlink in backlinks {
				if backlink.source_path == *target {
					continue;
				}
				if edge_set.insert((backlink.source_path.clone(), target.clone())) {
					*incoming.entry(target.clone()).or_default() += 1;
					*outgoing.entry(backlink.source_path.clone()).or_default() += 1;
				}
			}
		}

		let nodes = self.aliases_by_document
			.keys()
			.map(|path| GraphNode {
				path: path.clone(),
				incoming: incoming.get(path).copied().unwrap_or(0),
				outgoing: outgoing.get(path).copied().unwrap_or(0),
			})
			.collect();
		let edges = edge_set
			.into_iter()
			.map(|(source, target)| GraphEdge { source, target })
			.collect();

		LinkGraph { nodes, edges }
	}

	pub fn resolve_bare_wiki_target(&self, raw_target: &str) -> Option<String> {
		let target = wiki_target_without_heading(raw_target)?;
		if target.contains('/') || target.starts_with('.') {
			return None;
		}
		let wanted = Path::new(&target)
			.file_stem()
			.and_then(|stem| stem.to_str())
			.unwrap_or(&target)
			.to_lowercase();
		match self.wiki_by_stem.get(&wanted) {
			Some(Some(path)) => Some(path.clone()),
			Some(None) => None,
			None => self.wiki_by_alias.get(&wanted).and_then(|path| path.clone()),
		}
	}
}

impl Workspace {
	pub fn build_link_index(&self) -> Result<LinkIndex, WorkspaceError> {
		LinkIndex::build(self)
	}

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
		let mut files = scan::markdown_files(&self.root).map_err(WorkspaceError::Io)?;
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
				let wiki_match = extract_links(line).into_iter().any(|(raw_target, _)| {
					self.resolve_wiki_target(&source_relative, &raw_target)
						.ok()
						.flatten()
						.as_deref()
						== Some(target_relative.as_str())
				});
				let markdown_match = extract_markdown_targets(line).into_iter().any(|raw_target| {
					self.resolve_markdown_target(&source_relative, raw_target)
						.ok()
						.flatten()
						.as_deref()
						== Some(target_relative.as_str())
				});
				let matched = wiki_match || markdown_match;
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

	pub fn move_document_with_wiki_links(
		&self,
		from_relative_path: &str,
		to_relative_path: &str,
		expected_revision: &str,
	) -> Result<DocumentMove, WorkspaceError> {
		let source_document = self.read_document(from_relative_path)?;
		if source_document.revision != expected_revision {
			return Err(WorkspaceError::Conflict(from_relative_path.to_string()));
		}

		let plans = self.plan_wiki_link_move(from_relative_path, to_relative_path)?;
		let updated_links = plans
			.iter()
			.map(|plan| {
				if plan.source_path == from_relative_path {
					to_relative_path.to_string()
				}else{
					plan.source_path.clone()
				}
			})
			.collect::<Vec<_>>();
		let moved = self.move_document(from_relative_path, to_relative_path, Some(expected_revision))?;
		let mut applied: Vec<(String, String, String)> = Vec::new();

		for plan in plans {
			let effective_path = if plan.source_path == from_relative_path {
				to_relative_path.to_string()
			}else{
				plan.source_path.clone()
			};
			let expected = if plan.source_path == from_relative_path {
				moved.revision.clone()
			}else{
				plan.revision.clone()
			};
			match self.save_document(&effective_path, &plan.updated_content, &expected) {
				Ok(saved) => applied.push((effective_path, plan.original_content, saved.revision)),
				Err(error) => {
					for (path, original_content, revision) in applied.into_iter().rev() {
						let _ = self.save_document(&path, &original_content, &revision);
					}
					let current_moved = self.read_document(to_relative_path).ok();
					if let Some(current_moved) = current_moved {
						if current_moved.content != source_document.content {
							let _ = self.save_document(to_relative_path, &source_document.content, &current_moved.revision);
						}
					}
					let _ = self.move_document(to_relative_path, from_relative_path, None);
					return Err(error);
				}
			}
		}

		let document = self.read_document(to_relative_path)?;
		Ok(DocumentMove { document, updated_links })
	}

	fn plan_wiki_link_move(&self, from_relative_path: &str, to_relative_path: &str) -> Result<Vec<LinkRewritePlan>, WorkspaceError> {
		let from = self.document_path(from_relative_path)?;
		let from_relative = portable_path(
			from.strip_prefix(&self.root)
				.map_err(|_| WorkspaceError::InvalidRelativePath(from.display().to_string()))?,
		);
		let replacement = wiki_target_for_path(to_relative_path);
		let mut files = scan::markdown_files(&self.root).map_err(WorkspaceError::Io)?;
		files.sort();

		let mut plans = Vec::new();
		for source in files {
			let source_relative = portable_path(
				source.strip_prefix(&self.root)
					.map_err(|_| WorkspaceError::InvalidRelativePath(source.display().to_string()))?,
			);
			let document = self.read_document(&source_relative)?;
			let mut changed = false;
			let mut in_fence = false;
			let mut output = String::with_capacity(document.content.len());
			for chunk in document.content.split_inclusive('\n') {
				let (line, ending) = chunk.strip_suffix('\n').map(|line| (line, "\n")).unwrap_or((chunk, ""));
				if is_fence(line) {
					in_fence = !in_fence;
					output.push_str(line);
					output.push_str(ending);
					continue;
				}
				if in_fence {
					output.push_str(line);
					output.push_str(ending);
					continue;
				}
				let source_is_moved = source_relative == from_relative_path;
				let wiki_rewritten = rewrite_wiki_links_in_line(line, |raw_target| {
					let resolved = self.resolve_wiki_target(&source_relative, raw_target).ok().flatten();
					if resolved.as_deref() == Some(from_relative.as_str()) {
						if source_is_moved && (raw_target.contains('/') || raw_target.starts_with('.')) {
							return Some(wiki_link_target(to_relative_path, to_relative_path));
						}
						return Some(replacement.clone());
					}
					if source_is_moved && (raw_target.contains('/') || raw_target.starts_with('.')) {
						if let Some(resolved) = resolved {
							return Some(wiki_link_target(to_relative_path, &resolved));
						}
					}
					None
				});
				let effective_source = if source_is_moved {
					to_relative_path
				}else{
					&source_relative
				};
				let rewritten = rewrite_markdown_links_in_line(&wiki_rewritten, |raw_target| {
					let markdown_target = self.resolve_markdown_target(&source_relative, raw_target).ok().flatten();
					if markdown_target.as_deref() == Some(from_relative.as_str()) {
						return Some(markdown_link_target(effective_source, to_relative_path, raw_target));
					}
					if source_is_moved {
						if let Some(local_target) = self.resolve_local_file_target(&source_relative, raw_target, true).ok().flatten() {
							let final_target = if local_target == from_relative {
								to_relative_path
							}else{
								local_target.as_str()
							};
							return Some(markdown_link_target(to_relative_path, final_target, raw_target));
						}
					}
					None
				});
				changed |= rewritten != line;
				output.push_str(&rewritten);
				output.push_str(ending);
			}
			if changed {
				plans.push(LinkRewritePlan {
					source_path: source_relative,
					revision: document.revision,
					original_content: document.content,
					updated_content: output,
				});
			}
		}
		Ok(plans)
	}

	pub fn resolve_markdown_target(&self, source_relative_path: &str, raw_target: &str) -> Result<Option<String>, WorkspaceError> {
		let Some(relative_path) = self.resolve_local_file_target(source_relative_path, raw_target, true)? else {
			return Ok(None);
		};
		if !has_markdown_extension(Path::new(&relative_path)) {
			return Ok(None);
		}
		Ok(Some(relative_path))
	}

	fn resolve_local_file_target(
		&self,
		source_relative_path: &str,
		raw_target: &str,
		markdown_fallback: bool,
	) -> Result<Option<String>, WorkspaceError> {
		let encoded_target = raw_target
			.split('#')
			.next()
			.unwrap_or("")
			.split('?')
			.next()
			.unwrap_or("")
			.trim();
		let target = decode_percent_path(encoded_target).replace('\\', "/");
		if target.is_empty() {
			return Ok(Some(source_relative_path.to_string()));
		}
		if target.starts_with('/') || target.starts_with("//") || target.contains("://") {
			return Ok(None);
		}
		let first_segment = target.split('/').next().unwrap_or("");
		if first_segment.contains(':') {
			return Ok(None);
		}

		let source = self.document_path(source_relative_path)?;
		let parent = source
			.parent()
			.ok_or_else(|| WorkspaceError::InvalidRelativePath(source_relative_path.to_string()))?;
		let relative = Path::new(&target);
		if relative.is_absolute() {
			return Ok(None);
		}
		let mut candidate = parent.join(relative);
		if markdown_fallback && !candidate.exists() && candidate.extension().is_none() {
			candidate.set_extension("md");
		}
		if !candidate.exists() {
			return Ok(None);
		}
		let canonical = fs::canonicalize(candidate)?;
		if !canonical.starts_with(&self.root) || !canonical.is_file() {
			return Ok(None);
		}
		Ok(Some(portable_path(
			canonical
				.strip_prefix(&self.root)
				.map_err(|_| WorkspaceError::InvalidRelativePath(raw_target.to_string()))?,
		)))
	}

	pub fn resolve_wiki_target(&self, source_relative_path: &str, raw_target: &str) -> Result<Option<String>, WorkspaceError> {
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
		let mut files = scan::markdown_files(&self.root).map_err(WorkspaceError::Io)?;
		files.sort();

		let stem_matches = files
			.iter()
			.filter(|file| {
				file.file_stem()
					.and_then(|stem| stem.to_str())
					.is_some_and(|stem| stem.to_lowercase() == wanted)
			})
			.map(|file| {
				file.strip_prefix(&self.root)
					.map(portable_path)
					.map_err(|_| WorkspaceError::InvalidRelativePath(raw_target.to_string()))
			})
			.collect::<Result<Vec<_>, _>>()?;
		if stem_matches.len() == 1 {
			return Ok(stem_matches.into_iter().next());
		}
		if stem_matches.len() > 1 {
			return Ok(None);
		}

		let mut alias_matches = Vec::new();
		for file in files {
			let content = match fs::read_to_string(&file) {
				Ok(content) => content,
				Err(error) if error.kind() == std::io::ErrorKind::InvalidData => continue,
				Err(error) => return Err(WorkspaceError::Io(error)),
			};
			if extract_frontmatter_aliases(&content)
				.iter()
				.any(|alias| alias.to_lowercase() == wanted)
			{
				alias_matches.push(portable_path(
					file.strip_prefix(&self.root)
						.map_err(|_| WorkspaceError::InvalidRelativePath(raw_target.to_string()))?,
				));
				if alias_matches.len() > 1 {
					return Ok(None);
				}
			}
		}
		Ok(alias_matches.into_iter().next())
	}
}

struct LinkRewritePlan {
	source_path: String,
	revision: String,
	original_content: String,
	updated_content: String,
}

fn wiki_target_without_heading(raw_target: &str) -> Option<String> {
	let target = raw_target
		.split('#')
		.next()
		.unwrap_or("")
		.trim()
		.replace('\\', "/");
	(!target.is_empty()).then_some(target)
}

fn resolve_indexed_wiki_target(
	workspace: &Workspace,
	source_relative_path: &str,
	raw_target: &str,
	wiki_by_stem: &HashMap<String, Option<String>>,
	wiki_by_alias: &HashMap<String, Option<String>>,
) -> Option<String> {
	let target = wiki_target_without_heading(raw_target)?;
	if target.contains('/') || target.starts_with('.') {
		return workspace.resolve_wiki_target(source_relative_path, raw_target).ok().flatten();
	}
	let wanted = Path::new(&target)
		.file_stem()
		.and_then(|stem| stem.to_str())
		.unwrap_or(&target)
		.to_lowercase();
	match wiki_by_stem.get(&wanted) {
		Some(Some(path)) => Some(path.clone()),
		Some(None) => None,
		None => wiki_by_alias.get(&wanted).and_then(|path| path.clone()),
	}
}

fn insert_unique_target(map: &mut HashMap<String, Option<String>>, key: String, relative_path: &str) {
	use std::collections::hash_map::Entry;
	match map.entry(key) {
		Entry::Vacant(entry) => {
			entry.insert(Some(relative_path.to_string()));
		}
		Entry::Occupied(mut entry) => {
			if entry.get().as_deref() != Some(relative_path) {
				entry.insert(None);
			}
		}
	}
}

fn build_stem_map<'a>(documents: impl Iterator<Item = &'a String>) -> HashMap<String, Option<String>> {
	let mut stems = HashMap::new();
	for relative_path in documents {
		let stem = Path::new(relative_path)
			.file_stem()
			.and_then(|value| value.to_str())
			.unwrap_or("")
			.to_lowercase();
		if !stem.is_empty() {
			insert_unique_target(&mut stems, stem, relative_path);
		}
	}
	stems
}

fn build_alias_map(aliases_by_document: &BTreeMap<String, Vec<String>>) -> HashMap<String, Option<String>> {
	let mut aliases = HashMap::new();
	for (relative_path, document_aliases) in aliases_by_document {
		for alias in document_aliases {
			let key = alias.to_lowercase();
			if !key.is_empty() {
				insert_unique_target(&mut aliases, key, relative_path);
			}
		}
	}
	aliases
}

fn frontmatter_end(content: &str) -> Option<usize> {
	if !content.starts_with("---\n") && !content.starts_with("---\r\n") {
		return None;
	}
	let mut offset = 0usize;
	for (index, line) in content.split_inclusive('\n').enumerate() {
		offset += line.len();
		if index == 0 {
			continue;
		}
		let trimmed = line.trim_end_matches(['\r', '\n']);
		if trimmed == "---" || trimmed == "..." {
			return Some(offset);
		}
	}
	None
}

fn extract_frontmatter_aliases(content: &str) -> Vec<String> {
	let Some(end) = frontmatter_end(content) else { return Vec::new(); };
	let header = &content[..end];
	let mut aliases = Vec::new();
	let mut collecting_list = false;
	for line in header.lines().skip(1) {
		let trimmed = line.trim();
		if trimmed == "---" || trimmed == "..." {
			break;
		}
		if collecting_list {
			if let Some(value) = trimmed.strip_prefix("- ") {
				push_frontmatter_alias(&mut aliases, value);
				continue;
			}
			if trimmed.is_empty() {
				continue;
			}
			collecting_list = false;
		}
		let Some((key, value)) = trimmed.split_once(':') else { continue; };
		if !key.eq_ignore_ascii_case("aliases") && !key.eq_ignore_ascii_case("alias") {
			continue;
		}
		let value = value.trim();
		if value.is_empty() {
			collecting_list = true;
			continue;
		}
		if value.starts_with('[') && value.ends_with(']') {
			for item in split_inline_yaml_list(&value[1..value.len() - 1]) {
				push_frontmatter_alias(&mut aliases, &item);
			}
		}else{
			push_frontmatter_alias(&mut aliases, value);
		}
	}
	aliases
}

fn split_inline_yaml_list(value: &str) -> Vec<String> {
	let mut items = Vec::new();
	let mut current = String::new();
	let mut quote: Option<char> = None;
	let mut escaped = false;
	for ch in value.chars() {
		if escaped {
			current.push(ch);
			escaped = false;
			continue;
		}
		if ch == '\\' && quote == Some('"') {
			current.push(ch);
			escaped = true;
			continue;
		}
		if matches!(ch, '"' | '\'') {
			if quote == Some(ch) {
				quote = None;
			}else if quote.is_none() {
				quote = Some(ch);
			}
			current.push(ch);
			continue;
		}
		if ch == ',' && quote.is_none() {
			items.push(current.trim().to_string());
			current.clear();
		}else{
			current.push(ch);
		}
	}
	if !current.trim().is_empty() {
		items.push(current.trim().to_string());
	}
	items
}

fn push_frontmatter_alias(aliases: &mut Vec<String>, value: &str) {
	let alias = value
		.trim()
		.trim_matches(|ch| matches!(ch, '"' | '\''))
		.trim();
	if !alias.is_empty() {
		aliases.push(alias.to_string());
	}
}

fn wiki_target_for_path(relative_path: &str) -> String {
	let path = Path::new(relative_path);
	let without_extension = path.with_extension("");
	portable_path(&without_extension)
}

fn rewrite_wiki_links_in_line(
	line: &str,
	mut replacement_for: impl FnMut(&str) -> Option<String>,
) -> String {
	let mut output = String::with_capacity(line.len());
	let mut rest = line;
	while let Some(start) = rest.find("[[") {
		output.push_str(&rest[..start + 2]);
		let after_start = &rest[start + 2..];
		let Some(end) = after_start.find("]]") else {
			output.push_str(after_start);
			return output;
		};
		let body = &after_start[..end];
		let mut alias_split = body.splitn(2, '|');
		let target_and_heading = alias_split.next().unwrap_or("");
		let alias = alias_split.next();
		let mut heading_split = target_and_heading.splitn(2, '#');
		let raw_target = heading_split.next().unwrap_or("").trim();
		let heading = heading_split.next();
		if let Some(replacement) = replacement_for(raw_target) {
			output.push_str(&replacement);
			if let Some(heading) = heading {
				output.push('#');
				output.push_str(heading);
			}
			if let Some(alias) = alias {
				output.push('|');
				output.push_str(alias);
			}
		}else{
			output.push_str(body);
		}
		output.push_str("]]");
		rest = &after_start[end + 2..];
	}
	output.push_str(rest);
	output
}

fn wiki_link_target(source_relative_path: &str, target_relative_path: &str) -> String {
	let source_parent = Path::new(source_relative_path).parent().unwrap_or_else(|| Path::new(""));
	let target = Path::new(target_relative_path);
	let relative = relative_path(source_parent, target);
	let without_extension = if has_markdown_extension(&relative) {
		relative.with_extension("")
	}else{
		relative
	};
	portable_path(&without_extension)
}

fn markdown_link_target(source_relative_path: &str, target_relative_path: &str, original_target: &str) -> String {
	let source_parent = Path::new(source_relative_path).parent().unwrap_or_else(|| Path::new(""));
	let target = Path::new(target_relative_path);
	let relative = relative_path(source_parent, target);
	let encoded = encode_markdown_path(&portable_path(&relative));
	let suffix_start = original_target
		.char_indices()
		.find_map(|(index, ch)| matches!(ch, '?' | '#').then_some(index))
		.unwrap_or(original_target.len());
	format!("{}{}", encoded, &original_target[suffix_start..])
}

fn relative_path(from_directory: &Path, to_path: &Path) -> PathBuf {
	let from = from_directory.components().filter_map(normal_component).collect::<Vec<_>>();
	let to = to_path.components().filter_map(normal_component).collect::<Vec<_>>();
	let mut common = 0usize;
	while common < from.len() && common < to.len() && from[common] == to[common] {
		common += 1;
	}
	let mut result = PathBuf::new();
	for _ in common..from.len() {
		result.push("..");
	}
	for component in &to[common..] {
		result.push(component);
	}
	if result.as_os_str().is_empty() {
		result.push(".");
	}
	result
}

fn normal_component(component: Component<'_>) -> Option<std::ffi::OsString> {
	match component {
		Component::Normal(value) => Some(value.to_os_string()),
		_ => None,
	}
}

fn encode_markdown_path(value: &str) -> String {
	let mut encoded = String::new();
	for byte in value.as_bytes() {
		if byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b'.' | b'~' | b'/') {
			encoded.push(*byte as char);
		}else{
			encoded.push_str(&format!("%{byte:02X}"));
		}
	}
	encoded
}

fn decode_percent_path(value: &str) -> String {
	let bytes = value.as_bytes();
	let mut decoded = Vec::with_capacity(bytes.len());
	let mut index = 0usize;
	while index < bytes.len() {
		if bytes[index] == b'%' && index + 2 < bytes.len() {
			if let (Some(high), Some(low)) = (hex_value(bytes[index + 1]), hex_value(bytes[index + 2])) {
				decoded.push((high << 4) | low);
				index += 3;
				continue;
			}
		}
		decoded.push(bytes[index]);
		index += 1;
	}
	String::from_utf8(decoded).unwrap_or_else(|_| value.to_string())
}

fn hex_value(value: u8) -> Option<u8> {
	match value {
		b'0'..=b'9' => Some(value - b'0'),
		b'a'..=b'f' => Some(value - b'a' + 10),
		b'A'..=b'F' => Some(value - b'A' + 10),
		_ => None,
	}
}

fn markdown_destination_range(line: &str, after_open: usize) -> Option<(usize, usize)> {
	let bytes = line.as_bytes();
	let mut start = after_open;
	while start < bytes.len() && bytes[start].is_ascii_whitespace() {
		start += 1;
	}
	if start >= bytes.len() {
		return None;
	}
	if bytes[start] == b'<' {
		let mut index = start + 1;
		while index < bytes.len() {
			if bytes[index] == b'>' && (index == 0 || bytes[index - 1] != b'\\') {
				return Some((start + 1, index));
			}
			index += 1;
		}
		return None;
	}

	let mut depth = 0usize;
	let mut index = start;
	while index < bytes.len() {
		match bytes[index] {
			b'\\' => index = (index + 2).min(bytes.len()),
			b'(' => {
				depth += 1;
				index += 1;
			}
			b')' if depth == 0 => return Some((start, index)),
			b')' => {
				depth -= 1;
				index += 1;
			}
			value if value.is_ascii_whitespace() && depth == 0 => return Some((start, index)),
			_ => index += 1,
		}
	}
	None
}

fn extract_markdown_targets(line: &str) -> Vec<&str> {
	let mut targets = Vec::new();
	let mut search_from = 0usize;
	while search_from < line.len() {
		let Some(relative_end) = line[search_from..].find("](") else { break; };
		let label_end = search_from + relative_end;
		let label_start = line[..label_end].rfind('[');
		let is_image = label_start.is_some_and(|start| start > 0 && line.as_bytes()[start - 1] == b'!');
		if !is_image {
			if let Some((start, end)) = markdown_destination_range(line, label_end + 2) {
				if start < end {
					targets.push(&line[start..end]);
				}
			}
		}
		search_from = label_end + 2;
	}
	targets
}

fn rewrite_markdown_links_in_line(
	line: &str,
	mut replacement_for: impl FnMut(&str) -> Option<String>,
) -> String {
	let mut replacements: Vec<(usize, usize, String)> = Vec::new();
	let mut search_from = 0usize;
	while search_from < line.len() {
		let Some(relative_end) = line[search_from..].find("](") else { break; };
		let label_end = search_from + relative_end;
		if let Some((start, end)) = markdown_destination_range(line, label_end + 2) {
			let target = &line[start..end];
			if let Some(replacement) = replacement_for(target) {
				replacements.push((start, end, replacement));
			}
		}
		search_from = label_end + 2;
	}
	if replacements.is_empty() {
		return line.to_string();
	}
	let mut output = line.to_string();
	for (start, end, replacement) in replacements.into_iter().rev() {
		output.replace_range(start..end, &replacement);
	}
	output
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
	fn link_index_resolves_bare_wiki_links_and_backlinks() {
		let temp = tempfile::tempdir().unwrap();
		fs::create_dir_all(temp.path().join("notes")).unwrap();
		fs::write(temp.path().join("notes").join("Target.md"), "# Target").unwrap();
		fs::write(
			temp.path().join("Source.md"),
			"[[Target]] and [target](notes/Target.md)\n~~~md\n[[Target]]\n~~~\n",
		).unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();

		let index = workspace.build_link_index().unwrap();

		assert_eq!(index.document_count(), 2);
		assert_eq!(index.resolve_bare_wiki_target("Target#Heading").as_deref(), Some("notes/Target.md"));
		let backlinks = index.backlinks("notes/Target.md");
		assert_eq!(backlinks.len(), 1);
		assert_eq!(backlinks[0].source_path, "Source.md");
		assert_eq!(backlinks[0].line, 1);
	}

	#[test]
	fn link_index_rejects_duplicate_stems() {
		let temp = tempfile::tempdir().unwrap();
		fs::create_dir_all(temp.path().join("a")).unwrap();
		fs::create_dir_all(temp.path().join("z")).unwrap();
		fs::write(temp.path().join("a").join("Same.md"), "a").unwrap();
		fs::write(temp.path().join("z").join("Same.md"), "z").unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();

		let index = workspace.build_link_index().unwrap();

		assert_eq!(index.resolve_bare_wiki_target("Same"), None);
	}

	#[test]
	fn link_index_can_refresh_one_document() {
		let temp = tempfile::tempdir().unwrap();
		fs::write(temp.path().join("A.md"), "[target](B.md)").unwrap();
		fs::write(temp.path().join("B.md"), "# B").unwrap();
		fs::write(temp.path().join("C.md"), "# C").unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();
		let mut index = workspace.build_link_index().unwrap();
		assert_eq!(index.backlinks("B.md").len(), 1);

		fs::write(temp.path().join("A.md"), "[target](C.md)").unwrap();
		index.refresh_document(&workspace, "A.md").unwrap();

		assert!(index.backlinks("B.md").is_empty());
		assert_eq!(index.backlinks("C.md").len(), 1);
	}

	#[test]
	fn link_graph_deduplicates_edges_and_keeps_unlinked_documents() {
		let temp = tempfile::tempdir().unwrap();
		fs::write(temp.path().join("A.md"), "[[B]]\n[[B]]\n").unwrap();
		fs::write(temp.path().join("B.md"), "# B").unwrap();
		fs::write(temp.path().join("C.md"), "# C").unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();
		let index = workspace.build_link_index().unwrap();

		let graph = index.graph();

		assert_eq!(graph.nodes.len(), 3);
		assert_eq!(graph.edges, vec![GraphEdge { source: "A.md".to_string(), target: "B.md".to_string() }]);
		let a = graph.nodes.iter().find(|node| node.path == "A.md").unwrap();
		let b = graph.nodes.iter().find(|node| node.path == "B.md").unwrap();
		let c = graph.nodes.iter().find(|node| node.path == "C.md").unwrap();
		assert_eq!((a.incoming, a.outgoing), (0, 1));
		assert_eq!((b.incoming, b.outgoing), (1, 0));
		assert_eq!((c.incoming, c.outgoing), (0, 0));
	}

	#[test]
	fn markdown_target_resolves_relative_document_and_rejects_escape() {
		let temp = tempfile::tempdir().unwrap();
		let workspace_root = temp.path().join("workspace");
		fs::create_dir_all(workspace_root.join("notes").join("nested")).unwrap();
		fs::write(workspace_root.join("notes").join("Target.md"), "# Target").unwrap();
		fs::write(workspace_root.join("notes").join("nested").join("Source.md"), "[Target](../Target.md)").unwrap();
		fs::write(temp.path().join("outside.md"), "# Outside").unwrap();
		let workspace = Workspace::open(&workspace_root).unwrap();

		assert_eq!(
			workspace.resolve_markdown_target("notes/nested/Source.md", "../Target.md#Heading").unwrap().as_deref(),
			Some("notes/Target.md")
		);
		assert_eq!(
			workspace.resolve_markdown_target("notes/nested/Source.md", "../../../outside.md").unwrap(),
			None
		);
	}

	#[test]
	fn wiki_links_resolve_frontmatter_aliases_with_filename_priority() {
		let temp = tempfile::tempdir().unwrap();
		fs::write(
			temp.path().join("Canonical.md"),
			"---\naliases:\n  - Friendly Name\n  - Other Alias\n---\n# Canonical\n",
		).unwrap();
		fs::write(
			temp.path().join("Inline.md"),
			"---\naliases: [\"Inline Alias\", 'Alias, With Comma']\n---\n",
		).unwrap();
		fs::write(temp.path().join("Friendly Name.md"), "# Filename wins").unwrap();
		fs::write(
			temp.path().join("Source.md"),
			"[[Friendly Name]] [[Other Alias]] [[Inline Alias]] [[Alias, With Comma]]",
		).unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();
		let index = workspace.build_link_index().unwrap();

		assert_eq!(index.resolve_bare_wiki_target("Friendly Name").as_deref(), Some("Friendly Name.md"));
		assert_eq!(index.resolve_bare_wiki_target("Other Alias").as_deref(), Some("Canonical.md"));
		assert_eq!(index.resolve_bare_wiki_target("Inline Alias").as_deref(), Some("Inline.md"));
		assert_eq!(index.resolve_bare_wiki_target("Alias, With Comma").as_deref(), Some("Inline.md"));
		assert_eq!(
			workspace.resolve_wiki_target("Source.md", "Other Alias").unwrap().as_deref(),
			Some("Canonical.md")
		);
	}

	#[test]
	fn link_index_refresh_updates_frontmatter_aliases() {
		let temp = tempfile::tempdir().unwrap();
		fs::write(temp.path().join("Target.md"), "---\nalias: Old Alias\n---\n").unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();
		let mut index = workspace.build_link_index().unwrap();
		assert_eq!(index.resolve_bare_wiki_target("Old Alias").as_deref(), Some("Target.md"));

		fs::write(temp.path().join("Target.md"), "---\nalias: New Alias\n---\n").unwrap();
		index.refresh_document(&workspace, "Target.md").unwrap();

		assert_eq!(index.resolve_bare_wiki_target("Old Alias"), None);
		assert_eq!(index.resolve_bare_wiki_target("New Alias").as_deref(), Some("Target.md"));
	}

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
	fn moving_document_updates_resolved_wiki_links() {
		let temp = tempfile::tempdir().unwrap();
		fs::create_dir_all(temp.path().join("notes")).unwrap();
		fs::create_dir_all(temp.path().join("archive")).unwrap();
		fs::write(temp.path().join("notes").join("Target.md"), "# Target").unwrap();
		fs::write(
			temp.path().join("Source.md"),
			"[[notes/Target|label]] [[notes/Target#Heading]]\n~~~md\n[[notes/Target]]\n~~~\n",
		).unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();
		let target = workspace.read_document("notes/Target.md").unwrap();

		let moved = workspace
			.move_document_with_wiki_links("notes/Target.md", "archive/Renamed.md", &target.revision)
			.unwrap();

		assert_eq!(moved.document.relative_path, "archive/Renamed.md");
		let source = fs::read_to_string(temp.path().join("Source.md")).unwrap();
		assert!(source.contains("[[archive/Renamed|label]]"));
		assert!(source.contains("[[archive/Renamed#Heading]]"));
		assert!(source.contains("~~~md\n[[notes/Target]]\n~~~"));
	}

	#[test]
	fn moving_document_updates_standard_markdown_links() {
		let temp = tempfile::tempdir().unwrap();
		fs::create_dir_all(temp.path().join("notes")).unwrap();
		fs::create_dir_all(temp.path().join("archive")).unwrap();
		fs::create_dir_all(temp.path().join("references")).unwrap();
		fs::write(temp.path().join("notes").join("Target File.md"), "# Target").unwrap();
		fs::write(
			temp.path().join("references").join("Source.md"),
			"[target](../notes/Target%20File.md?view=1#Heading)\n![image](../notes/Target%20File.md)\n",
		).unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();
		let target = workspace.read_document("notes/Target File.md").unwrap();

		let moved = workspace
			.move_document_with_wiki_links("notes/Target File.md", "archive/Renamed File.md", &target.revision)
			.unwrap();

		assert_eq!(moved.document.relative_path, "archive/Renamed File.md");
		let source = fs::read_to_string(temp.path().join("references").join("Source.md")).unwrap();
		assert!(source.contains("[target](../archive/Renamed%20File.md?view=1#Heading)"));
		assert!(source.contains("![image](../archive/Renamed%20File.md)"));
	}

	#[test]
	fn moving_document_preserves_its_outbound_relative_links_and_assets() {
		let temp = tempfile::tempdir().unwrap();
		fs::create_dir_all(temp.path().join("notes").join("_assets")).unwrap();
		fs::create_dir_all(temp.path().join("archive")).unwrap();
		fs::write(
			temp.path().join("notes").join("Moved.md"),
			"# Moved\n[other](Other.md#Section)\n![img](_assets/p.png)\n[[./Other#Section]]\n",
		).unwrap();
		fs::write(temp.path().join("notes").join("Other.md"), "# Other").unwrap();
		fs::write(temp.path().join("notes").join("_assets").join("p.png"), b"png").unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();
		let moved = workspace.read_document("notes/Moved.md").unwrap();

		let result = workspace
			.move_document_with_wiki_links("notes/Moved.md", "archive/Moved.md", &moved.revision)
			.unwrap();

		assert_eq!(result.document.relative_path, "archive/Moved.md");
		let content = fs::read_to_string(temp.path().join("archive").join("Moved.md")).unwrap();
		assert!(content.contains("[other](../notes/Other.md#Section)"));
		assert!(content.contains("![img](../notes/_assets/p.png)"));
		assert!(content.contains("[[../notes/Other#Section]]"));
	}

	#[test]
	fn backlinks_include_standard_markdown_links() {
		let temp = tempfile::tempdir().unwrap();
		fs::create_dir_all(temp.path().join("notes")).unwrap();
		fs::write(temp.path().join("notes").join("Target.md"), "# Target").unwrap();
		fs::write(temp.path().join("Source.md"), "[target](notes/Target.md)").unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();

		let backlinks = workspace.backlinks("notes/Target.md").unwrap();

		assert_eq!(backlinks.len(), 1);
		assert_eq!(backlinks[0].source_path, "Source.md");
	}

	#[test]
	fn ambiguous_bare_wiki_link_is_not_resolved() {
		let temp = tempfile::tempdir().unwrap();
		fs::create_dir_all(temp.path().join("a")).unwrap();
		fs::create_dir_all(temp.path().join("b")).unwrap();
		fs::write(temp.path().join("a").join("Target.md"), "# A").unwrap();
		fs::write(temp.path().join("b").join("Target.md"), "# B").unwrap();
		fs::write(temp.path().join("Source.md"), "[[Target]] [[a/Target]]").unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();
		let index = workspace.build_link_index().unwrap();

		assert_eq!(workspace.resolve_wiki_target("Source.md", "Target").unwrap(), None);
		assert_eq!(index.resolve_bare_wiki_target("Target"), None);
		assert_eq!(
			workspace.resolve_wiki_target("Source.md", "a/Target").unwrap().as_deref(),
			Some("a/Target.md")
		);
	}

	#[test]
	fn ambiguous_frontmatter_alias_is_not_resolved() {
		let temp = tempfile::tempdir().unwrap();
		fs::write(temp.path().join("A.md"), "---\naliases: [Shared]\n---\nA").unwrap();
		fs::write(temp.path().join("B.md"), "---\nalias: Shared\n---\nB").unwrap();
		fs::write(temp.path().join("Source.md"), "[[Shared]]").unwrap();
		let workspace = Workspace::open(temp.path()).unwrap();
		let index = workspace.build_link_index().unwrap();

		assert_eq!(workspace.resolve_wiki_target("Source.md", "Shared").unwrap(), None);
		assert_eq!(index.resolve_bare_wiki_target("Shared"), None);
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
