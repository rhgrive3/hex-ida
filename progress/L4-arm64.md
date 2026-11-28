# L4: ARM64 Decoder & Capability Gate (`cpp/src/targets/arm64_decode`)

統合済み `wasm/hex_engine.wasm`（`scripts/build-wasm.mjs`）に組み込まれている freestanding C++20/WASM ARM64 命令ワード分類・デコーダおよび厳密デコンパイラゲートの現行仕様。

## 対象ファイル

- `cpp/src/targets/arm64_decode.hpp`
- `cpp/src/targets/arm64_decode.cpp`
- `cpp/tests/test_arm64_decode_native.cpp`

## 実装内容

- **型定義 & 公開 C/WASM ABI (`HEX_WASM_EXPORT`)**:
  - `HexArm64Cap` (`HEX_ARM64_CAP_DECOMP` / `HEX_ARM64_CAP_FALLBACK`)、`HexArm64Kind` (0..26)、`HexArm64MemAccess`、`HexArm64PcRel`、`HexArm64PairedOffset`、`HexArm64Decoded`。
  - `js/words.js` 互換の 23 公開 C ABI 関数（`hex_arm64_classify_word`, `hex_arm64_kind_capability`, `hex_arm64_is_decompiler_supported`, `hex_arm64_kind_name`, `hex_arm64_atomic_op_name`, `hex_arm64_ordering_name`, `hex_arm64_mem_mode_name`, `hex_arm64_decode_word`, `hex_arm64_decode_batch`, `hex_arm64_decode_batch_pcs`, `hex_arm64_classify_batch`, `hex_arm64_branch_imm26`, `hex_arm64_cond_branch_target`, `hex_arm64_literal_target` 等）。
- **命令クラス対応表と厳密ゲート**:
  - `hex_arm64_kind_capability` および `hex_arm64_is_decompiler_supported` により、厳密な `MOVZ`/`MOVN`、2 オペランド `MUL`、非シフト GPR `ADD/SUB`、`ORR` レジスタ移動、標準 `RET` のみをネイティブ経路で許可し、`ORR imm`/`FMOV`/`MOVK`/`MNEG`/`SMULL`/`MADD`/`MOV sp`/`RETAA` 等は確実にフォールバック (`0`) する。
- **テキストフォーマッタ**:
  - 未対応命令での `"udf"` 誤出力を禁止（空文字）し、post-index `disp == 0` の `, #0x0` を明示する。

## 検証

- **Native テスト**: `cpp/tests/test_arm64_decode_native.cpp`（ASan + UBSan、実 ARM64 ELF バイナリ 4 種 86 命令の `Words.decodeWord` 全フィールド一致・capability ゲート・フォーマッタ回帰テスト）。
- **WASM 統合ビルド**: `node scripts/build-wasm.mjs` により `wasm/hex_engine.wasm` に統合ビルドされる。
