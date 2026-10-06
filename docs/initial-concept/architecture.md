# Quire 初期アーキテクチャ

## 位置付け

この文書は初期構想段階のアーキテクチャ案を定義する。

現時点では実装方式を固定することより、責務境界と技術検証の順序を明確にすることを優先する。

技術スパイクの結果、より適した構成が確認できた場合は変更する。

## 目標

Quire本体を次の性質に保つ。

- 通常ユーザーは内部ツールを意識せず利用できる。
- 高度なユーザーはGit、Neovim等の既存資産を利用できる。
- UIと中核ロジックを分離する。
- エディタ、履歴エンジン、検索エンジン等をQuireそのものと同一視しない。
- AIを含む第三者が特定機能だけを変更しやすい。
- Windowsを第一対象としつつ、不要なOS固定を避ける。

## 初期採用候補

|領域|初期候補|位置付け|
|---|---|---|
|デスクトップシェル|Tauri v2|第一候補|
|Windows WebView|WebView2|Tauri経由|
|フロントエンド|TypeScript + Solid|第一候補|
|バックエンド|Rust|第一候補|
|レイアウト|Quire自前の分割ツリー|本体機能|
|エディタエンジン|Neovim `--embed`|技術スパイク必須|
|Neovim描画|`ext_linegrid` → Canvas/WebGL等|技術スパイク必須|
|Markdown parser|markdown-it系|候補|
|履歴|Git object database|技術スパイク必須|
|全文検索|Rust側インデックス|方式未確定|
|ブラウザ|子WebView / WebView pane|技術スパイク必須|
|設定|TOML等の人間可読形式|候補|

Rustだけですべてを実装することは目的にしない。

明確な利点があればGo、Lua、TypeScript等を使用してよい。

ただし配布、起動、更新が複雑になる場合は、本体へ統合する価値と比較する。

## 全体構成

概念上は次の層へ分ける。

```text
┌──────────────────────────────────────────────┐
│                Quire UI                      │
│ Solid / TypeScript                           │
│                                              │
│ Layout  Panels  Commands  Dialogs  Theme    │
└──────────────────────┬───────────────────────┘
                       │ commands / channels
┌──────────────────────▼───────────────────────┐
│              Application Layer               │
│ Rust                                         │
│                                              │
│ Workspace / Documents / Commands / Session   │
└───────┬──────────┬──────────┬─────────┬──────┘
        │          │          │         │
┌───────▼───┐ ┌────▼────┐ ┌──▼─────┐ ┌▼──────────┐
│ Filesystem │ │ History │ │ Index  │ │ Editor    │
│            │ │         │ │        │ │ Adapter   │
└────────────┘ └─────────┘ └────────┘ └────┬──────┘
                                            │ msgpack-rpc
                                       ┌────▼─────┐
                                       │ Neovim   │
                                       └──────────┘

             ┌──────────────────────────────┐
             │ Browser / WebView Adapter    │
             │ WebView2 on Windows          │
             └──────────────────────────────┘
```

UIからGitやファイル監視等を直接操作しない。

Application LayerをQuireのユースケース境界とする。

## Application Layer

Application LayerはUIから見えるQuire本体の操作を提供する。

例:

- Workspaceを開く。
- Workspaceを閉じる。
- Documentを開く。
- Documentを保存する。
- Documentを移動する。
- Assetを追加する。
- 検索する。
- バックリンクを取得する。
- Snapshotを作成する。
- 履歴を取得する。
- Restoreする。
- Editor sessionを作成する。
- Browser paneを作成する。

UIは「Git commitを作る」ではなく「Snapshotを作る」を要求する。

UIは「NeovimへRPCを送る」ではなく「Editorへキー入力を送る」等のQuire側の境界を通す。

内部実装をそのままUI APIに露出させない。

## Frontend

フロントエンドの主責務は表示とユーザー操作である。

初期構成:

```text
src/
├─ app/
├─ layout/
├─ panels/
│  ├─ editor/
│  ├─ preview/
│  ├─ explorer/
│  ├─ search/
│  ├─ backlinks/
│  ├─ history/
│  └─ browser/
├─ commands/
├─ components/
└─ state/
```

実際の構成名は実装開始時に調整する。

### UI state

ファイル内容、Git履歴、検索Index等の正本をフロントエンドstateにしない。

UI stateは主に次を保持する。

- 開いているpane。
- 選択状態。
- 一時的な入力。
- 表示用モデル。
- バックエンドから取得したキャッシュ。

## 分割レイアウト

画面レイアウトはQuire本体の重要機能とする。

固定された「左サイドバー + 中央エディタ + 右サイドバー」には限定しない。

内部表現は分割ツリーを第一候補とする。

例:

```text
Split(Horizontal)
├─ Pane(FileExplorer)
└─ Split(Vertical)
   ├─ Pane(Editor)
   └─ Pane(Browser)
```

LeafはPaneを表す。

Splitは方向と比率を持つ。

Paneの種類とレイアウト構造を分離する。

これによりEditor、Preview、Browser等を同じ分割機構へ載せる。

