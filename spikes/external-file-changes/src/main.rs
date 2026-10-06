use anyhow::{bail, Context, Result};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, PartialEq, Eq)]
enum ReconcileResult {
	Unchanged,
	Reload(String),
	Conflict { disk: String, buffer: String },
}

#[derive(Debug)]
struct DocumentState {
	base_disk: String,
	buffer: String,
	dirty: bool,
}

impl DocumentState {
	fn reconcile(&self, disk: &str) -> ReconcileResult {
		if disk == self.base_disk { return ReconcileResult::Unchanged; }
		if self.dirty {
			return ReconcileResult::Conflict { disk: disk.to_string(), buffer: self.buffer.clone() };
		}
		ReconcileResult::Reload(disk.to_string())
	}
}

fn git(repo: &Path, args: &[&str]) -> Result<String> {
	let output = Command::new("git").current_dir(repo).args(args).output().with_context(|| format!("git {} の起動に失敗した。", args.join(" ")))?;
	if !output.status.success() {
		bail!(
			"git {} が失敗した。\nstdout:\n{}\nstderr:\n{}",
			args.join(" "),
			String::from_utf8_lossy(&output.stdout),
			String::from_utf8_lossy(&output.stderr)
		);
	}
	Ok(String::from_utf8(output.stdout).context("git stdoutがUTF-8ではない。")?.trim().to_string())
}

fn prepare_git_history(root: &Path) -> Result<()> {
	git(root, &["init"])?;
	git(root, &["config", "user.name", "Quire Spike"])?;
	git(root, &["config", "user.email", "quire-spike@localhost"])?;
	fs::write(root.join("versioned.txt"), "state-a\n")?;
	git(root, &["add", "versioned.txt"])?;
	git(root, &["commit", "-m", "State A"])?;
	fs::write(root.join("versioned.txt"), "state-b\n")?;
	git(root, &["add", "versioned.txt"])?;
	git(root, &["commit", "-m", "State B"])?;
	Ok(())
}

fn event_touches(event: &Event, expected: &[&Path]) -> bool {
	event.paths.iter().any(|actual| expected.iter().any(|path| actual == path))
}

fn wait_for_event(rx: &Receiver<notify::Result<Event>>, expected: &[&Path], label: &str) -> Result<Vec<Event>> {
	let deadline = Instant::now() + Duration::from_secs(8);
	let mut events = Vec::new();
	while Instant::now() < deadline {
		match rx.recv_timeout(Duration::from_millis(250)) {
		Ok(Ok(event)) => {
			let matched = event_touches(&event, expected);
			events.push(event);
			if matched { return Ok(events); }
		}
		Ok(Err(err)) => bail!("watcher error: {err}"),
		Err(mpsc::RecvTimeoutError::Timeout) => {}
		Err(mpsc::RecvTimeoutError::Disconnected) => bail!("watcher channelが切断された。"),
		}
	}
	bail!("{label} のfilesystem eventを確認できなかった。");
}

fn drain_until_quiet(rx: &Receiver<notify::Result<Event>>, max_wait: Duration, quiet: Duration) -> Result<Vec<Event>> {
	let deadline = Instant::now() + max_wait;
	let mut events = Vec::new();
	let mut last_event = Instant::now();
	while Instant::now() < deadline {
		match rx.recv_timeout(Duration::from_millis(50)) {
		Ok(Ok(event)) => {
			events.push(event);
			last_event = Instant::now();
		}
		Ok(Err(err)) => bail!("watcher error: {err}"),
		Err(mpsc::RecvTimeoutError::Timeout) => {
			if !events.is_empty() && last_event.elapsed() >= quiet { break; }
		}
		Err(mpsc::RecvTimeoutError::Disconnected) => bail!("watcher channelが切断された。"),
		}
	}
	Ok(events)
}

fn create_watcher(root: &Path) -> Result<(RecommendedWatcher, Receiver<notify::Result<Event>>)> {
	let (tx, rx) = mpsc::channel();
	let mut watcher = notify::recommended_watcher(tx).context("filesystem watcherを作成できなかった。")?;
	watcher.watch(root, RecursiveMode::Recursive).context("Workspaceの監視開始に失敗した。")?;
	thread::sleep(Duration::from_millis(200));
	Ok((watcher, rx))
}

