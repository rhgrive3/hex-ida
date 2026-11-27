# Lane L4-arm64 Progress Report (永続再構築)

## 実装サマリ
`/working_dir/c_50571edcf7098631/wt-L4-arm64`（ブランチ `wt/L4-arm64`）にて、`js/words.js` の ARM64 命令ワード分類・デコーダおよび命令クラス対応表・厳密デコンパイラゲートを freestanding C++20/WASM で再構築しました。

### 追加ファイル
- `cpp/src/targets/arm64_decode.hpp`: `HexArm64Cap` (`HEX_ARM64_CAP_DECOMP`/`HEX_ARM64_CAP_FALLBACK`)、`HexArm64Kind` (0..26)、`HexArm64MemAccess`、`HexArm64PcRel`、`HexArm64PairedOffset`、`HexArm64Decoded` および全 23 公開 C ABI 関数（すべて `HEX_WASM_EXPORT` 統一適用）。
- `cpp/src/targets/arm64_decode.cpp`:
  - `js/words.js` 全機能（`classifyWord`, `decodeWord`, `branchImm26`, `condBranchTarget`, `literalTarget`, `wordTarget`, `pcRelTarget`, `pairedOffset`, `memoryAccess`, `compareImmediate`, `isStpToSp`, `isSubSp`, `looksLikePrologue`, `looksLikeEnd`）＋バッチ ABI（`hex_arm64_decode_batch`, `hex_arm64_decode_batch_pcs`, `hex_arm64_classify_batch`）。
  - 命令クラス対応表 `hex_arm64_kind_capability` および厳密ゲート `hex_arm64_is_decompiler_supported`（厳密な `MOVZ`/`MOVN`、2 オペランド `MUL`、非シフト GPR `ADD/SUB`、`ORR` レジスタ移動、標準 `RET` のみ許可し、`ORR imm`/`FMOV`/`MOVK`/`MNEG`/`SMULL`/`MADD`/`MOV sp`/`RETAA` を確実に `0` へフォールバック）。
  - テキストフォーマッタ: 未対応命令の `"udf"` 誤出力禁止（空文字）、post-index `disp == 0` の `, #0x0` 明示を完備。
- `cpp/tests/test_arm64_decode_native.cpp`: 実 ARM64 ELF バイナリ 4 種（全 86 命令）の `Words.decodeWord` 構造化全フィールド厳密照合＋capability 表＆厳密ゲート＋`#3936`/`#3975`/`#4032`/`#4180`/`#9629`・フォーマッタ回帰テスト。

## 検証結果
1. **Native (ASan + UBSan, `-Wall -Wextra -Werror`)**: `test_arm64_decode_native` **ALL PASS**（86 実 ELF 命令全フィールド 100% 一致＋capability ゲート＋全リグレッション PASS）。
2. **WASM (`--target=wasm32 -O3 -nostdlib -fno-exceptions -fno-rtti -mbulk-memory -Wall -Wextra -Werror -Wl,--no-entry`) + `wasm-opt -O3`**: **PASS（警告 0）**。
   - サイズ: `arm64_decode.wasm` = **23,030 bytes** / `arm64_decode.opt.wasm` = **22,985 bytes**（23 公開 C ABI 関数＋`memory` = 24 エクスポート確認）。
