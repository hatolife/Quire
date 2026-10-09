# Quire

Quireは、ローカルの通常ファイルを正本とし、編集・検索・リンク・履歴・Web参照を一つの完成した文書作業環境として提供することを目指すOSSプロジェクトです。

当面はObsidian代替を最初の到達点としますが、最終目的はObsidianの複製ではありません。

## Status

Milestone 2: Application Skeleton の完了条件は達成済みです。

現在は **Milestone 3: Vertical Slice の機能実装を本体へ接続し、Milestone 4: Daily Use Alpha向けの堅牢化を並行して進めています。**

本体には、通常フォルダをそのままWorkspaceとして開く処理に加え、Neovim編集、Markdown Preview、Document作成/移動/削除、画像追加、Wiki Link/backlink、file watcher、全文検索、History Snapshot/比較/復元、Browser pane、session restore、Command Palette、未保存buffer recovery等が入っています。

Milestone 3の実装項目は一通り接続済みですが、完了条件に含まれる「実際の個人文書フォルダを一週間程度Quire中心で扱う」実運用確認はまだ行っていないため、Milestone 3完了とはしていません。

Windows CIでは `quire-core` の自動テスト、Tauri production build、package生成を継続検証しています。

主要なArchitecture Spike:

- Neovim `--embed` + `ext_linegrid`。
- Tauri上の複数WebView / Browser pane。
- WebView2 browser extensions。
- ユーザーGit状態を壊さない履歴Snapshot。
- 外部ファイル変更の検出と競合保護。

## 開発ビルドの新しい操作（2026-10-09）

- 画面左のコマンドレールは、**Settings → 左メニュー**で割り当て・並べ替え可能。コマンドとマクロを配置できます。
- **Ctrl+Shift+P**でCommand Paletteを開けます。
- **Settings → マクロ**でマクロ名と実行順のコマンドIDを登録できます。最大100ステップの逐次実行で、無効なコマンドや例外があれば停止します。任意コード実行や再帰マクロはできません。
- Explorer / Editor / 右ペイン見出しの **⠿** をドラッグして配置を変更できます。上下・左右のドッキングと配置保存に対応します。
- Explorer / Editor / Preview / Graph / Browserは **↗** またはコマンドから別ウィンドウに分離し、分離先の「メインへ戻す」でドッキングできます。

**未完了:** Obsidian相当の任意の多段分割、右ペイン各タブの独立ドック、History/Settings/Logsの統合、全UI操作のコマンド経由への統一、分離Editorの実機Recovery検証。
これらが済むまでMilestone 3の実運用検証開始条件を満たしたとは扱いません。

## Design documents

初期構想は [docs/initial-concept/](docs/initial-concept/) にあります。

特に以下を先に参照してください。

- [Concept](docs/initial-concept/concept.md)
- [Principles](docs/initial-concept/principles.md)
- [Scope](docs/initial-concept/scope.md)
- [Data model](docs/initial-concept/data-model.md)
- [Architecture](docs/initial-concept/architecture.md)
- [Milestones](docs/initial-concept/milestones.md)

## Development

主要機能が揃うまでは、正式な製品バージョンを付けません。

必要な開発ビルドはタイムスタンプとcommit hashで識別します。

初期の技術検証コードは `spikes/` 以下に置きます。
