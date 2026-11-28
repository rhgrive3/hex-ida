# L0: Core Fuzz, Golden Fixtures & Manifest

統合済み C++20/WASM コア（`cpp/include/hex_core/hex_core.hpp`）のファズ検証、ゴールデンフィクスチャ生成、およびコードベースマニフェストの現行構成をまとめる。

## 対象ファイル

- `cpp/tests/test_hex_core_fuzz.cpp`
- `scripts/generate-manifest.mjs`
- `scripts/generate-golden-fixtures.mjs`
- `scripts/generate-x86_64-golden.mjs`
- `fixtures/golden/binary-outputs.json`
- `fixtures/golden/arm64-decode-outputs.json`
- `fixtures/golden/cfg-outputs.json`
- `fixtures/golden/identity-outputs.json`
- `fixtures/golden/x86_64-decode-outputs.json`
- `MANIFEST.json`

## 構成と検証内容

1. **コアファズテスト (`cpp/tests/test_hex_core_fuzz.cpp`)**
   - `js_compat` 互換演算（`to_uint32`, `to_int32`, `to_uint16`, `trunc_f64`, `imul`, `shl32`, `ushr32`, `sar32`, `clz32`, `same_value_zero`, `same_value`, `normalize_zero`, `fnv1a_64`）のファズ検証。
   - `OrderedMap` / `OrderedSet` のステートフルファズ・`SameValueZero`（`+0/-0`、異ビット NaN）・OOM fail-closed 検証。
   - `stable_sort` の安定性検証、および `Vec` / `StringView` / `U16StringView` / `ArenaScope` / `clone_string` / `arena_alloc_zeroed` の境界検証（Native ASan + UBSan、`-std=c++20 -Wall -Wextra -Werror`）。
2. **ゴールデンフィクスチャ (`fixtures/golden/`)**
   - `binary-outputs.json`: 19 ケース（実バイナリ 13 本 + 破損/切り詰め/ミュータント 6 本）
   - `arm64-decode-outputs.json`: 170 命令（`Words.decodeWord` の構造化全フィールド）
   - `cfg-outputs.json`: 27 関数（`idom`, `ipdom`, `reachable`, `backEdges`）
   - `identity-outputs.json`: 7 レコード（`fnv64ByteView`, `stableDigestHex`, `stableStringify`）
   - `x86_64-decode-outputs.json`: 76 命令（x86_64 実バイナリ 3 本）
3. **コードベースマニフェスト (`MANIFEST.json`)**
   - `scripts/generate-manifest.mjs` により生成（1,028 ファイル / 371,938 行 / 12,422 関数 / 253 クラス / `parseErrors: 0`）。
