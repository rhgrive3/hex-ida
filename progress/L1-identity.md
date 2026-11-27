# L1-identity (P0) Progress Report — Persistent Worktree Rebuild

## 1. 成果物（許可4ファイルのみ）
- `cpp/src/core/identity_engine.hpp`
- `cpp/src/core/identity_engine.cpp`
- `cpp/tests/test_identity_native.cpp`
- `progress/L1-identity.md`

## 2. 実装内容（全レビュー修正＋外部共有アリーナ対応を完備）
- **Freestanding C++20/WASM**: `cpp/include/hex_core/hex_core.hpp`（`Arena`, `Vec`, `OrderedMap`, `OrderedSet`, `stable_sort`, `js_compat`）および `cpp/include/hex_abi.hpp` の `HEX_WASM_EXPORT` のみを使用（STL・`std::unordered_map`・例外・RTTI・再帰なし）。
- **1-bit 完全一致アルゴリズム**:
  - FNV-1a-64 (`hex_identity_fnv64_bytes`)、Dual FNV-1a-64 UTF-8→UTF-16 (`hex_identity_digest_utf8`)、Byte-native (`hex_identity_digest_bytes`)。
  - 固定長 `BigUint` (44 limbs) による freestanding Dragon4 + ECMA-262 7.1.12.1 浮動小数点最短文字列化（`-0.0`, `1.15`, `1e-7`, `1e20`, `5e-324`, `Number.MAX_VALUE` 含む 38 ケースで Node.js `JSON.stringify` と 100% 一致）。
  - 非再帰 `JsonParser` および非再帰・NULL 安全 `stringify_value_iterative`（深さ上限 128・129 で `HEX_ERR_RESOURCE_LIMIT`、配列インデックス優先＋UTF-16 コード単位辞書順ソート）。
  - `hex_identity_merge_origins`（重複排除＋挿入順保持）および `hex_identity_merge_origins_sorted`（UTF-16 昇順）。
- **共有アリーナ契約**:
  - `hex::identity::bind_global_arena_ptr(hex::Arena* arena)` により外部共有アリーナ（`g_active_arena`）をバインド可能。バインド中に `hex_identity_reset()` が呼ばれても `&__heap_base` へ復帰せず `g_active_arena->reset()` のみ実行。
  - `hex::identity::bind_global_arena(buf, cap)` は `Arena::init_fixed` を使用し、固定バッファ境界を維持。

## 3. 検証結果
- **Native (ASan+UBSan, `-std=c++20 -O2 -Wall -Wextra -Werror`)**: 警告 0、`test_identity_native` ALL PASS（7/7 実バイナリゴールデン・38 特殊浮動小数点・NULL/深さ 128/129・`bind_global_arena_ptr` 非復帰・OriginSet・OOM）。
- **WASM (`--target=wasm32 -std=c++20 -O3 -nostdlib -fno-exceptions -fno-rtti -mbulk-memory -Wall -Wextra -Werror -Wl,--no-entry` + `wasm-opt -O3 --enable-bulk-memory`)**: 警告 0、38,906 bytes、全 8 公開関数エクスポート確認・Node.js `JSON.stringify` クロスチェック PASS。
