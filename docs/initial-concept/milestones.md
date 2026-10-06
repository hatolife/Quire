# Quire 初期マイルストーン

## 目的

Quireを「機能一覧を順番に埋めるプロジェクト」にしない。

初期段階では、成立しなかった場合にアーキテクチャ全体へ影響する技術要素を先に検証する。

その後、文書を開くところから編集、検索、履歴、再起動までを一本につないだ縦切り実装を作る。

主要機能が揃うまでは正式なセマンティックバージョンを付けない。

開発ビルドはタイムスタンプ等で識別する。

## 完成の考え方

Quireの最初の完成条件は「Markdownを表示できた」ではない。

次の流れをQuireだけで日常的に行えることを最初の実用品の条件とする。

1. Workspaceを開く。
2. 文書を探す。
3. 文書を開く。
4. 編集する。
5. 保存する。
6. Previewする。
7. 画像等を追加する。
8. 他文書へリンクする。
9. 検索する。
10. Web資料を横で参照する。
11. 過去の状態を見る。
12. 必要なら戻す。
13. Quireを閉じる。
14. 再起動して作業を継続する。
15. 同じファイルをQuire以外からも通常通り利用する。

## Milestone 0: Initial Concept

### 目的

実装判断の基準を文章化する。

### 成果物

- `concept.md`
- `principles.md`
- `scope.md`
- `data-model.md`
- `architecture.md`
- 本文書

### 完了条件

- Quireを作る理由が記録されている。
- 本体責務と対象外の境界がある。
- 正本データとキャッシュの区別がある。
- 初期アーキテクチャ候補がある。
- 実装前に検証すべき高リスク項目が特定されている。

この文書群は後から変更してよい。

ただし変更時は、初期思想を単に削除して現在仕様だけへ置き換えない。

## Milestone 1: Architecture Spikes

### 現在の進捗

2026-10-06時点で、5種類すべてのSpikeについて検証コードを作成し、Windows CIでbuildまたは自動検証が成功している。

|Spike|自動検証|Windows build|実機UX確認|現状|
|---|---|---|---|---|
|Neovim Embed|成功|成功|一部未確認|ASCII / Normal mode / mouse / resize / IME確定入力は実機で成立。IME preedit表示を追加し再確認待ち。|
|Multi WebView Layout|対象外|成功|合格|同一Window内child WebView、pane resize、focus、hide/show、Window resize、通常Web操作を実機確認済み。|
|WebView2 Extensions|対象外|成功|主要目的合格|Manifest V3 unpacked extensionとcontent script注入を実機確認済み。service worker / storage等の詳細互換は継続確認する。|
|Git Snapshot Isolation|成功|成功|不要|一時index + Quire専用ref方式でHEAD / branch / user index / staged状態を保持できることを自動確認済み。|
|External File Changes|成功|成功|追加確認あり|create / modify / rename / move / delete / bulk変更 / Git checkout / dirty conflictをWindows CIで自動確認済み。|

CI確認基準commit:

```text
e56770fa550957de720e3e8fb412e282a4b81214
```

この時点ではMilestone 1完了とはしない。

Multi WebViewとWebView2 Extensionsは主要な成立性をWindows実機で確認済みである。

Neovim UIはIME確定入力まで成立しており、preedit表示の再確認後にSpike 1の採用判断を進める。

### 目的

Quireの根幹になる技術が実用レベルで成立するか確認する。

ここでは完成UIを作らない。

検証コードは捨ててもよい。

検証結果を文書へ残す。

### Spike 1: Neovim Embed

最優先。

#### 検証内容

- Rustから `nvim --embed` を起動。
- msgpack-rpc接続。
- `nvim_ui_attach`。
- `ext_linegrid` redrawの受信。
- Canvasまたは同等方式への描画。
- キー入力。
- cursor。
- mode。
- resize。
- mouse。
- clipboard。
- popup menu。
- floating window。
- syntax highlight。
- 複数buffer。
- 日本語表示。
- 日本語IME。
- 全角文字。
- 絵文字。
- WindowsのDPI scaling。
- Neovim異常終了。
- 再起動。

#### 合格条件

最低限、通常のMarkdown編集を30分程度継続しても入力・描画・IMEに重大な違和感がないこと。

単に英数字を入力できるだけでは合格にしない。

#### 不合格時

Editor Adapterを維持したまま、CodeMirror 6等の代替方式を比較する。

Neovim統合を守るためにQuire全体を無理な構造へ変更しない。

### Spike 2: Multi WebView Layout

#### 検証内容

