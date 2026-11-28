# L7: IR Optimizer (`cpp/src/decompiler/ir_optimizer`)

統合済み `wasm/hex_engine.wasm`（`scripts/build-wasm.mjs`）に組み込まれている freestanding C++20/WASM デコンパイラ IR 最適化パス群の現行仕様。

## 対象ファイル

- `cpp/src/decompiler/ir_optimizer.hpp`
- `cpp/src/decompiler/ir_optimizer.cpp`
- `cpp/tests/test_ir_optimizer_native.cpp`

## 実装内容

- **共通サブオペコード & `resident_ir.hpp` 連携**:
  - `HEX_IR_BIN_*` (`0..10`), `HEX_IR_UN_*` (`0..3`), `HEX_IR_FLAG_WIDTH32 = 0x10u` に準拠し、`cpp/src/semantics/resident_ir.hpp` の `hex::ir::IrFunction` / `default_store()` と直接接続する。
  - 公開 C/WASM ABI (`HEX_WASM_EXPORT`): `hex_decomp_optimize_ir`。
- **最適化パス**:
  - **UB-free 定数畳み込み**: 64/32-bit 符号なしラップ、シフト幅マスク（32-bit `& 31u` / 64-bit `& 63u`）、UB-free 算術右シフト (`asr32` / `asr64`)、`UDIV`/`UREM` ゼロ除算フォールバック。
  - **32-bit 単位元簡約の `ZEXT32` 保持**: `HEX_IR_FLAG_WIDTH32` 付き二項演算の単位元簡約（`ADD32(x, 0)` 等）を `HEX_IR_OP_UN` (`HEX_IR_UN_ZEXT32`) に書き換え、上位 32-bit ゼロ拡張セマンティクスを保持。
  - **非再帰 CSE (`CMP` 即値キー対応)**: ドミネータ木反復 DFS + `hex::OrderedMap<CseKey, uint32_t, CseKeyTraits>` で、`HEX_IR_OP_CMP` の `imm64_or_sym` をキーに含めて誤統合を防止。
  - **非再帰 DCE & 副作用保護**: `STORE`, `LOAD`, `CALL`, `BR`, `CBR`, `RET`, `STATE_WRITE`, `UNKNOWN` を確実にルート保護し、冗長 PHI 簡約を行う。
  - **固定スクラッチアリーナ**: BSS 固定 512 KiB `init_fixed` スクラッチで OOM 時に fail-closed。

## 検証

- **Native テスト**: `cpp/tests/test_ir_optimizer_native.cpp`（ASan + UBSan、定数畳み込み・`WIDTH32` 単位元簡約 `ZEXT32` 保持・ドミネータ木 CSE・冗長 PHI 簡約・副作用 8 命令の DCE 保護・OOM fail-closed・C ABI 境界チェック）。
- **WASM 統合ビルド**: `node scripts/build-wasm.mjs` により `wasm/hex_engine.wasm` に統合ビルドされる。
