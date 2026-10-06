# External File Changes Spike

## 目的

Quire起動中にWorkspaceが外部から変更されても、Indexを追従させ、未保存Documentを黙って破棄しない方式を確認する。

## 基本方針

filesystem watcherのevent列そのものを正本にはしない。

watcherは「この周辺を再確認すべき」というinvalidate通知として扱う。

通知後にfilesystemを再読し、その時点の実ファイル状態からIndexを更新する。

この方針により、OSごとのrename event差、event coalescing、大量変更時のevent粒度差にQuireのデータモデルを依存させない。

## 実装

Rustの `notify` crateを使用する。

`recommended_watcher` を使い、WindowsではReadDirectoryChangesW backendを利用する。

Spikeは一時Workspaceを作り、次を自動検証する。

- create。
- modify。
- rename。
- directory間move。
- delete。
- 200ファイルの一括作成。
- Git checkoutによる外部変更。
- Quire側に未保存bufferがある状態での外部変更。

## Dirty Document

QuireがDocumentを開いた時点のdisk内容をbaseとして保持する。

外部変更通知後にdiskを再読する。

- Quire側がdirtyでない: 新しいdisk内容へreload可能。
- Quire側がdirtyで、diskがbaseから変化: Conflict。
- diskがbaseと同じ: 変更なし。

Conflict時にlocal bufferを自動上書きしない。

本実装では差分表示、keep local、reload external、merge等のUXを別途設計する。

## 大量変更

全eventを完全に受信できたことをIndex整合性の条件にはしない。

一件以上のinvalidateを受け取った後、必要な範囲を再走査して最終状態を確定する。

Git checkout等の大きな変更ではWorkspace単位の再走査へ昇格できる設計にする。

## 実行

```sh
cargo run --manifest-path spikes/external-file-changes/Cargo.toml
```

GitがPATHに必要。

## 合格条件

- 通常の外部変更を検出できる。
- rename/move/delete後の実状態を再走査で確定できる。
- 大量変更後に最終filesystem状態へ収束できる。
- Git checkout等の一括変更を検出できる。
- dirty Documentを黙って上書きしない。

## 未検証

- network filesystem。
- removable drive。
- permission error。
- symlink/junction。
- Workspace root自体のrename/delete。
- watcher overflowを明示的に検出できるbackendでの挙動。
- 数十万ファイル規模の再走査性能。
- editor save時に発生する一時file + atomic rename pattern。
- 複数processが同時に高速更新する場合。

これらはApplication Skeleton以降も継続して検証する。
