mod history;
mod links;
mod scan;
mod search;
mod workspace;

pub use history::{HistoryError, HistoryStore, Snapshot};
pub use links::{Backlink, DocumentMove, LinkIndex, WikiLink};
pub use search::{SearchHit, SearchIndex, SearchKind, TagInfo};
pub use workspace::{
	AssetImport,
	Document,
	EntryKind,
	Workspace,
	WorkspaceEntry,
	WorkspaceError,
	WorkspaceInfo,
};


impl Workspace {
	pub fn build_indexes(&self) -> Result<(SearchIndex, LinkIndex), WorkspaceError> {
		let sources = scan::markdown_sources(&self.root).map_err(WorkspaceError::Io)?;
		let search = SearchIndex::from_sources(&sources);
		let links = LinkIndex::from_sources(self, &sources)?;
		Ok((search, links))
	}
}
