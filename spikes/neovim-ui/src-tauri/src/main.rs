use rmpv::Value;
use serde::Serialize;
use std::io::{BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

#[derive(Default)]
struct EditorState {
	process: Mutex<Option<EditorProcess>>,
}

struct EditorProcess {
	child: Child,
	stdin: ChildStdin,
	next_request_id: i64,
}

impl EditorProcess {
	fn send_request(&mut self, method: &str, params: Vec<Value>) -> Result<(), String> {
		let id = self.next_request_id;
		self.next_request_id += 1;
		let request = Value::Array(vec![
			Value::from(0),
			Value::from(id),
			Value::from(method),
			Value::Array(params),
		]);
		rmpv::encode::write_value(&mut self.stdin, &request).map_err(|error| format!("MessagePack write failed: {error}"))?;
		self.stdin.flush().map_err(|error| format!("Neovim stdin flush failed: {error}"))
	}
}

impl Drop for EditorProcess {
	fn drop(&mut self) {
		let _ = self.child.kill();
		let _ = self.child.wait();
	}
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GridCellUpdate {
	text: String,
	hl_id: u64,
	repeat: u64,
}

#[derive(Clone, Serialize)]
struct Highlight {
	foreground: Option<i64>,
	background: Option<i64>,
	special: Option<i64>,
	reverse: bool,
	bold: bool,
	italic: bool,
	underline: bool,
	strikethrough: bool,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum UiEvent {
	GridResize { grid: u64, width: u64, height: u64 },
	GridClear { grid: u64 },
	GridLine { grid: u64, row: u64, #[serde(rename = "colStart")] col_start: u64, cells: Vec<GridCellUpdate>, wrap: bool },
	GridCursorGoto { grid: u64, row: u64, col: u64 },
	GridScroll { grid: u64, top: u64, bot: u64, left: u64, right: u64, rows: i64, cols: i64 },
	DefaultColorsSet { foreground: i64, background: i64, special: i64 },
	HlAttrDefine { id: u64, attrs: Highlight },
	Flush,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum StreamMessage {
	Redraw { events: Vec<UiEvent> },
	Closed { message: String },
}

fn value_u64(value: &Value) -> Option<u64> {
	value.as_u64().or_else(|| value.as_i64().and_then(|value| u64::try_from(value).ok()))
}

fn value_i64(value: &Value) -> Option<i64> {
	value.as_i64().or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
}

fn map_value<'a>(map: &'a [(Value, Value)], key: &str) -> Option<&'a Value> {
	map.iter().find_map(|(map_key, value)| (map_key.as_str() == Some(key)).then_some(value))
}

fn parse_highlight(value: &Value) -> Highlight {
	let map = value.as_map().map(|map| map.as_slice()).unwrap_or(&[]);
	Highlight {
		foreground: map_value(map, "foreground").and_then(value_i64),
		background: map_value(map, "background").and_then(value_i64),
		special: map_value(map, "special").and_then(value_i64),
		reverse: map_value(map, "reverse").and_then(Value::as_bool).unwrap_or(false),
		bold: map_value(map, "bold").and_then(Value::as_bool).unwrap_or(false),
		italic: map_value(map, "italic").and_then(Value::as_bool).unwrap_or(false),
		underline: map_value(map, "underline").and_then(Value::as_bool).unwrap_or(false),
		strikethrough: map_value(map, "strikethrough").and_then(Value::as_bool).unwrap_or(false),
	}
}

fn parse_grid_line(params: &[Value]) -> Option<UiEvent> {
	if(params.len() < 5){ return None; }
	let grid = value_u64(&params[0])?;
	let row = value_u64(&params[1])?;
	let col_start = value_u64(&params[2])?;
	let cells = params[3].as_array()?;
	let wrap = params[4].as_bool().unwrap_or(false);
	let mut hl_id = 0;
	let mut parsed_cells = Vec::with_capacity(cells.len());
	for cell in cells {
		let values = cell.as_array()?;
		let text = values.first()?.as_str()?.to_string();
		if let Some(value) = values.get(1).and_then(value_u64) {
			hl_id = value;
		}
		let repeat = values.get(2).and_then(value_u64).unwrap_or(1);
		parsed_cells.push(GridCellUpdate { text, hl_id, repeat });
	}
	Some(UiEvent::GridLine { grid, row, col_start, cells: parsed_cells, wrap })
}

fn parse_update(name: &str, params: &[Value]) -> Option<UiEvent> {
	match name {
		"grid_resize" if params.len() >= 3 => Some(UiEvent::GridResize {
			grid: value_u64(&params[0])?,
			width: value_u64(&params[1])?,
			height: value_u64(&params[2])?,
		}),
		"grid_clear" if !params.is_empty() => Some(UiEvent::GridClear { grid: value_u64(&params[0])? }),
		"grid_line" => parse_grid_line(params),
		"grid_cursor_goto" if params.len() >= 3 => Some(UiEvent::GridCursorGoto {
			grid: value_u64(&params[0])?,
			row: value_u64(&params[1])?,
			col: value_u64(&params[2])?,
		}),
		"grid_scroll" if params.len() >= 7 => Some(UiEvent::GridScroll {
			grid: value_u64(&params[0])?,
			top: value_u64(&params[1])?,
			bot: value_u64(&params[2])?,
			left: value_u64(&params[3])?,
			right: value_u64(&params[4])?,
			rows: value_i64(&params[5])?,
			cols: value_i64(&params[6])?,
		}),
		"default_colors_set" if params.len() >= 3 => Some(UiEvent::DefaultColorsSet {
			foreground: value_i64(&params[0])?,
			background: value_i64(&params[1])?,
			special: value_i64(&params[2])?,
		}),
		"hl_attr_define" if params.len() >= 2 => Some(UiEvent::HlAttrDefine {
			id: value_u64(&params[0])?,
			attrs: parse_highlight(&params[1]),
		}),
		"flush" => Some(UiEvent::Flush),
		_ => None,
	}
}

fn parse_redraw(value: &Value) -> Option<Vec<UiEvent>> {
	let message = value.as_array()?;
	if(message.len() != 3 || message[0].as_i64() != Some(2) || message[1].as_str() != Some("redraw")){ return None; }
	let updates = message[2].as_array()?;
	let mut events = Vec::new();
	for update in updates {
		let values = match update.as_array() {
			Some(values) if !values.is_empty() => values,
			_ => continue,
		};
		let Some(name) = values[0].as_str() else { continue; };
		for params in &values[1..] {
			let Some(params) = params.as_array() else { continue; };
			if let Some(event) = parse_update(name, params) {
				events.push(event);
			}
		}
	}
	(!events.is_empty()).then_some(events)
}

fn read_neovim(stdout: impl std::io::Read, stream: Channel<StreamMessage>) {
	let mut reader = BufReader::new(stdout);
	loop {
		match rmpv::decode::read_value(&mut reader) {
			Ok(value) => {
				if let Some(events) = parse_redraw(&value) {
					if stream.send(StreamMessage::Redraw { events }).is_err(){ return; }
				}
			}
			Err(error) => {
				let _ = stream.send(StreamMessage::Closed { message: error.to_string() });
				return;
			}
		}
	}
}

fn stop_process(process: &mut EditorProcess) {
	let _ = process.send_request("nvim_command", vec![Value::from("qa!")]);
	let deadline = Instant::now() + Duration::from_secs(1);
	while Instant::now() < deadline {
		match process.child.try_wait() {
			Ok(Some(_)) => return,
			Ok(None) => thread::sleep(Duration::from_millis(20)),
			Err(_) => break,
		}
	}
	let _ = process.child.kill();
	let _ = process.child.wait();
}

#[tauri::command]
fn start_editor(stream: Channel<StreamMessage>, state: tauri::State<'_, EditorState>) -> Result<(), String> {
	let mut slot = state.process.lock().map_err(|_| "Editor state lock failed.".to_string())?;
	if let Some(mut process) = slot.take() {
		stop_process(&mut process);
	}
	let mut child = Command::new("nvim")
		.args(["--embed", "--clean"])
		.stdin(Stdio::piped())
		.stdout(Stdio::piped())
		.stderr(Stdio::inherit())
		.spawn()
		.map_err(|error| format!("nvim --embed failed: {error}"))?;
	let stdin = child.stdin.take().ok_or_else(|| "Neovim stdin is unavailable.".to_string())?;
	let stdout = child.stdout.take().ok_or_else(|| "Neovim stdout is unavailable.".to_string())?;
	let mut process = EditorProcess { child, stdin, next_request_id: 1 };
	thread::spawn(move || read_neovim(stdout, stream));
	let options = Value::Map(vec![
		(Value::from("rgb"), Value::from(true)),
		(Value::from("ext_linegrid"), Value::from(true)),
	]);
	process.send_request("nvim_ui_attach", vec![Value::from(80), Value::from(24), options])?;
	*slot = Some(process);
	Ok(())
}

#[tauri::command]
fn editor_input(text: String, state: tauri::State<'_, EditorState>) -> Result<(), String> {
	let mut slot = state.process.lock().map_err(|_| "Editor state lock failed.".to_string())?;
	let process = slot.as_mut().ok_or_else(|| "Editor is not running.".to_string())?;
	process.send_request("nvim_input", vec![Value::from(text)])
}

#[tauri::command]
fn editor_resize(width: u64, height: u64, state: tauri::State<'_, EditorState>) -> Result<(), String> {
	let mut slot = state.process.lock().map_err(|_| "Editor state lock failed.".to_string())?;
	let process = slot.as_mut().ok_or_else(|| "Editor is not running.".to_string())?;
	process.send_request("nvim_ui_try_resize", vec![Value::from(width), Value::from(height)])
}

#[tauri::command]
fn stop_editor(state: tauri::State<'_, EditorState>) -> Result<(), String> {
	let mut slot = state.process.lock().map_err(|_| "Editor state lock failed.".to_string())?;
	if let Some(mut process) = slot.take() {
		stop_process(&mut process);
	}
	Ok(())
}

fn main() {
	tauri::Builder::default()
		.manage(EditorState::default())
		.invoke_handler(tauri::generate_handler![start_editor, editor_input, editor_resize, stop_editor])
		.run(tauri::generate_context!())
		.expect("failed to run Quire Neovim UI spike");
}