fn verify_regular_changes(root: &Path, rx: &Receiver<notify::Result<Event>>) -> Result<()> {
	let document = root.join("document.md");
	fs::write(&document, "original\n")?;
	wait_for_event(rx, &[&document], "create")?;
	let _ = drain_until_quiet(rx, Duration::from_secs(1), Duration::from_millis(150))?;

	fs::write(&document, "external update\n")?;
	wait_for_event(rx, &[&document], "modify")?;
	if fs::read_to_string(&document)? != "external update\n" { bail!("modify後のfilesystem状態が不正。"); }

	let renamed = root.join("renamed.md");
	fs::rename(&document, &renamed)?;
	wait_for_event(rx, &[&document, &renamed], "rename")?;
	if document.exists() || !renamed.exists() { bail!("rename後のfilesystem状態が不正。"); }

	let nested = root.join("nested");
	fs::create_dir_all(&nested)?;
	let moved = nested.join("moved.md");
	fs::rename(&renamed, &moved)?;
	wait_for_event(rx, &[&renamed, &moved], "move")?;
	if renamed.exists() || !moved.exists() { bail!("move後のfilesystem状態が不正。"); }

	fs::remove_file(&moved)?;
	wait_for_event(rx, &[&moved], "delete")?;
	if moved.exists() { bail!("delete後もfileが存在する。"); }
	Ok(())
}

fn verify_dirty_conflict(root: &Path, rx: &Receiver<notify::Result<Event>>) -> Result<()> {
	let path = root.join("conflict.md");
	fs::write(&path, "disk base\n")?;
	wait_for_event(rx, &[&path], "conflict file create")?;
	let _ = drain_until_quiet(rx, Duration::from_secs(1), Duration::from_millis(150))?;

	let state = DocumentState {
		base_disk: "disk base\n".to_string(),
		buffer: "local unsaved edit\n".to_string(),
		dirty: true,
	};
	fs::write(&path, "external edit\n")?;
	wait_for_event(rx, &[&path], "external conflict update")?;
	let disk = fs::read_to_string(&path)?;
	let result = state.reconcile(&disk);
	if result != ReconcileResult::Conflict {
		bail!("dirty documentをConflictとして検出できなかった: {result:?}");
	}
	if state.buffer != "local unsaved edit\n" {
		bail!("local bufferを破壊した。");
	}
	Ok(())
}

fn verify_bulk_changes(root: &Path, rx: &Receiver<notify::Result<Event>>) -> Result<()> {
	let bulk = root.join("bulk");
	fs::create_dir_all(&bulk)?;
	for i in 0..200 {
		fs::write(bulk.join(format!("{i:03}.md")), format!("# {i}\n"))?;
	}
	let events = drain_until_quiet(rx, Duration::from_secs(8), Duration::from_millis(300))?;
	if events.is_empty() { bail!("大量変更でfilesystem eventを一件も受信しなかった。"); }
	let count = fs::read_dir(&bulk)?.filter_map(Result::ok).filter(|entry| entry.path().extension().and_then(|v| v.to_str()) == Some("md")).count();
	if count != 200 { bail!("再走査結果が不正。expected=200 actual={count}"); }
	println!("bulk_events={} files={count}", events.len());
	Ok(())
}

fn verify_git_checkout(root: &Path, rx: &Receiver<notify::Result<Event>>) -> Result<()> {
	let path = root.join("versioned.txt");
	let before = fs::read_to_string(&path)?;
	if before != "state-b\n" { bail!("checkout検証の初期状態が不正。"); }
	git(root, &["checkout", "HEAD~1", "--", "versioned.txt"])?;
	wait_for_event(rx, &[&path], "git checkout")?;
	let after = fs::read_to_string(&path)?;
	if after != "state-a\n" { bail!("git checkout後の再走査結果が不正。"); }
	Ok(())
}

fn run_spike() -> Result<()> {
	let temp = tempfile::tempdir().context("一時Workspaceを作成できなかった。")?;
	let root: PathBuf = temp.path().join("workspace");
	fs::create_dir(&root)?;
	prepare_git_history(&root)?;

	let (_watcher, rx) = create_watcher(&root)?;
	verify_regular_changes(&root, &rx)?;
	verify_dirty_conflict(&root, &rx)?;
	let _ = drain_until_quiet(&rx, Duration::from_secs(1), Duration::from_millis(150))?;
	verify_bulk_changes(&root, &rx)?;
	verify_git_checkout(&root, &rx)?;

	println!("create/modify/rename/move/delete verified");
	println!("dirty document conflict verified without buffer loss");
	println!("bulk rescan verified");
	println!("git checkout change verified");
	Ok(())
}

fn main() {
	if let Err(err) = run_spike() {
		eprintln!("{err:#}");
		std::process::exit(1);
	}
}
