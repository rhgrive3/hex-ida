# L8: Structural C Emitter (`cpp/src/decompiler/c_emitter`)

統合済み `wasm/hex_engine.wasm`（`scripts/build-wasm.mjs`）に組み込まれている freestanding C++20/WASM 制御構造化および擬似 C コード出力エンジンの現行仕様。

## 対象ファイル

- `cpp/src/decompiler/c_emitter.hpp`
- `cpp/src/decompiler/c_emitter.cpp`
- `cpp/tests/test_c_emitter_native.cpp`

## 実装内容

- **Freestanding・完全非再帰設計**:
  - `hex_core/hex_core.hpp` のみを使用（STL・例外・RTTI・再帰なし）。構造化（`emit_body_iterative`）および式出力（`emit_expr`）を明示スタック（`hex::Vec`）で実装。
  - 公開 C/WASM ABI 7 関数 (`HEX_WASM_EXPORT`): `hex_decomp_reset`, `hex_decomp_emit_c`, `hex_decomp_emit_c_ex`, `hex_decomp_get_text_ptr`, `hex_decomp_get_text_len`, `hex_decomp_get_linemap_ptr`, `hex_decomp_get_linemap_count`。統合ランタイム向け共有アリーナ接続 `hex::decompiler::bind_arena(hex::Arena*)` を提供。
- **ゼロコピー入力ビュー (`CEmitFunctionView`)**:
  - ブロック・命令（`CEmitInst`）・後続エッジ CSR・`idom`/`ipdom`・ループ情報（`loop_header`/`loop_parent`/`node_innermost_loop`）をポインタ渡しで受け取り、`IrFunction` / `LoopResult` からゼロコピーで出力可能。
- **出力互換・安全性**:
  - サブオペコードを `HEX_IR_BIN_*` (0..10), `HEX_IR_UN_*` (0..3), `HEX_IR_CMP_*` (0..9) に統一し、`flags & 0x0Fu` で抽出。
  - `HEX_EMIT_FLAG_JS_PARITY = 1u` / `hex_decomp_emit_c_ex` により JS `decompile()` 互換フォーマット（固定幅整数 typedef ヘッダ、4 スペースインデント、単一使用式の畳み込み、大文字 16 進リテラル）を出力。
  - ヘッダに実行文がある Case 1 `while` ループを `while (1) { <header>; if (!cond) break; <body>; }` へ展開。
  - `break;` / `continue;` / `goto` の `HexLineMapEntry` は遷移元ブロックの `block_id` と `addr` を記録。
  - `block_in_loop` を `node_innermost_loop` + `loop_parent` による O(depth)（ループ上限ガード付き）で実装し、`ensure_text` の `UINT32_MAX` クランプ防御および空 `block_inst_off` のアンダーフロー防御を備える。

## 検証

- **Native テスト**: `cpp/tests/test_c_emitter_native.cpp`（ASan + UBSan、構造化・式出力・JS パリティ・ラインマップ・境界防御）。
- **WASM 統合ビルド**: `node scripts/build-wasm.mjs` により `wasm/hex_engine.wasm` に統合ビルドされる。
