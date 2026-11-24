# hex-ida エンジン ABI 仕様書 (`ABI.md`)

バージョン: `1.0.0` (`HEX_ABI_VERSION = 0x00010000`)  
ツールチェーン: freestanding `clang++ --target=wasm32 -std=c++20 -O3 -nostdlib -fno-exceptions -fno-rtti -mbulk-memory` + 生 C ABI (`HEX_WASM_EXPORT`)

## 1. レイヤー分離
- JS ホスト層（`js/ui/`, `js/ai/`, `js/auth/`, `js/userscript/`）は JS のまま維持し、エンジン内部構造体に直接触れず公開 C ABI・不透明ハンドル・DTO のみを使用する。
- 未移行アーキテクチャ・未対応命令・WASM エラー時は関数単位で自動的に JS 版へフォールバックし、理由コードを `js/core/wasm-telemetry.js` に記録する。

## 2. 3 論理アリーナ隔離 & `memory.grow` 規約
- **Scratch Arena**: 1 MiB 固定 (`Arena::init_fixed`)。全サブシステム（`image_store`, `identity_engine`, `resident_ir` 等）がポインタ共有し越境侵食を禁止。
- **Binary Arena**: 2 MiB 固定 (`Arena::init_fixed`)。常駐バイナリ・コード入力用。
- **Resident IR Arena**: 拡張可能 (`allow_wasm_grow = true`)。IR・CFG・SSA・最適化結果を WASM リニアメモリ内に常駐保持。
- **必須ルール**: WASM 関数呼び出し直後は必ず `wasm.memory.buffer` から新鮮な `TypedArray` / `DataView` を再取得する。

## 3. 公開 C ABI
- `hex_abi_version() -> 0x00010000`, `hex_runtime_init()`, `hex_runtime_binary_alloc()`, `hex_runtime_binary_reset()`, `hex_runtime_analyze_arm64_bytes()`, `hex_runtime_get_summary()`, `hex_runtime_release_ir()`
- `hex_decomp_optimize_ir()`, `hex_decomp_emit_c()`, `hex_decomp_emit_c_ex()` (`HEX_EMIT_FLAG_JS_PARITY`), `hex_decomp_get_text_ptr/len()`, `hex_decomp_get_linemap_ptr/count()`
- `hex_arm64_*`, `hex_x86_64_*`, `hex_identity_*`, `hex_image_*`, `cfg_*`, `hex_loop_*`, `hex_ir_*`
