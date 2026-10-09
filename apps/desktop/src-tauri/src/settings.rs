use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum DockNode {
	Pane { id: String },
	Split { axis: String, ratio: f64, first: Box<DockNode>, second: Box<DockNode> },
}

fn default_dock_tree() -> DockNode {
	DockNode::Split {
		axis: "row".into(),
		ratio: 0.23,
		first: Box::new(DockNode::Pane { id: "explorer".into() }),
		second: Box::new(DockNode::Split {
			axis: "row".into(),
			ratio: 0.5,
			first: Box::new(DockNode::Pane { id: "editor".into() }),
			second: Box::new(DockNode::Pane { id: "right".into() }),
		}),
	}
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutPreset {
	pub name: String,
	pub explorer_width: f64,
	pub editor_ratio: f64,
	pub explorer_visible: bool,
	pub right_pane_visible: bool,
	pub explorer_mode: String,
	pub right_pane_mode: String,
	#[serde(default)]
	pub dock_tree: Option<DockNode>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MacroDefinition {
	pub name: String,
	pub steps: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DesktopSettings {
	pub explorer_width: f64,
	pub editor_ratio: f64,
	pub explorer_visible: bool,
	pub right_pane_visible: bool,
	pub last_workspace: Option<String>,
	pub recent_workspaces: Vec<String>,
	pub last_document: Option<String>,
	pub open_documents: Vec<String>,
	pub document_auto_save_enabled: bool,
	pub document_auto_save_delay_ms: u64,
	pub auto_snapshot_enabled: bool,
	pub auto_snapshot_delay_seconds: u64,
	pub history_retention_snapshots: usize,
	pub template_directory: String,
	pub layout_presets: Vec<LayoutPreset>,
	pub macros: Vec<MacroDefinition>,
	pub sidebar_commands: Vec<String>,
	pub dock_order: Vec<String>,
	pub dock_direction: String,
	pub dock_tree: DockNode,
	pub daily_notes_directory: String,
	pub daily_note_template: String,
	pub last_right_pane: String,
	pub last_browser_url: Option<String>,
}

impl Default for DesktopSettings {
	fn default() -> Self {
		Self {
			explorer_width: 260.0,
			editor_ratio: 0.5,
			explorer_visible: true,
			right_pane_visible: true,
			last_workspace: None,
			recent_workspaces: Vec::new(),
			last_document: None,
			open_documents: Vec::new(),
			document_auto_save_enabled: true,
			document_auto_save_delay_ms: 1000,
			auto_snapshot_enabled: true,
			auto_snapshot_delay_seconds: 5,
			history_retention_snapshots: 200,
			template_directory: "Templates".to_string(),
			layout_presets: Vec::new(),
			macros: Vec::new(),
			dock_order: vec!["explorer".into(), "editor".into(), "right".into()],
			dock_direction: "row".into(),
			dock_tree: default_dock_tree(),
			sidebar_commands: vec![
				"workspace.quickOpen".into(),
				"document.daily.open".into(),
				"pane.preview".into(),
				"pane.browser".into(),
				"pane.graph".into(),
				"history.show".into(),
			],
			daily_notes_directory: "Daily".to_string(),
			daily_note_template: "Templates/Daily.md".to_string(),
			last_right_pane: "preview".to_string(),
			last_browser_url: None,
		}
	}
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
	let directory = app
		.path()
		.app_config_dir()
		.map_err(|error| format!("Failed to resolve Quire config directory: {error}"))?;
	Ok(directory.join("settings.toml"))
}

pub fn load(app: &tauri::AppHandle) -> Result<DesktopSettings, String> {
	let path = settings_path(app)?;
	if !path.exists() {
		return Ok(DesktopSettings::default());
	}
	let content = fs::read_to_string(&path)
		.map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
	toml::from_str(&content)
		.map_err(|error| format!("Failed to parse {}: {error}", path.display()))
}

pub fn save(app: &tauri::AppHandle, settings: &DesktopSettings) -> Result<(), String> {
	let path = settings_path(app)?;
	if let Some(parent) = path.parent() {
		fs::create_dir_all(parent)
			.map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
	}
	let content = toml::to_string_pretty(settings)
		.map_err(|error| format!("Failed to serialize Quire settings: {error}"))?;
	fs::write(&path, content)
		.map_err(|error| format!("Failed to write {}: {error}", path.display()))
}