初期段階からドラッグによる再配置を完全実装する必要はないが、データ構造は固定レイアウト前提にしない。

## Editor Adapter

EditorはQuireの中でも独立性を高く保つ。

Application Layerから見たEditorの概念APIを用意する。

例:

- session作成。
- ファイルを開く。
- 入力イベント送信。
- resize。
- redraw取得。
- clipboard。
- IME。
- cursor state。
- mode state。
- command実行。
- 終了。

Neovim固有のRPC型をアプリ全体へ拡散させない。

## Neovim統合

第一候補はRust側で `nvim --embed` を起動し、msgpack-rpcで接続する方式とする。

UI描画にはNeovim UI protocolの `ext_linegrid` を利用する案を検証する。

目標は「外部ターミナル内でNeovimを開く」ことではない。

Quireのpaneとして自然に描画する。

最低限、技術スパイクで次を検証する。

- 起動と終了。
- `nvim_ui_attach`。
- `ext_linegrid` の描画。
- font metrics。
- cursor。
- mode変更。
- キー入力。
- マウス。
- resize。
- clipboard。
- 日本語IME。
- Unicode、絵文字、全角文字。
- syntax highlight。
- popup menu。
- floating window。
- diagnostics。
- 複数buffer。
- Neovim設定の読み込み方法。
- 異常終了からの復旧。

日本語IMEが実用にならない場合は重大なアーキテクチャ上の問題として扱う。

「一応表示できた」で採用確定にしない。

## Editor fallback

Neovim統合が技術的に成立しない場合にQuire全体が行き止まりにならないよう、Editor Adapter境界を維持する。

代替候補としてCodeMirror 6、Monaco等を検討できる構造にする。

ただし初期段階で複数エディタを同時実装することはしない。

第一候補を十分検証してから判断する。

## Markdown

Markdown処理は「表示用parser」と「Workspace解析」を分離する。

### Render

Document本文をHTML等へ変換してPreviewへ表示する。

候補:

- markdown-it。
- 必要な独自plugin。
- syntax highlight。
- 数式レンダリング。

### Analyze

リンク、タグ、見出し等をIndexへ登録する。

Render結果のDOMを正本として解析しない。

可能であれば共通のMarkdown構文解釈を利用するが、UI rendererへの密結合は避ける。

## Obsidian互換記法

Obsidian記法は互換レイヤとして扱う。

Quire内部の全機能をObsidian仕様へ従属させない。

候補:

- Wiki Link。
- Embeds。
- Callouts。
- Front matter。
- Tags。
- Block references。

どこまで再現するかは互換性仕様として別文書化する。

## Index

Index subsystemはDocumentから再生成可能な検索・関係情報を管理する。

責務:

- ファイル検出。
- 変更検出。
- parser呼び出し。
- 全文検索。
- heading index。
- tags。
- links。
- backlinks。
- unresolved links。

Index storageは初期技術検証で決定する。

候補:

- SQLite + FTS5。
- Tantivy等の検索エンジン。
- 小規模Workspaceではメモリ + 永続cache。

最初から大規模分散検索のような構成にはしない。

一般的な個人文書量で十分高速であることを優先する。

## Filesystem

Filesystem subsystemはWorkspace内の通常ファイルを扱う。

責務:

- read/write。
- create/delete。
- rename/move。
- directory操作。
- file watcher。
- atomic save。
- conflict detection。
- path normalization。

Windows上のファイル名大小文字、UNC path、長いpath、ジャンクション、シンボリックリンク等は個別に検証する。

Quire内部のpath表現はできる限りOS固有文字列表現に依存しない。

## History Adapter

履歴UIとGit実装を分離する。

Application Layerからは次のような概念で扱う。

- create_snapshot。
- list_snapshots。
- diff。
- restore_file。
- restore_workspace。

Git用語はHistory Adapter内部へ閉じ込める。

## Git履歴エンジン

既存Git repositoryとの共存を重要要件とする。

Quireの自動履歴によって次を勝手に変更しない。

- HEAD。
- current branch。
- staging index。
- user commit history。

第一候補として、Quire専用refへ独立したsnapshot commitを作る方式を検証する。

例:

```text
refs/quire/history/<workspace-id>
```

Git CLIを子processとして毎回呼び出すか、Rust libraryを使うかは技術スパイクで比較する。

候補:

- `git2` / libgit2。
- `gix`。
- Git CLI。

単に実装が簡単という理由だけでユーザー環境のGit状態を壊す方式は採用しない。

## Browser pane

Browserは文書作成時の資料参照機能として実装する。

WindowsではWebView2を第一候補とする。

Tauri v2はWebviewを作成するAPIを持つため、Quireの分割paneとの統合方法を技術検証する。

ただし、Tauriの通常WebView APIだけでQuireが必要とするWebView2固有機能へ十分アクセスできるとは限らない。

必要であればWindows側pluginまたはRust/Win32の薄いadapterを実装する。

## Browser extension

WebView2にはbrowser extensionをprofileへ追加するAPIが存在する。

そのため「Chromium拡張機能を一切利用できない」と決めつける必要はない。

