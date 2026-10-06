use anyhow::{bail, Context, Result};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Debug, PartialEq, Eq)]
struct UserState {
	head: String,
	branch: String,
	status: String,
	index: Vec<u8>,
}

fn git(repo: &Path, args: &[&str], alternate_index: Option<&Path>) -> Result<String> {
	let mut command = Command::new("git");
	command.current_dir(repo).args(args);
	if let Some(index) = alternate_index {
		command.env("GIT_INDEX_FILE", index);
	}
	let output = command.output().with_context(|| format!("git {} の起動に失敗した。", args.join(" ")))?;
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

fn git_with_stdin(repo: &Path, args: &[&str], alternate_index: Option<&Path>, input: &str) -> Result<String> {
	let mut command = Command::new("git");
	command.current_dir(repo).args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
	if let Some(index) = alternate_index {
		command.env("GIT_INDEX_FILE", index);
	}
	command.env("GIT_AUTHOR_NAME", "Quire");
	command.env("GIT_AUTHOR_EMAIL", "quire@localhost");
	command.env("GIT_COMMITTER_NAME", "Quire");
	command.env("GIT_COMMITTER_EMAIL", "quire@localhost");
	let mut child = command.spawn().with_context(|| format!("git {} の起動に失敗した。", args.join(" ")))?;
	{
		use std::io::Write;
		let stdin = child.stdin.as_mut().context("git stdinを取得できなかった。")?;
		stdin.write_all(input.as_bytes()).context("git stdinへの書き込みに失敗した。")?;
	}
	let output = child.wait_with_output().context("git processの終了待機に失敗した。")?;
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

fn git_path(repo: &Path, name: &str) -> Result<PathBuf> {
	let path = PathBuf::from(git(repo, &["rev-parse", "--git-path", name], None)?);
	if path.is_absolute() { return Ok(path); }
	Ok(repo.join(path))
}

fn capture_user_state(repo: &Path) -> Result<UserState> {
	let index_path = git_path(repo, "index")?;
	Ok(UserState {
		head: git(repo, &["rev-parse", "HEAD"], None)?,
		branch: git(repo, &["symbolic-ref", "--short", "HEAD"], None)?,
		status: git(repo, &["status", "--porcelain=v2", "--untracked-files=all"], None)?,
		index: fs::read(index_path).context("ユーザーindexを読み込めなかった。")?,
	})
}

fn create_snapshot(repo: &Path, temp_index: &Path) -> Result<String> {
	if temp_index.exists() {
		fs::remove_file(temp_index).context("一時indexを削除できなかった。")?;
	}
	git(repo, &["read-tree", "HEAD"], Some(temp_index))?;
	git(repo, &["add", "-A", "--", "."], Some(temp_index))?;
	let tree = git(repo, &["write-tree"], Some(temp_index))?;

	let parent = match git(repo, &["rev-parse", "--verify", "refs/quire/snapshots/latest"], None) {
		Ok(snapshot) => snapshot,
		Err(_) => git(repo, &["rev-parse", "HEAD"], None)?,
	};
	let commit = git_with_stdin(repo, &["commit-tree", &tree, "-p", &parent], Some(temp_index), "Quire snapshot\n")?;
	git(repo, &["update-ref", "refs/quire/snapshots/latest", &commit], None)?;
	Ok(commit)
}

fn prepare_repository(repo: &Path) -> Result<()> {
	git(repo, &["init"], None)?;
	git(repo, &["config", "user.name", "Quire Spike"], None)?;
	git(repo, &["config", "user.email", "quire-spike@localhost"], None)?;

	fs::write(repo.join("base.txt"), "base\n")?;
	fs::write(repo.join("staged.txt"), "initial\n")?;
	git(repo, &["add", "base.txt", "staged.txt"], None)?;
	git(repo, &["commit", "-m", "Initial commit"], None)?;

	fs::write(repo.join("staged.txt"), "staged version\n")?;
	git(repo, &["add", "staged.txt"], None)?;
	fs::write(repo.join("staged.txt"), "worktree version\n")?;
	fs::write(repo.join("base.txt"), "unstaged version\n")?;
	fs::write(repo.join("untracked.txt"), "untracked version\n")?;
	Ok(())
}

fn verify_snapshot(repo: &Path, commit: &str) -> Result<()> {
	let base = git(repo, &["show", &format!("{commit}:base.txt")], None)?;
	let staged = git(repo, &["show", &format!("{commit}:staged.txt")], None)?;
	let untracked = git(repo, &["show", &format!("{commit}:untracked.txt")], None)?;
	if base != "unstaged version" { bail!("Snapshotがunstaged変更を取得していない。"); }
	if staged != "worktree version" { bail!("Snapshotがworking treeの最新版を取得していない。"); }
	if untracked != "untracked version" { bail!("Snapshotがuntracked fileを取得していない。"); }

	let user_index_staged = git(repo, &["show", ":staged.txt"], None)?;
	if user_index_staged != "staged version" {
		bail!("ユーザーindexのstaged内容が変更された。");
	}
	Ok(())
}

fn run_spike() -> Result<()> {
	let temp = tempfile::tempdir().context("一時directoryを作成できなかった。")?;
	let repo = temp.path().join("repo");
	fs::create_dir(&repo)?;
	prepare_repository(&repo)?;

	let before = capture_user_state(&repo)?;
	let temp_index = temp.path().join("quire-index");
	let snapshot = create_snapshot(&repo, &temp_index)?;
	let after = capture_user_state(&repo)?;

	if before != after {
		bail!("Snapshot前後でユーザーGit状態が変化した。\nbefore={before:#?}\nafter={after:#?}");
	}
	verify_snapshot(&repo, &snapshot)?;

	println!("snapshot={snapshot}");
	println!("head={}", after.head);
	println!("branch={}", after.branch);
	println!("user index/status unchanged");
	println!("staged + unstaged + untracked worktree snapshot verified");
	Ok(())
}

fn main() {
	if let Err(err) = run_spike() {
		eprintln!("{err:#}");
		std::process::exit(1);
	}
}
