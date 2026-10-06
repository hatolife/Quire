use anyhow::{anyhow, bail, Context, Result};
use rmpv::Value;
use std::io::{BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

struct RpcClient {
	stdin: ChildStdin,
	rx: Receiver<Result<Value, String>>,
	next_id: i64,
	grid_line_count: usize,
	flush_count: usize,
}

impl RpcClient {
	fn new(stdin: ChildStdin, stdout: impl std::io::Read + Send + 'static) -> Self {
		let (tx, rx) = mpsc::channel();
		thread::spawn(move || {
			let mut reader = BufReader::new(stdout);
			loop {
				match rmpv::decode::read_value(&mut reader) {
					Ok(value) => {
						if tx.send(Ok(value)).is_err() {
							return;
						}
					}
					Err(err) => {
						let _ = tx.send(Err(err.to_string()));
						return;
					}
				}
			}
		});
		Self { stdin, rx, next_id: 1, grid_line_count: 0, flush_count: 0 }
	}

	fn call(&mut self, method: &str, params: Vec<Value>) -> Result<Value> {
		let id = self.next_id;
		self.next_id += 1;
		let request = Value::Array(vec![
			Value::from(0),
			Value::from(id),
			Value::from(method),
			Value::Array(params),
		]);
		rmpv::encode::write_value(&mut self.stdin, &request).context("RPC requestのMessagePack書き込みに失敗した。")?;
		self.stdin.flush().context("Neovim stdinのflushに失敗した。")?;

		loop {
			let value = self.rx.recv_timeout(Duration::from_secs(10)).context("Neovim RPC responseがタイムアウトした。")?.map_err(|err| anyhow!("Neovim RPC reader error: {err}"))?;
			if self.handle_notification(&value) {
				continue;
			}
			let Some(items) = value.as_array() else { continue; };
			if items.len() != 4 || items[0].as_i64() != Some(1) || items[1].as_i64() != Some(id) {
				continue;
			}
			if !items[2].is_nil() {
				bail!("Neovim RPC error: {}", items[2]);
			}
			return Ok(items[3].clone());
		}
	}

	fn poll_notifications(&mut self, duration: Duration) -> Result<()> {
		let deadline = Instant::now() + duration;
		while Instant::now() < deadline {
			let remain = deadline.saturating_duration_since(Instant::now()).min(Duration::from_millis(100));
			match self.rx.recv_timeout(remain) {
				Ok(Ok(value)) => {
					self.handle_notification(&value);
				}
				Ok(Err(err)) => return Err(anyhow!("Neovim RPC reader error: {err}")),
				Err(mpsc::RecvTimeoutError::Timeout) => {}
				Err(mpsc::RecvTimeoutError::Disconnected) => break,
			}
		}
		Ok(())
	}

	fn handle_notification(&mut self, value: &Value) -> bool {
		let Some(items) = value.as_array() else { return false; };
		if items.len() != 3 || items[0].as_i64() != Some(2) || items[1].as_str() != Some("redraw") {
			return false;
		}
		self.grid_line_count += count_string(&items[2], "grid_line");
		self.flush_count += count_string(&items[2], "flush");
		true
	}
}

fn count_string(value: &Value, target: &str) -> usize {
	if value.as_str() == Some(target) {
		return 1;
	}
	if let Some(values) = value.as_array() {
		return values.iter().map(|v| count_string(v, target)).sum();
	}
	if let Some(values) = value.as_map() {
		return values.iter().map(|(k, v)| count_string(k, target) + count_string(v, target)).sum();
	}
	0
}

fn start_neovim() -> Result<(Child, RpcClient)> {
	let mut child = Command::new("nvim")
		.args(["--embed", "--clean"])
		.stdin(Stdio::piped())
		.stdout(Stdio::piped())
		.stderr(Stdio::inherit())
		.spawn()
		.context("nvim --embedの起動に失敗した。PATHとNeovimのインストール状態を確認すること。")?;
	let stdin = child.stdin.take().context("Neovim stdinを取得できなかった。")?;
	let stdout = child.stdout.take().context("Neovim stdoutを取得できなかった。")?;
	Ok((child, RpcClient::new(stdin, stdout)))
}

fn run_spike() -> Result<()> {
	let (mut child, mut rpc) = start_neovim()?;
	let api_info = rpc.call("nvim_get_api_info", vec![])?;
	let Some(api_items) = api_info.as_array() else { bail!("nvim_get_api_infoの形式が不正。"); };
	if api_items.len() != 2 {
		bail!("nvim_get_api_infoの要素数が不正。");
	}
	println!("channel_id={}", api_items[0]);

	let ui_options = Value::Map(vec![
		(Value::from("rgb"), Value::from(true)),
		(Value::from("ext_linegrid"), Value::from(true)),
	]);
	rpc.call("nvim_ui_attach", vec![Value::from(80), Value::from(24), ui_options])?;
	rpc.poll_notifications(Duration::from_millis(500))?;

	let expected = "Quire 日本語 UTF-8 test";
	rpc.call("nvim_input", vec![Value::from(format!("i{expected}<Esc>"))])?;
	let line = rpc.call("nvim_get_current_line", vec![])?;
	if line.as_str() != Some(expected) {
		bail!("入力結果が一致しない。expected={expected:?}, actual={line}");
	}
	rpc.poll_notifications(Duration::from_millis(500))?;

	if rpc.grid_line_count == 0 {
		bail!("ext_linegridのgrid_lineイベントを確認できなかった。");
	}
	if rpc.flush_count == 0 {
		bail!("UI redrawのflushイベントを確認できなかった。");
	}

	println!("current_line={expected}");
	println!("grid_line_events={}", rpc.grid_line_count);
	println!("flush_events={}", rpc.flush_count);

	let _ = rpc.call("nvim_command", vec![Value::from("qa!")]);
	drop(rpc);
	let status = child.wait().context("Neovim processの終了待機に失敗した。")?;
	if !status.success() {
		bail!("Neovim processが異常終了した: {status}");
	}
	Ok(())
}

fn main() {
	if let Err(err) = run_spike() {
		eprintln!("{err:#}");
		std::process::exit(1);
	}
}
