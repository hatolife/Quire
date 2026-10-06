# Multi WebView Layout Spike

## 目的

Tauri v2で、Quire UIとBrowser paneを同一Window内に配置し、paneとして実用的に扱えるか確認する。

独立Windowを並べるだけの方式は合格としない。

## 実装方式

Tauri v2のchild WebView APIを使用する。

現行Tauri v2では、同一Windowへ複数WebViewを追加するAPIは `unstable` featureが必要である。

主WebViewにSolid製のQuire UIを表示し、そのDOM上のBrowser領域と同じlogical座標へchild WebViewを重ねる。

Browser領域の `ResizeObserver` からchild WebViewへposition/sizeを反映する。

## 現在の検証内容

- 同一Window内の主WebView + child WebView。
- 30/70、50/50、70/30のpane比率変更。
- Window resize追従。
- child WebView focus。
- hide / show。
- WebView上の通常Web操作。
- Windows DPI変更時の位置・サイズ整合。

初期URLは `https://example.com` とする。

## 実行

前提:

- Rust。
- Node.js。
- WebView2 Runtime。

```sh
cd spikes/multi-webview
npm install
npm run tauri dev
```

## 合格条件

- Browserが独立WindowではなくQuire UIと同じWindow内に見える。
- pane比率変更とWindow resizeで境界が破綻しない。
- Quire UIとBrowserのfocusを行き来できる。
- Browser側でkeyboard/mouse操作できる。
- 100%以外のDPIでも大きな位置ずれがない。
- child WebViewの存在により主UIの操作が不安定にならない。

## 重要な制約

child WebView生成はTauriのunstable APIに依存する。

この依存が長期的に許容できるかは、技術成立性とは別に採用判断で評価する。

## 参考

- Tauri Webview API
  - https://v2.tauri.app/reference/javascript/api/namespacewebview/
- Tauri core permissions
  - https://v2.tauri.app/reference/acl/core-permissions/

## 実機確認 2026-10-06

Windows実機でproduction executableを起動し、次を確認した。

- localhost依存なく起動した。
- 左側のQuire UI WebViewと右側のchild WebViewが同一Window内に表示された。
- child WebViewで `https://example.com` を表示できた。
- Browser paneの初期bounds同期が成立した。

初期表示に加えて、今回提示した実機チェック項目をすべて確認し、問題は確認されなかった。

- pane比率変更。
- focus移動。
- hide / show。
- Window resize追従。
- Browser側のmouse / keyboard操作。
- Quire UI側へのfocus復帰。

同一Window内child WebView方式は、現時点のSpike目的に対して合格とする。

複数Browser paneやより詳細なDPI差異などは本体実装時にも継続確認する。
