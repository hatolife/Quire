use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_LOG_ENTRIES: usize = 300;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
	pub id: u64,
	pub timestamp_ms: u64,
	pub level: String,
	pub source: String,
	pub message: String,
}

#[derive(Default)]
pub struct LogState {
	inner: Mutex<LogBuffer>,
}

#[derive(Default)]
struct LogBuffer {
	next_id: u64,
	entries: VecDeque<LogEntry>,
}

impl LogState {
	pub fn push(&self, level: String, source: String, message: String) -> Result<(), String> {
		let mut inner = self.inner.lock().map_err(|_| "Log state lock failed.".to_string())?;
		let timestamp_ms = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.map_err(|error| format!("System time error: {error}"))?
			.as_millis() as u64;
		let entry = LogEntry {
			id: inner.next_id,
			timestamp_ms,
			level,
			source,
			message,
		};
		inner.next_id = inner.next_id.wrapping_add(1);
		inner.entries.push_back(entry);
		while inner.entries.len() > MAX_LOG_ENTRIES {
			inner.entries.pop_front();
		}
		Ok(())
	}

	pub fn recent(&self) -> Result<Vec<LogEntry>, String> {
		let inner = self.inner.lock().map_err(|_| "Log state lock failed.".to_string())?;
		Ok(inner.entries.iter().cloned().collect())
	}

	pub fn clear(&self) -> Result<(), String> {
		let mut inner = self.inner.lock().map_err(|_| "Log state lock failed.".to_string())?;
		inner.entries.clear();
		Ok(())
	}
}
