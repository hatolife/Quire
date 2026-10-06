# Neovim UI Spike 実機テスト計画

## 目的

Phase 2のTauri/Solid/Canvas UIをWindows実機で確認する。

「Neovimの画面らしきものが表示された」だけでは合格にしない。

作者本人が日常的なMarkdown編集に使える入力品質へ到達できる見込みがあるかを判断する。

## 前提

- Windows 11。
- WebView2 Runtime。
- NeovimがPATHに存在する。
- `spikes/neovim-ui` がbuild済み。
- 日本語IMEが利用可能。

## 1. 起動

- アプリが起動する。
- Neovim processが一つ起動する。
- Canvasへ初期画面が表示される。
- statusが `connected` になる。
- アプリ終了後にNeovim processが残留しない。

## 2. 基本描画

- `~` 行等の初期Neovim画面が崩れない。
- cursor位置が入力位置と一致する。
- Window resize後にgridが追従する。
- 大きく拡大・縮小しても文字位置が累積してずれない。
- スクロール後に古い文字が残らない。
- syntax highlightのforeground/backgroundが反映される。
- bold / italic / underline / strikethroughを確認する。

## 3. ASCII入力

Insert modeで次を入力する。

```text
The quick brown fox jumps over the lazy dog.
0123456789 !@#$%^&*()_+-=[]{};:',.<>/?
```

確認:

- 欠落しない。
- 二重入力しない。
- cursorがずれない。
- Backspace、Delete、Enter、Tabが動く。
- Arrow、Home、End、PageUp、PageDownが動く。

## 4. Neovim mode

- `i` でInsert modeへ入る。
- `Esc` でNormal modeへ戻る。
- `hjkl`。
- `w`, `b`, `0`, `$`。
- `dd`, `yy`, `p`。
- Visual mode。
- Undo / Redo。
- `:` command-line。

ブラウザ側のshortcut処理がNeovimの通常キー操作を不必要に奪っていないことを確認する。

## 5. マウス

- 左クリックでcursorを移動する。
- 左ドラッグでVisual selectionできる。
- 中クリック、右クリックがNeovimへ届く。
- 縦ホイールでscrollする。
- 対応環境では横ホイールも確認する。
- Shift / Ctrl / Altを押したclickが修飾付きmouse eventとして届く。
- editor外へdragして戻した場合にbutton状態が壊れない。
- 右クリックでWebView標準context menuが割り込まない。

確認:

- click位置とNeovim cell位置が一致する。
- drag中にcursor位置が大きく飛ばない。
- wheel操作で描画に古い文字が残らない。
- mouse操作後もkeyboard / IME focusへ戻れる。

## 6. 日本語表示

次を既存ファイルまたは入力で表示する。

```text
日本語の表示確認。
全角１２３４５　ＡＢＣＤＥ
ひらがな カタカナ 漢字
「括弧」『二重括弧』、。！？
😀 🐦 🚀
```

確認:

- 全角文字が2 cellとして破綻しない。
- 右隣のcellと重ならない。
- ASCIIとの混在で位置がずれない。
- 絵文字で後続文字が大きくずれない。

## 7. 日本語IME

Insert modeでIMEをONにする。

入力例:

```text
きょうはいいてんきです
→ 今日はいい天気です
```

確認:

- composition開始が可能。
- 未確定文字列を操作できる。
- 変換候補を開ける。
- 候補windowがcursor付近へ出る。
- Spaceで変換できる。
- Enterで確定できる。
- Escapeで変換を取り消せる。
- Backspaceで未確定文字を削除できる。
- 確定後に同じ文字列が二重入力されない。
- 確定直後のcursor位置が正しい。
- IME OFF後にNormal mode操作へ自然に戻れる。

### 重要

Phase 1で確認した「UTF-8文字列を `nvim_input` へ送信できる」と、このIME確認は別物である。

ここが実用にならなければNeovim Editor方式の採用判断を見直す。

## 8. 長文・連続入力

- 5分以上連続で入力する。
- 1000文字以上入力する。
- 長い行を作る。
- 1000行以上のファイルをスクロールする。
- キーリピートを使う。
- 高速にNormal/Insert modeを切り替える。

確認:

- 入力欠落。
- 描画遅延の蓄積。
- redraw順序の破綻。
- CPU使用率の異常上昇。
- メモリ増加。

## 9. Resize / DPI

- Windowを連続resizeする。
- 最大化・元に戻す。
- Windows表示スケール100%。
- 可能なら125%、150%、200%。
- 異なるDPIのmonitor間を移動。

確認:

- Canvasのぼやけ。
- cell位置。
- cursor位置。
- IME候補位置。
- Neovim grid size。

## 10. 異常系

- Neovim processをTask Manager等から強制終了する。
- アプリ側が固まらない。
- closed/error状態を認識できる。
- 将来的に再起動可能な設計へ進められることを確認する。

現Spikeでは自動再起動未実装でもよい。

## 判定

### Phase 2継続

次を満たす場合、Neovim Canvas UI案を継続する。

- 基本描画が安定。
- 通常キー入力が欠落しない。
- 日本語表示が実用範囲。
- IME実装に解決不能な問題が見つからない。
- resize/DPIに構造的な破綻がない。

### 要改修

局所的に修正可能な場合は問題を記録し、Phase 2内で改修する。

### 方式再検討

次のいずれかが構造的に解決困難ならEditor Adapterを維持したまま代替方式を比較する。

- 日本語IME。
- Canvasでの文字cell整合。
- 高頻度redrawの性能。
- WebView focus/keyboard処理。
- Neovim plugin/UI機能との重大な非互換。
