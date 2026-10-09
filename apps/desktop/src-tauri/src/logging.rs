use serde::Serialize;
use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_LOG_ENTRIES: usize = 300;
const MAX_LOG_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_MESSAGE_CHARS: usize = 4096;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
	pub id: u64,
	pub timestamp_ms: u64,
	pub level: String,
	pub source: String,
	pub message: String,
}

#[derive(Clone, Default)]
pub struct LogState {
	inner: Arc<Mutex<LogBuffer>>,
	log_path: Arc<Mutex<Option<PathBuf>>>,
}

#[derive(Default)]
struct LogBuffer {
	next_id: u64,
	entries: VecDeque<LogEntry>,
}

impl LogState {
	pub fn configure(&self, log_path: PathBuf) -> Result<(), String> {
		let parent = log_path.parent().ok_or_else(|| "Log file has no parent directory.".to_string())?;
		fs::create_dir_all(parent).map_err(|error| format!("Cannot create log directory: {error}"))?;
		// Create the file before exposing the path so a configuration failure
		// does not silently leave logging in a non-persistent state.
		OpenOptions::new()
			.create(true)
			.append(true)
			.open(&log_path)
			.map_err(|error| format!("Cannot open log file: {error}"))?;
		let mut current = self.log_path.lock().map_err(|_| "Log path lock failed.".to_string())?;
		*current = Some(log_path);
		Ok(())
	}

	pub fn path(&self) -> Result<Option<String>, String> {
		let path = self.log_path.lock().map_err(|_| "Log path lock failed.".to_string())?;
		Ok(path.as_ref().map(|path| path.to_string_lossy().into_owned()))
	}

	pub fn push(&self, level: String, source: String, message: String) -> Result<(), String> {
		let mut inner = self.inner.lock().map_err(|_| "Log state lock failed.".to_string())?;
		let timestamp_ms = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.map_err(|error| format!("System time error: {error}"))?
			.as_millis() as u64;
		let entry = LogEntry {
			id: inner.next_id,
			timestamp_ms,
			level: single_line(&level),
			source: single_line(&source),
			message: single_line(&message),
		};
		inner.next_id = inner.next_id.wrapping_add(1);
		inner.entries.push_back(entry.clone());
		while inner.entries.len() > MAX_LOG_ENTRIES {
			inner.entries.pop_front();
		}

		let path = self.log_path.lock().map_err(|_| "Log path lock failed.".to_string())?;
		if let Some(path) = path.as_deref() {
			append_file(path, &entry)?;
		}
		Ok(())
	}

	pub fn recent(&self) -> Result<Vec<LogEntry>, String> {
		let inner = self.inner.lock().map_err(|_| "Log state lock failed.".to_string())?;
		Ok(inner.entries.iter().cloned().collect())
	}

	// Clear only the in-app view; preserve on-disk diagnostics.
	pub fn clear(&self) -> Result<(), String> {
		let mut inner = self.inner.lock().map_err(|_| "Log state lock failed.".to_string())?;
		inner.entries.clear();
		Ok(())
	}
}

fn single_line(value: &str) -> String {
	let mut result = String::new();
	for character in value.chars().take(MAX_MESSAGE_CHARS) {
		match character {
			'\n' => result.push_str("\\n"),
			'\r' => result.push_str("\\r"),
			'\t' => result.push_str("\\t"),
			_ => result.push(character),
		}
	}
	if value.chars().count() > MAX_MESSAGE_CHARS {
		result.push_str("…[truncated]");
	}
	result
}

fn append_file(path: &Path, entry: &LogEntry) -> Result<(), String> {
	let line = format!(
		"{}\t{}\t{}\t{}\n",
		entry.timestamp_ms, entry.level, entry.source, entry.message
	);
	let size = fs::metadata(path).map(|metadata| metadata.len()).unwrap_or(0);
	if size.saturating_add(line.len() as u64) > MAX_LOG_FILE_BYTES {
		let rotated = path.with_extension("log.1");
		if rotated.exists() {
			fs::remove_file(&rotated).map_err(|error| format!("Cannot remove old log backup: {error}"))?;
		}
		if path.exists() {
			fs::rename(path, &rotated).map_err(|error| format!("Cannot rotate log: {error}"))?;
		}
	}
	let mut file = OpenOptions::new()
		.create(true)
		.append(true)
		.open(path)
		.map_err(|error| format!("Cannot append log file: {error}"))?;
	file.write_all(line.as_bytes()).map_err(|error| format!("Cannot write log: {error}"))?;
	file.flush().map_err(|error| format!("Cannot flush log: {error}"))?;
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn logs_are_persistent_and_single_line() {
		let directory = tempfile::tempdir().unwrap();
		let path = directory.path().join("quire.log");
		let logger = LogState::default();
		logger.configure(path.clone()).unwrap();
		logger.push("error".into(), "editor".into(), "line1\nline2".into()).unwrap();
		logger.clear().unwrap();
		assert!(logger.recent().unwrap().is_empty());
		let content = fs::read_to_string(path).unwrap();
		assert!(content.contains("error\teditor\tline1\\nline2\n"));
	}
}
