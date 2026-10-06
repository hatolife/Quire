# Neovim Embed Spike

## Status

実装開始。

これはMilestone 1の最初の技術スパイクであり、Neovim GUI統合の採用確定を意味しない。

## Purpose

Quireが `nvim --embed` を起動し、msgpack-rpc経由でUI clientとして接続できることを最小構成で確認する。

最初の段階ではCanvas描画より前に、Neovimとの通信境界そのものを検証する。

## Current checks

`spikes/neovim-embed/` は次を自動確認する。

- `nvim --embed --clean` の起動。
- `nvim_get_api_info`。
- `nvim_ui_attach`。
- `ext_linegrid`。
- `grid_line` redraw event。
- `flush` redraw event。
- `nvim_input`。
- 日本語を含むUTF-8文字列がbufferへ入ること。
- Neovimの正常終了。

CIはWindows runnerで実行する。

## Not verified yet

次はまだ合格判定していない。

- Canvas/WebGL等への実描画。
- font metrics。
- cursor描画。
- mode表示。
- mouse。
- clipboard。
- popup menu。
- floating window。
- syntax highlight。
- 複数buffer。
- DPI scaling。
- 日本語IME。
- IME変換中のpreedit表示。
- 長時間編集。
- 異常終了からの復旧。

特に「UTF-8日本語文字列をRPCで送れる」と「Windows上で日本語IMEを自然に使える」は別問題として扱う。

## Run

RustとNeovimがPATHにある環境で実行する。

```sh
cargo run --manifest-path spikes/neovim-embed/Cargo.toml
```

UI embedderはNeovim公式UI protocolのstartup手順に従い、`--headless` を付けずに起動する。

## References

- Neovim UI protocol
  - https://neovim.io/doc/user/api-ui-events/
- Neovim API
  - https://neovim.io/doc/user/api/
