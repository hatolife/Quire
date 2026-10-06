# Multi WebView Layout Spike 実機テスト計画

## 目的

Tauri v2のchild WebViewを、QuireのBrowser paneとして日常利用できるかWindows実機で確認する。

「同じWindowにWebページが表示された」だけでは合格にしない。

Editor、Explorer、Preview等と同じ分割レイアウト内で、Browser paneとして自然に扱えることを確認する。

## 前提

- Windows 11。
- WebView2 Runtime。
- `spikes/multi-webview` がbuild済み。
- ネットワーク接続が利用可能。

## 1. 起動

- アプリが起動する。
- 左側にQuire UI、右側に `https://example.com` が表示される。
- Browserが別Windowとして開かない。
- statusが `browser created` からサイズ表示へ遷移する。
- アプリ終了時に関連Window/processが不自然に残留しない。

## 2. Pane配置

以下を順に切り替える。

- 30 / 70。
- 50 / 50。
- 70 / 30。

確認:

- Browser境界がQuire UI側の想定位置と一致する。
- Browserが隣のpaneへ重ならない。
- Browserの下に不自然な空白が生じない。
- 比率変更を繰り返しても位置ずれが累積しない。

## 3. Window resize

- Windowを左右へ広げる、狭める。
- Windowを上下へ広げる、狭める。
- 最大化する。
- 元のサイズへ戻す。
- 最小化して復帰する。

確認:

- Browserが追従する。
- 境界にちらつきや大きな遅延がない。
- resize後もBrowserを操作できる。
- 主WebViewとchild WebViewの位置関係が崩れない。

## 4. Focus

- Quire UI上のbuttonを操作する。
- `Focus browser` を押す。
- Browser内をmouse clickする。
- Browser内でTab移動する。
- 再びQuire UIへfocusを戻す。

確認:

- focusが意図したpaneへ移動する。
- Browserへfocusした後にQuire UIが操作不能にならない。
- Quire UIへ戻った後もBrowserがkeyboard入力を奪わない。

## 5. Keyboard shortcut競合

Browser側で次を確認する。

- Ctrl+A。
- Ctrl+C。
- Ctrl+V。
- Ctrl+F。
- Tab / Shift+Tab。
- Arrow key。
- PageUp / PageDown。
- Home / End。

Quire側で将来global shortcutにする候補と競合した場合、どちらが受け取るか記録する。

Browser固有shortcutをQuireが無条件に奪う設計にはしない。

## 6. Mouse

- click。
- text selection。
- wheel scroll。
- middle click。
- right click。
- drag。

確認:

- mouse座標にずれがない。
- pane境界付近でも隣paneへ誤入力しない。
- Browser標準context menuの扱いを確認する。

## 7. Hide / Show

- `Hide browser`。
- `Show browser`。
- 連続して複数回実行する。
- hide中にWindow resizeしてからshowする。

確認:

- hideでBrowserだけが消える。
- Quire UIは操作できる。
- show後に最新pane位置へ復帰する。
- page stateが不要に失われない。

## 8. Session

初期Spikeではexample.comだけなので、必要に応じて一時的に一般サイトへURLを変更して確認する。

- Cookieが設定されるサイトを開く。
- page reload。
- Browser hide/show。
- Quire再起動。

確認:

- 同一実行中のsession維持。
- 再起動後のprofile/session維持。
- main UI用WebViewとBrowser用WebViewのstorage境界。

最終的なprofile方針はこの結果を基に決定する。

## 9. DPI scaling

Windows表示スケールを可能な範囲で確認する。

- 100%。
- 125%。
- 150%。
- 200%。

複数monitorがある場合:

- 異なるDPIのmonitor間を移動する。

確認:

- Browserの左上位置。
- Browserの幅、高さ。
- pane境界。
- mouse hit位置。
- Window移動直後の追従。

Logical座標とWebView2側座標の変換に構造的なずれがないことを確認する。

## 10. 複数Browser pane

現Spikeは1 paneのみ実装している。

1 paneの実機結果が良好なら次段階で2つ以上のchild WebViewを追加し、以下を確認する。

- 複数WebViewを同一Windowへ配置できる。
- 個別にfocusできる。
- 個別にresizeできる。
- 個別にhide/showできる。
- Cookie/profile共有方針を制御できる。
- resource消費が許容範囲である。

この項目が未確認の間はSpike 2を完全合格にはしない。

## 判定

### 継続

次を満たす場合、Tauri child WebView方式を継続する。

- 同一Window内paneとして違和感がない。
- resize / DPIで構造的な位置ずれがない。
- focus移動が安定する。
- keyboard / mouse操作が実用的。
- sessionを意図した方式で維持できる。
- 複数paneへ拡張可能。

### 要改修

局所的なposition同期、focus、resizeの問題であればSpike内で修正する。

### 方式再検討

次が構造的に解決困難なら代替案を比較する。

- child WebViewとDOM paneの位置同期。
- DPI scaling。
- focus / shortcut競合。
- 複数Browser pane。
- session/profile管理。
- Tauri `unstable` APIへの依存が許容できない場合。
