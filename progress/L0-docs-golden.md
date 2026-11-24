# L0-docs-golden 完了レポート（永続環境 9並列再構築）

- 作業ディレクトリ: `/working_dir/c_50571edcf7098631/wt-L0-docs-golden`（ブランチ `wt/L0-docs-golden`）

## 1. 成果物一覧（許可範囲内のみ）
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
- `progress/L0-docs-golden.md`

## 2. 検証結果
1. **`test_hex_core_fuzz.cpp` (Native ASan + UBSan, `-std=c++20 -O2 -Wall -Wextra -Werror -fsanitize=address,undefined`)**:
   - `js_compat` 100,000 回ファズ（`to_uint32`, `to_int32`, `to_uint16`, `trunc_f64`, `imul`, `shl32`, `ushr32`, `sar32`, `clz32`, `same_value_zero`, `same_value`, `normalize_zero`, `fnv1a_64`）: **PASS**
   - `OrderedMap`/`OrderedSet` 60,000 回ステートフルファズ＋`SameValueZero`（`+0/-0`, 異ビット NaN）＋ OOM fail-closed: **PASS**
   - `stable_sort` 1,000 配列安定性検証＋ OOM fail-closed: **PASS**
   - `Vec` / `StringView` / `U16StringView` / `ArenaScope` / `clone_string` / `arena_alloc_zeroed`: **PASS**
   - 警告 0・エラー 0。
2. **ゴールデンフィクスチャ生成 (`scripts/generate-golden-fixtures.mjs` & `scripts/generate-x86_64-golden.mjs`)**:
   - `binary-outputs.json`: **19 ケース**（実バイナリ 13 本＋破損/切り詰め/ミュータント 6 本）
   - `arm64-decode-outputs.json`: **170 命令**（`Words.decodeWord` 構造化全フィールド：`kind`, `kindName`, `rd`, `rn`, `rm`, `target`, `pcRel`, `pcRelReg`, `pcRelPage`, `compareWith`, `memLoad`, `memStore`, `memSize`, `memBase`, `memDisp`）
   - `cfg-outputs.json`: **27 関数**（`nodes[i].succ` 経由の `idom`, `ipdom`, `reachable`, `backEdges`）
   - `identity-outputs.json`: **7 レコード**（`fnv64ByteView`, `stableDigestHex`, `stableStringify`）
   - `x86_64-decode-outputs.json`: **76 命令**（Capstone x86_64 実バイナリ 3 本）
3. **マニフェスト生成 (`scripts/generate-manifest.mjs`, `acorn`)**:
   - `MANIFEST.json`: 全 **1,028 ファイル** / **371,938 行** / **12,422 関数** / **253 クラス** / **`parseErrors: 0`**。
