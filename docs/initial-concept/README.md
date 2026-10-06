# Initial Concept

Quireの初期構想と、実装開始前の設計判断を保存するディレクトリ。

このディレクトリの文書は完成仕様ではない。

初期の動機と判断過程を失わないために残し、技術検証や実使用の結果に応じて更新する。

## Documents

- [concept.md](concept.md)
  - 作者が最初に書いたQuireの構想。
  - 初期の問題意識と目的を残す。
- [principles.md](principles.md)
  - Quire全体の設計判断に使用する原則。
- [scope.md](scope.md)
  - Quire本体が担当する範囲と、当面担当しない範囲。
- [data-model.md](data-model.md)
  - Workspace、Document、Asset、Index、履歴等の初期データモデル。
- [architecture.md](architecture.md)
  - Tauri、Solid、Rust、Neovim、Git、WebView等を含む初期アーキテクチャ案。
- [milestones.md](milestones.md)
  - 技術スパイクから日常利用、Obsidian置換までの初期開発順序。

## 文書の扱い

`concept.md` は初期構想そのものとして扱い、後から綺麗な製品説明文へ置き換えない。

実装仕様が固まったものは、将来的に `docs/initial-concept/` ではなく正式な仕様・設計文書へ分離する。

初期構想と現在仕様が異なる場合、両方を残し、変更理由を追える状態を優先する。
