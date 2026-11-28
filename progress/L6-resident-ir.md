# L6: Resident IR & SSA Engine (`cpp/src/semantics/resident_ir`)

統合済み `wasm/hex_engine.wasm`（`scripts/build-wasm.mjs`）に組み込まれている freestanding C++20/WASM Resident IR ストアおよび CFG/DF/Cytron SSA エンジンの現行仕様。

## 対象ファイル

- `cpp/src/semantics/resident_ir.hpp`
- `cpp/src/semantics/resident_ir.cpp`
- `cpp/tests/test_resident_ir_native.cpp`

## 実装内容

- **統一サブオペコード規約 & ストア構造 (`resident_ir.hpp`)**:
  - サブオペコード定数（`HEX_IR_BIN_*` 0..10、`HEX_IR_UN_*` 0..3、`HEX_IR_SUBOP_MASK = 0x0fu`、`HEX_IR_FLAG_WIDTH32 = 0x10u`）を一元定義。
  - 世代付き `HexIrHandle`、SoA 形式の `IrFunction` / `IrBlock` / `IrInst`、永続・スクラッチ 2 アリーナ分離の `IrStore`。
  - 公開 C/WASM ABI 7 関数 (`HEX_WASM_EXPORT`): `hex_ir_create`, `hex_ir_release`, `hex_ir_add_block`, `hex_ir_add_edge`, `hex_ir_add_inst`, `hex_ir_run_cfg_and_ssa`, `hex_ir_get_stats`。
- **自己完結・完全非再帰 SSA 構築 (`resident_ir.cpp`)**:
  - 到達性 DFS・Cooper-Harvey-Kennedy 支配木・Euler tour (`tin`/`tout`/`depth`)・Kosaraju SCC・逆グラフ PostDom・支配ガード付き自然ループヘッダ検出。
  - 2 パス Dominator Frontier、`dense_to_var` 変数 ID 昇順 `stable_sort` 後 φ 配置、`total_phi_incoming` 32-bit オーバーフローおよび上限チェック (`HEX_ERR_RESOURCE_LIMIT`)。
  - 非再帰 Cytron リネーミング、`phi_incoming` `stable_sort` 後の `record_use`（`operand_slot` 完全整合）、`ScratchGuard` による一時データ O(1) 回収、`active_count_ == 0` 時の永続アリーナ自動リセット、128-bit 構造ダイジェスト。

## 検証

- **Native テスト**: `cpp/tests/test_resident_ir_native.cpp`（ASan + UBSan、統一サブオペコード・ダイヤモンド・ループ/エントリループ/side-entry・変数昇順 φ & `operand_slot` 整合・世代ハンドル UAF・OOM fail-closed・連続ゼロリーク回収）。
- **WASM 統合ビルド**: `node scripts/build-wasm.mjs` により `wasm/hex_engine.wasm` に統合ビルドされる。
