# AGENTS.md

## Project goal

Quireは、文書編集、検索、リンク、履歴、Web参照等を一つの完成したローカルファースト文書環境として提供する。

設計判断では `docs/initial-concept/principles.md` を優先する。

## Current phase

Milestone 2は完了済み。Milestone 3の主要機能は実装済みだが、実運用検証は未完了。
Milestone 4のDaily Use Alphaへ向け、構造・安全性・操作性を改修中。

2026-10-09に追加された、実運用検証前に満たす必須条件:

- Windows GUIとしてコンソールを表示しない。
- ペインをObsidianのように任意に分割、移動、ドッキングできる。単なる3領域の順序変更では完成ではない。
- Editor、Explorer、Preview、Browser、Graph等を別ウィンドウ化し、未保存変更とRecoveryを保護する。
- 全UI機能を安定したコマンドとして登録し、コマンド、ショートカット、メニューから同じ操作を呼べる。
- マクロによるコマンドの自動化を実装する。
- 左メニューに任意のコマンドやマクロを割り当てられる。
- 関連設定を永続化し、起動後に復元できる。

進捗と未完了条件は `docs/initial-concept/milestones.md` を参照する。
実機の代わりにできるテスト・CI・静的確認を先に実施し、未検証事項を完了扱いしない。

## Development rules

- Windowsを第一対象とする。
- ただし不要なOS依存を中核ロジックへ持ち込まない。
- ユーザーデータを独自DBだけへ閉じ込めない。
- Indexやcacheは再生成可能にする。
- 既存Git repositoryのHEAD、branch、indexを暗黙に変更しない。
- UIへGit、Neovim等の内部概念を不要に露出しない。
- subsystem間の境界を明確にする。
- 早すぎるplugin APIや過剰な抽象化は避ける。
- 変更と同時に関連文書も更新する。
- 技術スパイクでは「API上可能」ではなく日常利用可能性を検証する。
- データ損失につながる自動処理は、復元可能性を優先する。

## Repository layout

現在の基本構成:

```text
Cargo.toml
crates/
  quire-core/
apps/
  desktop/
    src/
    src-tauri/
docs/
  initial-concept/
  spikes/
spikes/
```

`quire-core` はTauri非依存の中核libraryとし、desktop側はApplication/UI境界とする。

存在しないディレクトリを仕様確定済みとみなさない。

## Commits

小さな意味単位でcommitする。

実装、検証結果、文書更新を可能な範囲で分ける。

## Versioning

主要機能が揃うまでは `v0.1.0` を使用しない。

CI等でSemVerが必要な場合のみ `v0.0.x` を使用する。

それ以外の開発ビルドはタイムスタンプとcommit hashで識別する。

## Spike rules

各技術スパイクには目的、実行方法、結果、問題点、採用判断を文書として残す。

失敗したスパイクも削除せず、判断材料として残す。

検証コードを本体へ持ち込む場合は、スパイク特有の近道や仮定を除去してから移植する。
