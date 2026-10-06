mod search;
mod workspace;

pub use search::{SearchHit, SearchKind};
pub use workspace::{
	Document,
	EntryKind,
	Workspace,
	WorkspaceEntry,
	WorkspaceError,
	WorkspaceInfo,
};
