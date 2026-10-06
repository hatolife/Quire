# Quire

Quireは、ローカルの通常ファイルを正本とし、編集・検索・リンク・履歴・Web参照を一つの完成した文書作業環境として提供することを目指すOSSプロジェクトです。

当面はObsidian代替を最初の到達点としますが、最終目的はObsidianの複製ではありません。

## Status

現在は Milestone 2: Application Skeleton の本体実装段階です。

完成品として利用できる状態ではありませんが、初期Architecture Spikesを経て、Windows向けTauri/Solidアプリ本体の実装へ移行しています。

現在の本体では、通常フォルダをWorkspaceとして開き、Markdownを選択・編集・Preview・保存する縦切り実装を進めています。

主要なArchitecture Spike:

- Neovim `--embed` + `ext_linegrid`。
- Tauri上の複数WebView / Browser pane。
- WebView2 browser extensions。
- 既存Git repositoryを汚さない履歴Snapshot。
- 外部ファイル変更の検出と競合保護。

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
