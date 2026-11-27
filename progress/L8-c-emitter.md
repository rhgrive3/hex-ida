# L8-c-emitter 実装完了報告 (Decompiler P1 構造化＆C出力)

- **worktree / ブランチ**: `/working_dir/c_50571edcf7098631/wt-L8-c-emitter` (`wt/L8-c-emitter`)
- **作成ファイル**:
  - `cpp/src/decompiler/c_emitter.hpp`
  - `cpp/src/decompiler/c_emitter.cpp`
  - `cpp/tests/test_c_emitter_native.cpp`
  - `progress/L8-c-emitter.md`

## 実装内容とレビュー修正の適用状況
1. **`hex_core.hpp` 準拠 & 非再帰設計**:
   - `std::unordered_map`・例外・RTTI・再帰を一切使用せず、構造化（`emit_body_iterative`）および式出力（`emit_expr`）をすべて明示スタック（`hex::Vec`）で実装。
   - 公開 C ABI 7 関数（`hex_decomp_reset`, `hex_decomp_emit_c`, `hex_decomp_emit_c_ex`, `hex_decomp_get_text_ptr`, `hex_decomp_get_text_len`, `hex_decomp_get_linemap_ptr`, `hex_decomp_get_linemap_count`）すべてに `HEX_WASM_EXPORT` を適用。Wave 2 統合用に `hex::decompiler::bind_arena(hex::Arena*)` を提供。
2. **ゼロコピー入力ビュー (`CEmitFunctionView`)**:
   - ブロック・命令（`CEmitInst`）・後続エッジ CSR・`idom`/`ipdom`・ループ情報（`loop_header`/`loop_parent`/`node_innermost_loop`）をポインタ渡しで受け取り、自己完結ビルドと Wave 2 `IrFunction`/`LoopResult` ゼロコピー接続を両立。
3. **過去レビュー修正の全適用**:
   - サブオペコードを `HEX_IR_BIN_*` (0..10), `HEX_IR_UN_*` (0..3), `HEX_IR_CMP_*` (0..9) に統一し、`flags & 0x0Fu` で抽出。
   - `HEX_EMIT_FLAG_JS_PARITY = 1u` / `hex_decomp_emit_c_ex` で JS `decompile()` 互換フォーマット（`/* hex: fixed-width integer types ... */`、`typedef __INT32_TYPE__ int32;` / `typedef __UINT64_TYPE__ uint64;`、4 スペースインデント、単一使用式の畳み込み `return a1 + a2;`、大文字 16 進リテラル `0xFFFFFFFF`）を出力。
   - Case 1 ヘッダテスト型 `while` でヘッダに実行文がある場合は `while (1) { <header>; if (!cond) break; <body>; }` へ展開。
   - `break;` / `continue;` / `goto` の `HexLineMapEntry` は遷移先ではなく遷移元ブロックの `block_id` と `addr` を記録。
   - `block_in_loop` を `node_innermost_loop` + `loop_parent` による $O(\text{depth})$（ループ上限ガード付き）で実装。
   - `ensure_text` の `UINT32_MAX` クランプ防御および空 `block_inst_off` のアンダーフロー防御を実装。

## 検証結果
- **Native ASan/UBSan** (`clang++ -std=c++20 -O1 -g -Wall -Wextra -Werror -fno-exceptions -fno-rtti -fsanitize=address,undefined`): **ALL 6 TEST SUITES PASS**（警告 0・エラー 0）。
- **wasm32 freestanding** (`clang++ --target=wasm32 -std=c++20 -O3 -Wall -Wextra -Werror -nostdlib -fno-exceptions -fno-rtti -mbulk-memory -Wl,--no-entry`): **PASS**（警告 0・32,014 bytes・外部 imports 0・公開 C ABI 7 エクスポート確認済）。
