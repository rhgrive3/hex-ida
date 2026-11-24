# 永続再構築 実装記録: `L7-ir-opt` (Decompiler P1 最適化)

- **作業ディレクトリ**: `/working_dir/c_50571edcf7098631/wt-L7-ir-opt`
- **ブランチ**: `wt/L7-ir-opt`
- **作成ファイル**:
  - `cpp/src/decompiler/ir_optimizer.hpp`
  - `cpp/src/decompiler/ir_optimizer.cpp`
  - `cpp/tests/test_ir_optimizer_native.cpp`

## 1. 設計・レビュー修正の完備事項

1. **共通サブオペコード・幅フラグ規約**: `HEX_IR_BIN_*` (`0..10`), `HEX_IR_UN_*` (`0..3`), `HEX_IR_FLAG_WIDTH32 = 0x10u` を定義し、`#if __has_include("../semantics/resident_ir.hpp")` により Wave 2 マージ直後に `resident_ir.hpp` の `hex::ir::IrFunction` / `default_store()` へ無修正で自動接続可能（単独 worktree では互換 `hex::ir::IrFunction` 定義で自己完結ビルド）。
2. **UB-free 定数畳み込み**: 64/32-bit 符号なしラップ、シフト幅マスク（32-bit `& 31u` / 64-bit `& 63u`）、UB-free 算術右シフト (`asr32` / `asr64`)、`UDIV`/`UREM` ゼロ除算フォールバックを実装。
3. **32-bit 単位元簡約の `ZEXT32` 保持**: `HEX_IR_FLAG_WIDTH32` 付き二項演算の単位元簡約（`ADD32(x, 0)` 等）を 64-bit `MOV` ではなく `HEX_IR_OP_UN` (`HEX_IR_UN_ZEXT32`) に書き換え、上位 32-bit ゼロ拡張セマンティクスを保持。
4. **非再帰 CSE (`CMP` 即値キー対応)**: ドミネータ木反復 DFS + `hex::OrderedMap<CseKey, uint32_t, CseKeyTraits>` で、`HEX_IR_OP_CMP` の `imm64_or_sym` をキーに含めて誤統合を防止。
5. **非再帰 DCE 副作用保護 & 固定スクラッチ**: `STORE`, `LOAD`, `CALL`, `BR`, `CBR`, `RET`, `STATE_WRITE`, `UNKNOWN` を確実にルート保護。BSS 固定 512 KiB `init_fixed` スクラッチと `HEX_WASM_EXPORT("hex_decomp_optimize_ir")` を適用。

## 2. ビルド＆検証結果

- **Native ASan + UBSan** (`-std=c++20 -O2 -Wall -Wextra -Werror -fsanitize=address,undefined`): **警告 0 / ALL PASS**
  - 定数畳み込み（64/32 ラップ・シフトマスク・ゼロ除算フォールバック）: PASS
  - `WIDTH32` 単位元簡約 → `HEX_IR_UN_ZEXT32` 保持: PASS
  - ドミネータ木 CSE（`CMP` 即値区別 + 可換 `BIN`）: PASS
  - 冗長 PHI 簡約 + 副作用 8 命令の DCE 保護: PASS
  - OOM fail-closed + 無効引数 / C ABI 境界チェック: PASS
- **WASM32 ビルド** (`--target=wasm32 -std=c++20 -O3 -nostdlib -fno-exceptions -fno-rtti -mbulk-memory -Wall -Wextra -Werror -Wl,--no-entry -Wl,--export-dynamic`): **警告 0 / PASS** (`L7_ir_opt.wasm`)
