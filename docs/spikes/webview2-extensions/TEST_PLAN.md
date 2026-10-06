# WebView2 Extensions Spike 実機テスト計画

## 1. 初回起動

- Spikeを起動する。
- `https://example.com` が表示される。
- ページ上部にQuire extensionのbannerが表示される。
- DevTools Consoleにextension起因の重大なerrorがない。

bannerが出ない場合、まずWebView2 Runtime versionとextension folderを確認する。

## 2. Content Script

DevTools Consoleで確認する。

```js
document.documentElement.dataset.quireExtensionSpike
```

期待値:

```text
active
```

page reload後も同じ状態になること。

## 3. Storage

extensionのDevToolsまたは適切なinspection方法で `chrome.storage.local` を確認する。

最低限、content scriptが保存した情報が存在すること。

- `lastContentScriptUrl`
- `lastContentScriptAt`

service worker側について次の値も確認する。

- `installedAt`
- `serviceWorkerInstalled`
- `lastStartupAt` またはservice worker起動を確認できる情報。

## 4. 再起動

- Spikeを終了する。
- 再度起動する。
- bannerが表示される。
- storageが意図せず全消去されていない。

`profile/` が永続data directoryとして機能することを確認する。

## 5. Extension変更

Spike停止中に `extension/content.js` のbanner文字列を一時的に変更して再起動する。

WebView2側の仕様により、インストール済みextensionと元folder内容の変更の関係を確認する。

検証後は変更を戻す。

## 6. Browser UI依存機能

将来、action/popupを持つ最小extensionを追加し確認する。

- extension自体がloadされるか。
- toolbar iconを置く場所が存在するか。
- popupを通常のChromeと同じ操作で開けるか。
- Quire側で代替UIを提供する必要があるか。

## 7. 判定

content script、service worker、storage、再起動後の動作が成立すれば、WebView2 Extensions Spikeの主要部分は合格候補とする。

popup等が制限されても、その制約が明確でcontent script型extensionを現実的に再利用できるならSpike全体を不合格とはしない。