- Tauri v2上でメインUIを起動。
- 同一Window内または同等UXでBrowser用WebViewを配置。
- pane resize。
- pane hide/show。
- focus移動。
- keyboard shortcutとの競合。
- Browser navigate。
- cookie/session維持。
- devtoolsの扱い。
- DPI scaling。
- Window resize。
- 複数Browser pane。

#### 合格条件

EditorやExplorer等のQuire UIとBrowser paneを、一つの作業画面として違和感なく利用できること。

独立Windowを並べただけの状態は最終方式として合格にしない。

### Spike 3: WebView2 Extensions

#### 検証内容

- browser extensions有効化。
- unpacked extension読み込み。
- Manifest V3。
- content script。
- service worker。
- storage。
- permissions。
- page reload後の維持。
- Quire再起動後の維持。
- UIを持たない拡張。
- popup等UIを持つ拡張の制約。

#### 合格条件

少なくともcontent script型の一般的な拡張を現実的に再利用できること。

Chromeそのものとの完全互換は要求しない。

制約を明文化できればよい。

### Spike 4: Git Snapshot Isolation

#### 目的

既存Git repositoryを壊さずQuire履歴を保存できることを確認する。

#### 検証内容

次の状態を作る。

- user branchに未commit変更あり。
- staging済み変更あり。
- untracked fileあり。
- Quire対象Documentにも変更あり。

その状態でQuire Snapshotを作成する。

#### 合格条件

Snapshot前後で次が一切変化しないこと。

- HEAD。
- current branch。
- user index。
- staged/unstaged状態。
- user commit history。

同時にQuire専用refからSnapshot内容を復元できること。

### Spike 5: External File Changes

#### 検証内容

Quire起動中に外部Editorからファイルを変更する。

- 未編集Document。
- Quire側に未保存変更があるDocument。
- rename。
- move。
- delete。
- 大量ファイル変更。
- Git checkout等による一括変更。

#### 合格条件

Indexが追従すること。

未保存内容を黙って破棄しないこと。

### Spike成果物

各Spikeは `docs/spikes/<name>/` 等へ次を残す。

- 目的。
- 実装方法。
- 実行方法。
- 結果。
- 問題点。
- 採用判断。
- スクリーンショット等、必要な検証資料。

## Milestone 2: Application Skeleton

### 現在の進捗

2026-10-06に本体実装を開始した。

初期構成:

```text
Cargo.toml
crates/
└─ quire-core/
apps/
└─ desktop/
   ├─ src/
   └─ src-tauri/
```

`quire-core` はTauriへ依存しないRust library crateとし、Workspace / Document等の中核処理を置く。

desktop側はTauri/Solidの薄いApplication/UI境界とする。

最初の縦切りとして次を実装済み。

- native directory pickerからWorkspaceを開く。
- Workspace直下およびdirectoryのlazy listing。
- Markdown Documentを開く。
- bootstrap text editorで編集する。
- markdown-itによるPreview。
- Document読込時のBLAKE3 revisionを保持する。
- 保存時にdisk側revisionを再確認する。
- 外部変更があればConflictとして保存を拒否する。
- 同一directory内の一時fileを経由して保存する。
- `.git/` をExplorer表示対象から除外する。
- relative pathのparent traversalを拒否する。

`quire-core` のunit testとWindows production buildはCIで成功している。

確認基準commit:

```text
9e8d2def690a3648d3393bf5134c3e93bdc6ae56
```

Windows artifact:

```text
quire-desktop-windows-v0.0.1.20261006161401.9e8d2de
```

現時点のtextarea editorはApplication Skeletonを先に通すためのbootstrap実装であり、最終Editorではない。

次にNeovim UI Spikeで成立した実装をEditor Adapter境界へ移植する。

### 目的

捨てる検証コードから、本体アーキテクチャへ移行する。

### 実装内容

- Tauri v2 application。
- Solid frontend。
- Rust Application Layer。
- typed IPC。
- logging。
- settings。
- Workspace open。
- basic file explorer。
- pane layoutの最小実装。
- Editor Adapter。
- Preview pane。

### 完了条件

Quireを起動し、既存フォルダをWorkspaceとして開き、Markdownを選択して編集・保存・Previewできる。

この段階では全文検索、Git履歴、Browserの完成は要求しない。

## Milestone 3: Vertical Slice

### 目的

Quireの基本ループを一本につなぐ。

### 実装内容

- Workspace。
- file explorer。
- Document create/rename/move/delete。
- Editor。
- Markdown Preview。
- Asset追加。
- Wiki Link等の最小リンク。
- backlink。
- file watcher。
- filename search。
- full-text search。
- History Snapshot。
- History list。
- file restore。
- Browser pane。
- layout persistence。
- session restore。

