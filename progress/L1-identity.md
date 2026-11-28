# L1: Identity Engine (`cpp/src/core/identity_engine`)

統合済み `wasm/hex_engine.wasm`（`scripts/build-wasm.mjs`）に組み込まれている freestanding C++20/WASM 決定論的アイデンティティ・ハッシュ・JSON 文字列化エンジンの現行仕様。

## 対象ファイル

- `cpp/src/core/identity_engine.hpp`
- `cpp/src/core/identity_engine.cpp`
- `cpp/tests/test_identity_native.cpp`

## 実装内容

- **Freestanding C++20/WASM**: `cpp/include/hex_core/hex_core.hpp`（`Arena`, `Vec`, `OrderedMap`, `OrderedSet`, `stable_sort`, `js_compat`）および `cpp/include/hex_abi.hpp` のみを使用（STL・例外・RTTI・再帰なし）。
- **公開 C/WASM ABI (`HEX_WASM_EXPORT`)**:
  - `hex_identity_reset`, `hex_identity_alloc`
  - `hex_identity_fnv64_bytes` (FNV-1a-64)
  - `hex_identity_digest_utf8` (Dual FNV-1a-64 UTF-8→UTF-16), `hex_identity_digest_bytes` (Byte-native)
  - `hex_identity_stable_stringify` (固定長 `BigUint` Dragon4 + ECMA-262 7.1.12.1 浮動小数点最短文字列化、非再帰 `JsonParser` / `stringify_value_iterative`、深さ上限 128・129 で `HEX_ERR_RESOURCE_LIMIT`、配列インデックス優先＋UTF-16 コード単位辞書順ソート)
  - `hex_identity_merge_origins` (重複排除＋挿入順保持), `hex_identity_merge_origins_sorted` (UTF-16 昇順)
- **外部共有アリーナ契約**:
  - `hex::identity::bind_global_arena_ptr(hex::Arena*)` により `engine_runtime.cpp` 等の外部共有アリーナをバインド可能。バインド中は `hex_identity_reset()` が `&__heap_base` へ復帰せずバインド先アリーナのみをリセットする。
  - `hex::identity::bind_global_arena(buf, cap)` は `Arena::init_fixed` で固定バッファ境界を維持する。

## 検証

- **Native テスト**: `cpp/tests/test_identity_native.cpp`（ASan + UBSan、実バイナリゴールデン 7 件・特殊浮動小数点 38 ケース・NULL/深さ上限・共有アリーナ・OriginSet・OOM fail-closed）。
- **WASM 統合ビルド**: `node scripts/build-wasm.mjs` により `wasm/hex_engine.wasm` に統合ビルドされる。
