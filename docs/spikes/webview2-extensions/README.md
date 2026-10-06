# WebView2 Extensions Spike

## 目的

QuireのBrowser paneで、既存のChromium系拡張機能をどこまで再利用できるか確認する。

Chromeそのものとの完全互換を前提にしない。

最初に、Quireが必要とする可能性が高いcontent script型拡張が現実的に動作することを確認する。

## 実装

Tauri v2 / Wryが公開している次の機能を使う。

- `browser_extensions_enabled(true)`
- `extensions_path(...)`
- 永続的なWebView2 data directory

WindowsではWebView2のbrowser extension機能を利用する。

同梱する検証用extensionはManifest V3で、次を含む。

- content script。
- service worker。
- `storage.local`。
- `https://example.com/*` へのcontent script injection。

content scriptが動作するとページ上部に次のbannerが出る。

```text
Quire WebView2 extension: content script active
```

## 実行

前提:

- Windows 11。
- Rust。
- WebView2 Runtime 120.0.2210.55以降。

```sh
cargo run --manifest-path spikes/webview2-extensions/src-tauri/Cargo.toml
```

## 確認すること

- extensionが読み込まれる。
- Manifest V3 content scriptが実行される。
- service workerが成立する。
- `chrome.storage.local` が利用できる。
- reload後もextensionが動作する。
- Quire再起動後もextensionが動作する。
- profile/data directoryの扱い。
- extension folderを変更した場合の挙動。
- popup / badge / toolbar action等のbrowser UI依存機能の制約。

## 既知の制約

WebView2ではbrowser extensionは既定で無効で、Environment作成時に有効化する必要がある。

unpacked extensionはローカルfolderから読み込む。

WebView2にはChrome/Edge本体と同じtoolbar UIが存在しないため、toolbar icon、popup、badge等を前提にするextensionは、そのUI entry pointをそのまま利用できない可能性がある。

Quireで重要なのは「Chrome完全互換」ではなく、content script等の再利用価値が高い部分をどこまで自然に使えるかである。

## 判定

### 継続

次を満たせばWebView2 extension利用を継続候補とする。

- Manifest V3 content scriptが安定して動作する。
- service workerとstorageが利用できる。
- reload / 再起動後の挙動を説明できる。
- Browser paneのprofile設計と両立できる。

### 方式再検討

content scriptすら安定しない、またはprofile分離とextension有効化がQuireのBrowser構成と両立しない場合は、userscript等の代替方式を比較する。
