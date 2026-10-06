# Neovim Embed Spike Result

## 2026-10-06: Phase 1 RPC / ext_linegrid

### Result

成功。

Windows GitHub Actions上で、Quire側プロセスからNeovimを `--embed` で起動し、msgpack-rpcによる最小UI clientとして接続できた。

### Environment

- GitHub Actions `windows-latest`
- Windows Server 2025
- Rust 1.99.0
- Neovim 0.12.5

### Verified

- `nvim --embed --clean` を子processとして起動できる。
- stdin/stdoutをmsgpack-rpc transportとして利用できる。
- `nvim_get_api_info` が成功する。
- `nvim_ui_attach` が成功する。
- `ext_linegrid=true` でredraw notificationを受信できる。
- `grid_line` eventを受信できる。
- `flush` eventを受信できる。
- `nvim_input` で入力できる。
- 日本語を含むUTF-8文字列を入力してbufferから同一内容を取得できる。
- Neovim processを終了できる。

CIで確認した出力:

```text
channel_id=1
current_line=Quire 日本語 UTF-8 test
grid_line_events=2
flush_events=2
```

### What this proves

Quireが独自UIを実装する前提となる、

```text
Quire
  ↓ msgpack-rpc
nvim --embed
  ↓ redraw
ext_linegrid events
```

の基本経路はWindows上で成立する。

Neovim公式UI protocolでは、新規UIは従来のcell-by-cell protocolではなく `ext_linegrid` を利用することが推奨されているため、初期アーキテクチャ案と矛盾しない。

### What this does not prove

今回の成功はNeovim GUI統合全体の採用判断ではない。

次は未検証。

- `grid_line` を実際のCanvasへ正しく描画できるか。
- highlight。
- cursor。
- mode。
- popup menu。
- floating window。
- mouse。
- clipboard。
- resize。
- DPI scaling。
- 日本語IME。
- composition中のpreedit表示。
- 実際のNeovim設定を読み込んだ場合の動作。
- pluginとの互換性。
- 長時間編集。
- process crashからの復旧。

特に今回確認した「UTF-8日本語文字列をRPCで送信できる」は、日本語IMEの実用性を意味しない。

IMEは別途Windows実機で確認する。

## CI fixes found during spike

技術本体以外に次を確認した。

ChocolateyでNeovimをインストールした直後、そのPATH変更は後続GitHub Actions stepへ自動反映されない。

そのため `C:\tools\neovim\nvim-win64\bin` を `GITHUB_PATH` へ明示的に追加した。

## Decision

Phase 1については `nvim --embed + ext_linegrid` を継続候補とする。

次はPhase 2として、redraw eventを画面へ描画する最小UIを作る。

Phase 2でも採用確定にはしない。

最終判断には日本語IMEを含む実用編集検証が必要。
