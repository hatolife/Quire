use rmpv::Value;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

type PendingResponse = mpsc::Sender<Result<Value, String>>;

#[derive(Default)]
pub struct EditorState {
	process: Mutex<Option<EditorProcess>>,
}

struct EditorProcess {
	child: Child,
	stdin: ChildStdin,
	next_request_id: i64,
	pending: Arc<Mutex<HashMap<i64, PendingResponse>>>,
	relative_path: String,
}

impl EditorProcess {
	fn request(&mut self, method: &str, params: Vec<Value>) -> Result<Value, String> {
		let id = self.next_request_id;
		self.next_request_id += 1;
		let (sender, receiver) = mpsc::channel();
		self.pending
			.lock()
			.map_err(|_| "Neovim pending response lock failed.".to_string())?
			.insert(id, sender);

		let request = Value::Array(vec![
			Value::from(0),
			Value::from(id),
			Value::from(method),
			Value::Array(params),
		]);
		if let Err(error) = rmpv::encode::write_value(&mut self.stdin, &request) {
			let _ = self.pending.lock().map(|mut pending| pending.remove(&id));
			return Err(format!("MessagePack write failed: {error}"));
		}
		if let Err(error) = self.stdin.flush() {
			let _ = self.pending.lock().map(|mut pending| pending.remove(&id));
			return Err(format!("Neovim stdin flush failed: {error}"));
		}

		receiver
			.recv_timeout(Duration::from_secs(5))
			.map_err(|_| format!("Neovim request timed out: {method}"))?
	}

