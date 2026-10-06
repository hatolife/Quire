mod history;
mod links;
mod search;
mod workspace;

pub use history::{HistoryError, HistoryStore, Snapshot};
pub use links::{Backlink, WikiLink};
pub use search::{SearchHit, SearchKind};
pub use workspace::{
	Document,
	EntryKind,
	Workspace,
	WorkspaceEntry,
	WorkspaceError,
	WorkspaceInfo,
};
