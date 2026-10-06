# Git Snapshot Isolation Spike

## 目的

既存Git repositoryをQuire Workspaceとして開いた場合に、ユーザーのGit作業状態を壊さずQuire用の復元点を作れることを確認する。

Quireの履歴機能のためにユーザーへcommitを要求しない。

## 方針

ユーザーの `.git/index` を操作しない。

Gitが公式に提供する `GIT_INDEX_FILE` を使い、Quire専用の一時indexを作る。

Snapshot作成は次のplumbing commandを使用する。

1. 一時indexへ `git read-tree HEAD`。
2. 一時indexだけに `git add -A -- .`。
3. `git write-tree`。
4. `git commit-tree`。
5. `refs/quire/snapshots/latest` を `git update-ref`。

通常の `git commit`、checkout、reset、stashは使用しない。

## 自動検証

Spike自身が一時Git repositoryを作る。

次の状態を同時に作る。

- 通常のHEAD/branch。
- staged変更。
- staged後にさらに変更したworking tree。
- unstaged変更。
- untracked file。

Snapshot前後で次を比較する。

- HEAD。
- current branch。
- `git status --porcelain=v2`。
- ユーザーindex fileのbytes。

すべて完全一致しなければ失敗する。

さらにSnapshot commitから次を復元確認する。

- unstaged変更。
- working tree側の最新版。
- untracked file。

ユーザーindexには元のstaged版が残っていることも確認する。

## 実行

GitとRustがPATHにある環境で実行する。

```sh
cargo run --manifest-path spikes/git-snapshot-isolation/Cargo.toml
```

## この方式で変更されるもの

Git object databaseにはblob/tree/commit objectが追加される。

さらにQuire専用refを更新する。

```text
refs/quire/snapshots/latest
```

これは意図したQuire管理情報である。

## この方式で変更してはいけないもの

- HEAD。
- current branch。
- user index。
- staged / unstaged状態。
- user branch history。
- working tree。

## 未検証

- ignored fileをQuire Snapshotへ含める必要がある場合の扱い。
- submodule。
- worktree構成。
- unborn HEAD。
- merge/rebase/cherry-pick途中。
- sparse checkout。
- symlink。
- large repository性能。
- Snapshot refのGC/reflog方針。
- Snapshot削除と保持期間。
- 同時Snapshot時のref更新競合。

これらは基本方式が成立した後に追加検証する。