	fn request_no_wait(&mut self, method: &str, params: Vec<Value>) -> Result<(), String> {
		let id = self.next_request_id;
		self.next_request_id += 1;
		let request = Value::Array(vec![
			Value::from(0),
			Value::from(id),
			Value::from(method),
			Value::Array(params),
		]);
		rmpv::encode::write_value(&mut self.stdin, &request)
			.map_err(|error| format!("MessagePack write failed: {error}"))?;
		self.stdin
			.flush()
			.map_err(|error| format!("Neovim stdin flush failed: {error}"))
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
pub struct GridCellUpdate {
	text: String,
	hl_id: u64,
	repeat: u64,
}

#[derive(Clone, Serialize)]
pub struct Highlight {
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
#[serde(rename_all = "camelCase")]
pub struct CursorStyle {
	cursor_shape: Option<String>,
	cell_percentage: Option<u64>,
	attr_id: Option<u64>,
	short_name: Option<String>,
	name: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UiEvent {
	GridResize { grid: u64, width: u64, height: u64 },
	GridClear { grid: u64 },
	GridLine {
		grid: u64,
		row: u64,
		#[serde(rename = "colStart")]
		col_start: u64,
		cells: Vec<GridCellUpdate>,
		wrap: bool,
	},
	GridCursorGoto { grid: u64, row: u64, col: u64 },
	GridScroll {
		grid: u64,
		top: u64,
		bot: u64,
		left: u64,
		right: u64,
		rows: i64,
		cols: i64,
	},
	DefaultColorsSet { foreground: i64, background: i64, special: i64 },
	HlAttrDefine { id: u64, attrs: Highlight },
	ModeInfoSet {
		#[serde(rename = "cursorStyleEnabled")]
		cursor_style_enabled: bool,
		modes: Vec<CursorStyle>,
	},
	ModeChange {
		mode: String,
		#[serde(rename = "modeIdx")]
		mode_idx: u64,
	},
	BusyStart,
	BusyStop,
	Flush,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StreamMessage {
	Redraw { events: Vec<UiEvent> },
	BufferLines {
		first: i64,
		last: i64,
		lines: Vec<String>,
		more: bool,
	},
	Error { message: String },
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

fn parse_cursor_style(value: &Value) -> CursorStyle {
	let map = value.as_map().map(|map| map.as_slice()).unwrap_or(&[]);
	CursorStyle {
		cursor_shape: map_value(map, "cursor_shape").and_then(Value::as_str).map(str::to_string),
		cell_percentage: map_value(map, "cell_percentage").and_then(value_u64),
		attr_id: map_value(map, "attr_id").and_then(value_u64),
		short_name: map_value(map, "short_name").and_then(Value::as_str).map(str::to_string),
		name: map_value(map, "name").and_then(Value::as_str).map(str::to_string),
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
		"mode_info_set" if params.len() >= 2 => Some(UiEvent::ModeInfoSet {
			cursor_style_enabled: params[0].as_bool().unwrap_or(false),
			modes: params[1].as_array()?.iter().map(parse_cursor_style).collect(),
		}),
		"mode_change" if params.len() >= 2 => Some(UiEvent::ModeChange {
			mode: params[0].as_str()?.to_string(),
			mode_idx: value_u64(&params[1])?,
		}),
		"busy_start" => Some(UiEvent::BusyStart),
		"busy_stop" => Some(UiEvent::BusyStop),
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

fn parse_buffer_lines(value: &Value) -> Option<(i64, i64, Vec<String>, bool)> {
	let message = value.as_array()?;
	if(message.len() != 3 || message[0].as_i64() != Some(2) || message[1].as_str() != Some("nvim_buf_lines_event")){ return None; }
	let params = message[2].as_array()?;
	if(params.len() < 6){ return None; }
	let first = value_i64(&params[2])?;
	let last = value_i64(&params[3])?;
	let lines = params[4]
		.as_array()?
		.iter()
		.map(|value| value.as_str().map(str::to_string))
		.collect::<Option<Vec<_>>>()?;
	let more = params[5].as_bool().unwrap_or(false);
	Some((first, last, lines, more))
}

fn parse_error_event(value: &Value) -> Option<String> {
	let message = value.as_array()?;
	if(message.len() != 3 || message[0].as_i64() != Some(2) || message[1].as_str() != Some("nvim_error_event")){ return None; }
	let args = message[2].as_array()?;
	let error_type = args.first().and_then(value_i64).unwrap_or(-1);
	let error_message = args.get(1).and_then(Value::as_str).unwrap_or("Unknown Neovim error.");
	Some(format!("Neovim error {error_type}: {error_message}"))
}

fn handle_response(value: &Value, pending: &Arc<Mutex<HashMap<i64, PendingResponse>>>) -> bool {
	let Some(message) = value.as_array() else { return false; };
	if(message.len() != 4 || message[0].as_i64() != Some(1)){ return false; }
	let Some(id) = value_i64(&message[1]) else { return false; };
	let sender = pending.lock().ok().and_then(|mut pending| pending.remove(&id));
	if let Some(sender) = sender {
		let result = if message[2].is_nil() {
			Ok(message[3].clone())
		}else{
			Err(format!("Neovim RPC error: {:?}", message[2]))
		};
		let _ = sender.send(result);
	}
	true
}

fn read_neovim(
	stdout: impl std::io::Read,
	stream: Channel<StreamMessage>,
	pending: Arc<Mutex<HashMap<i64, PendingResponse>>>,
) {
	let mut reader = BufReader::new(stdout);
	loop {
		match rmpv::decode::read_value(&mut reader) {
			Ok(value) => {
				if handle_response(&value, &pending) {
					continue;
				}
				if let Some(events) = parse_redraw(&value) {
					let _ = stream.send(StreamMessage::Redraw { events });
				}else if let Some((first, last, lines, more)) = parse_buffer_lines(&value) {
					let _ = stream.send(StreamMessage::BufferLines { first, last, lines, more });
				}else if let Some(message) = parse_error_event(&value) {
					let _ = stream.send(StreamMessage::Error { message });
				}
			}
			Err(error) => {
				let message = error.to_string();
				let _ = stream.send(StreamMessage::Closed { message: message.clone() });
				if let Ok(mut pending) = pending.lock() {
					for (_, sender) in pending.drain() {
						let _ = sender.send(Err(format!("Neovim connection closed: {message}")));
					}
				}
				return;
			}
		}
	}
}

fn stop_process(process: &mut EditorProcess) {
	let _ = process.request_no_wait("nvim_command", vec![Value::from("qa!")]);
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

pub fn start_document(
	path: PathBuf,
	relative_path: String,
	stream: Channel<StreamMessage>,
	state: &EditorState,
) -> Result<(), String> {
	let mut slot = state.process.lock().map_err(|_| "Editor state lock failed.".to_string())?;
	if let Some(mut process) = slot.take() {
		stop_process(&mut process);
	}

	let mut child = Command::new("nvim")
		.arg("--embed")
		.arg("--clean")
		.args(["--cmd", "set noswapfile"])
		.arg("--")
		.arg(&path)
		.stdin(Stdio::piped())
		.stdout(Stdio::piped())
		.stderr(Stdio::inherit())
		.spawn()
		.map_err(|error| format!("nvim --embed failed: {error}"))?;

	let stdin = child.stdin.take().ok_or_else(|| "Neovim stdin is unavailable.".to_string())?;
	let stdout = child.stdout.take().ok_or_else(|| "Neovim stdout is unavailable.".to_string())?;
	let pending = Arc::new(Mutex::new(HashMap::new()));
	let reader_pending = Arc::clone(&pending);
	thread::spawn(move || read_neovim(stdout, stream, reader_pending));

	let mut process = EditorProcess {
		child,
		stdin,
		next_request_id: 1,
		pending,
		relative_path,
	};

	process.request("nvim_set_client_info", vec![
		Value::from("Quire"),
		Value::Map(vec![(Value::from("prerelease"), Value::from("desktop"))]),
		Value::from("ui"),
		Value::Map(vec![]),
		Value::Map(vec![]),
	])?;

	let options = Value::Map(vec![
		(Value::from("rgb"), Value::from(true)),
		(Value::from("ext_linegrid"), Value::from(true)),
	]);
	process.request("nvim_ui_attach", vec![Value::from(80), Value::from(24), options])?;
	process.request("nvim_buf_attach", vec![Value::from(0), Value::from(false), Value::Map(vec![])])?;

	*slot = Some(process);
	Ok(())
}

pub fn input(text: String, state: &EditorState) -> Result<(), String> {
	let mut slot = state.process.lock().map_err(|_| "Editor state lock failed.".to_string())?;
	let process = slot.as_mut().ok_or_else(|| "Editor is not running.".to_string())?;
	process.request_no_wait("nvim_input", vec![Value::from(text)])
}

pub fn resize(width: u64, height: u64, state: &EditorState) -> Result<(), String> {
	let mut slot = state.process.lock().map_err(|_| "Editor state lock failed.".to_string())?;
	let process = slot.as_mut().ok_or_else(|| "Editor is not running.".to_string())?;
	process.request_no_wait("nvim_ui_try_resize", vec![Value::from(width), Value::from(height)])
}

pub fn mouse(
	button: String,
	action: String,
	modifier: String,
	row: u64,
	col: u64,
	state: &EditorState,
) -> Result<(), String> {
	let mut slot = state.process.lock().map_err(|_| "Editor state lock failed.".to_string())?;
	let process = slot.as_mut().ok_or_else(|| "Editor is not running.".to_string())?;
	process.request_no_wait("nvim_input_mouse", vec![
		Value::from(button),
		Value::from(action),
		Value::from(modifier),
		Value::from(0),
		Value::from(row),
		Value::from(col),
	])
}

pub fn write(state: &EditorState) -> Result<String, String> {
	let mut slot = state.process.lock().map_err(|_| "Editor state lock failed.".to_string())?;
	let process = slot.as_mut().ok_or_else(|| "Editor is not running.".to_string())?;
	let relative_path = process.relative_path.clone();
	process.request("nvim_command", vec![Value::from("write")])?;
	Ok(relative_path)
}

pub fn current_document(state: &EditorState) -> Result<String, String> {
	let slot = state.process.lock().map_err(|_| "Editor state lock failed.".to_string())?;
	let process = slot.as_ref().ok_or_else(|| "Editor is not running.".to_string())?;
	Ok(process.relative_path.clone())
}

pub fn top_line(state: &EditorState) -> Result<u64, String> {
	let mut slot = state.process.lock().map_err(|_| "Editor state lock failed.".to_string())?;
	let process = slot.as_mut().ok_or_else(|| "Editor is not running.".to_string())?;
	let value = process.request("nvim_eval", vec![Value::from("winsaveview().topline")])?;
	let one_based = value_u64(&value).ok_or_else(|| "Neovim returned an invalid topline.".to_string())?;
	Ok(one_based.saturating_sub(1))
}

pub fn set_top_line(line: u64, state: &EditorState) -> Result<(), String> {
	let mut slot = state.process.lock().map_err(|_| "Editor state lock failed.".to_string())?;
	let process = slot.as_mut().ok_or_else(|| "Editor is not running.".to_string())?;
	let one_based = line.saturating_add(1);
	process.request(
		"nvim_command",
		vec![Value::from(format!("call winrestview({{'topline': {one_based}}})"))],
	)?;
	Ok(())
}

pub fn stop(state: &EditorState) -> Result<(), String> {
	let mut slot = state.process.lock().map_err(|_| "Editor state lock failed.".to_string())?;
	if let Some(mut process) = slot.take() {
		stop_process(&mut process);
	}
	Ok(())
}