一方、WebView2には通常ブラウザのtoolbar等が存在しないため、拡張機能が要求するUI entry pointには制約がある。

Quireでは最低限、次を技術検証する。

- unpacked extensionの読み込み。
- Manifest V3。
- content script。
- background/service worker。
- storage。
- permissions。
- extension更新。
- extension popup等のUI制約。
- Quire独自UIからextension機能を呼ぶ必要性。

Chrome Web Storeからそのまま任意拡張を導入できることを初期要件にはしない。

「一般的なChromium拡張資産をどの程度再利用できるか」を確認してから仕様化する。

### 参考

- Microsoft WebView2 `CoreWebView2Profile.AddBrowserExtensionAsync`
  - https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2profile.addbrowserextensionasync
- Microsoft WebView2 Win32 `ICoreWebView2Profile7`
  - https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2profile7
- Tauri v2 Webview API
  - https://v2.tauri.app/reference/javascript/api/namespacewebview/

## Command system

UI操作、ショートカット、Command Palette等を同じCommandへ集約する。

例:

```text
document.open
document.save
workspace.search
history.show
pane.split-right
browser.open
```

Commandは可能な範囲で表示部品から独立させる。

これにより、

- メニュー。
- ショートカット。
- Command Palette。
- 将来のplugin。
- AIからの操作。

を同じ操作単位へ接続しやすくする。

## Plugin / customization

初期版で巨大なplugin APIを先に設計しない。

OSS本体を変更しやすいことを優先する。

ただし将来の拡張を妨げないよう、次の境界は明確に保つ。

- Commands。
- Panels。
- Markdown extensions。
- Import/export。
- Index analyzers。
- External integrations。

本体機能をpluginに追放するための仕組みにはしない。

## IPC

FrontendとRust間のIPCは型を明示する。

自由形式JSONをアプリ全体で投げ合う設計にはしない。

通信を用途で分ける。

- 単発の要求と応答はTauri Commandを使用する。
- Editor redraw等の継続的なストリームはTauri Channelを使用する。
- 少量のグローバル通知等、複数consumerへ配信する意味がある場合だけTauri Eventを使用する。

Tauri公式文書ではEvent systemは低遅延・高スループット向けではなく、ストリーミングデータにはChannelを使用するよう明示されている。

Neovimの`redraw`は高頻度かつ順序保証が重要なため、通常Eventへ載せない。

Phase 2のNeovim UI SpikeではFrontend側で`Channel`を生成してRust commandへ渡し、Rust側の`tauri::ipc::Channel<T>`からredraw batchを順序付きで送信する方式を第一候補とする。

`flush`までのredrawを中間描画せず、Frontend側でbatchを適用してから画面へ反映する。

必要になった場合はChannel payloadのJSON serialization costも計測し、binary payloadを含む別方式と比較する。

### 参考

- Tauri v2 Calling the Frontend
  - https://v2.tauri.app/develop/calling-frontend/
- Tauri v2 Calling Rust
  - https://v2.tauri.app/develop/calling-rust/
- `tauri::ipc::Channel`
  - https://docs.rs/tauri/latest/tauri/ipc/struct.Channel.html

## Logging

初期段階から構造化されたログを持つ。

最低限:

- 起動。
- Workspace open。
- file watcher。
- index。
- Git history。
- Neovim process/RPC。
- WebView生成。
- fatal error。

ユーザー向け診断情報と開発者向け詳細ログを分ける。

ログがない状態で複数process/WebView/RPCの不具合を追わない。

## Error boundary

Neovim、Browser WebView、Index等の一部が落ちても、可能な限りQuire全体を終了させない。

subsystem単位で再起動可能な構造を目指す。

特に外部processであるNeovimの異常終了を通常の失敗ケースとして設計する。

## Repository structure

初期候補:

```text
Quire/
├─ src/                    # Solid / TypeScript
├─ src-tauri/
│  └─ src/
│     ├─ app/
│     ├─ workspace/
│     ├─ filesystem/
│     ├─ history/
│     ├─ index/
│     ├─ editor/
│     └─ browser/
├─ docs/
└─ tests/
```

最初からcrateを細分化しすぎない。

責務が実際に分かれてからworkspace crate等へ分割する。

## 技術スパイクの優先順位

アプリ全体を作る前に、失敗した場合の影響が大きい順に検証する。

1. Neovim embed + `ext_linegrid` + 日本語入力。
2. Tauri内での複数WebView / pane統合。
3. WebView2 browser extension。
4. 既存Git repositoryを汚さないSnapshot。
5. file watcher + 外部編集との競合。
6. Markdown previewとリンク解析。
7. Index方式の性能。

1から4の結果によって初期アーキテクチャを変更してよい。

## 採用判断

技術スパイクが「API上可能」で終わらないよう、次で判断する。

- 日常利用できる操作性か。
- Windowsで安定するか。
- 配布時にユーザー設定を要求しないか。
- 復旧可能か。
- 保守できる複雑さか。
- Quireの主要目的を改善するか。

特にNeovim統合とBrowser統合は、成立しない方式へ早期に見切りを付けられるよう独立して検証する。