### 完了条件

サンプル用ではなく、実際の個人文書フォルダを一週間程度Quire中心で扱える状態にする。

重大なデータ損失リスクがないこと。

Quireを使うために手動Git操作や手動Index生成を必要としないこと。

## Milestone 4: Daily Use Alpha

### 目的

作者本人が既存の文書管理環境から日常利用を移せる状態にする。

### 必須領域

- 編集品質。
- 検索品質。
- keyboard operation。
- startup performance。
- large Workspace performance。
- error recovery。
- settings UI。
- history UX。
- Browser UX。
- layout UX。
- diagnostics/log。
- backup/restore確認。
- Windows packaging。

### Obsidian移行

実際に使用中のObsidian Workspace/VaultをQuireで開いて評価する。

初期段階ではimportによる変換より、既存フォルダをそのまま開けることを優先する。

確認対象:

- Markdown。
- attachments。
- Wiki Links。
- tags。
- front matter。
- relative links。
- directory structure。
- Obsidian固有構文。

未対応構文を黙って破壊しない。

### 完了条件

作者本人が「検証のため」ではなく、通常の文書作業にQuireを選択できること。

この時点で主要機能が一通り揃ったと判断できれば、その後に初めて `v0.1.0` を検討する。

ユーザーの明示的な判断なしに `v0.1.0` へ上げない。

## Milestone 5: Obsidian Replacement

### 目的

作者本人の利用範囲でObsidianを起動する必要をなくす。

### 内容

実際の利用で不足した機能を優先順位順に埋める。

機能一覧の網羅率ではなく、Obsidianへ戻る理由を一つずつなくす。

例:

- Obsidian互換記法。
- graph。
- advanced search。
- command palette。
- tabs。
- workspace layouts。
- themes。
- template。
- hotkeys。
- backlinks UX。
- embeds。
- properties。
- plugin/customization。

### 完了条件

通常運用でObsidianへ戻る必要がなく、既存データもQuire側で不自由なく利用できる。

## Milestone 6: Beyond Obsidian

### 目的

「Obsidian代替」からQuire独自の完成形へ進む。

候補:

- Gitを利用した高度な履歴UX。
- 強力なNeovim統合。
- Browserとの文書連携。
- Web clip。
- AIによる本体カスタマイズ支援。
- user-owned extensions。
- document automation。
- external tool integration。
- mobile。
- sync。

ここではObsidianに存在するかどうかを機能採否の基準にしない。

`principles.md` と実使用上の価値を基準にする。

## 実装順序の原則

各Milestone内でも次の順で優先する。

1. データ損失を防ぐ。
2. 根本アーキテクチャに関係する不確実性を潰す。
3. 一連の操作を最後まで通す。
4. 日常利用時の摩擦を減らす。
5. 高度な機能を追加する。
6. 見栄えだけの改善を行う。

画面だけ完成して内部が仮実装の状態を長期間維持しない。

機能を縦に完成させる。

## Build識別

主要機能が揃うまではSemVerの製品版番号を付けない。

必要な場合はタイムスタンプとcommit hashで開発ビルドを識別する。

例:

```text
20261006-103000.a1b2c3d
```

CIやパッケージング機能の検証でSemVerが必須な場合だけ `v0.0.x` 系を使用する。

## 直近の次作業

Milestone 1の5種類のSpikeは実装済みで、Windows CI上のbuild / 自動検証も通っている。

次は次の順で進める。

1. Neovim UI SpikeをWindows実機で確認する。
	- 30分程度のMarkdown編集。
	- 日本語IME。
	- 全角文字、絵文字。
	- mouse。
	- resize。
	- DPI scaling。
	- 異常終了と再起動。
2. Multi WebView Layout SpikeをWindows実機で確認する。
	- pane resize。
	- focus。
	- keyboard shortcut競合。
	- session。
	- DPI scaling。
	- 複数Browser pane。
3. WebView2 Extensions SpikeをWindows実機で確認する。
	- Manifest V3 content script。
	- service worker。
	- `storage.local`。
	- reload / 再起動後の維持。
	- browser UI依存extensionの制約。
4. 実機結果を各 `docs/spikes/` 配下へ記録し、採用判断を確定する。
5. Milestone 1の採用判断が揃ったらMilestone 2: Application Skeletonへ進む。

Git Snapshot IsolationとExternal File Changesについては、基本方式の自動検証が成立済みである。

ただし各READMEに列挙したedge caseはApplication Skeleton以降も継続して追加検証する。
