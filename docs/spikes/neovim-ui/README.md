# Neovim UI Spike

## Status

Phase 2実装開始。

Phase 1で確認した \`nvim --embed + ext_linegrid\` を、実際のTauri/Solid画面へ接続する。

## Architecture

\`\`\`text
Neovim
  ↓ msgpack-rpc redraw
Rust
  ↓ Tauri Channel<StreamMessage>
Solid
  ↓ grid model
Canvas
\`\`\`

Neovim redrawを通常のTauri Eventへ流さない。

Tauri公式文書ではEvent systemは低遅延・高スループット用途向けではなく、ストリーミングにはChannelが推奨されているため、Phase 2ではChannelを使用する。

## Current implementation

- Tauri v2。
- Solid + TypeScript。
- Rustから \`nvim --embed --clean\` を起動。
- \`ext_linegrid\` をattach。
- redraw batchを解析。
- 以下をTauri Channel経由でFrontendへ送る。
  - \`grid_resize\`
  - \`grid_clear\`
  - \`grid_line\`
  - \`grid_cursor_goto\`
  - \`grid_scroll\`
  - \`default_colors_set\`
  - \`hl_attr_define\`
  - \`flush\`
- Canvas上にgridを描画。
- foreground/background、bold、italic、underline、strikethroughの最小描画。
- \`flush\` 到達時だけCanvasを再描画。
- Window resizeから \`nvim_ui_try_resize\`。
- キー入力を \`nvim_input\` へ転送。
- IME用に非表示textareaをcursor付近へ配置。

## Important limitation

IME用textareaを追加しただけでは日本語IMEの実用性は確認できない。

Windows + WebView2上で次を実機確認する必要がある。

- IME ON/OFF。
- 変換前文字列。
- 候補window位置。
- 変換確定。
- Backspace/Enter/Escape。
- Neovim Normal/Insert modeとの切り替え。
- 長文入力。
- DPI scaling。

この確認が通るまではNeovim editor採用確定にしない。

## Run

前提:

- Rust。
- Node.js。
- NeovimがPATHに存在すること。

\`\`\`sh
cd spikes/neovim-ui
npm install
npm run tauri dev
\`\`\`

## CI

CIではGUI操作そのものは検証しない。

以下だけを自動確認する。

- Solid/TypeScript frontendがbuildできる。
- Tauri/Rust backendがcompileできる。

実描画とIMEはWindows実機検証を別途行う。

## References

- Tauri: Calling the Frontend
  - https://v2.tauri.app/develop/calling-frontend/
- Tauri: Calling Rust
  - https://v2.tauri.app/develop/calling-rust/
- Neovim UI protocol
  - https://neovim.io/doc/user/api-ui-events/
