# Lane L6-resident-ir Progress Report (Persistent Rebuild)

## 1. 実装サマリ
永続 worktree `/working_dir/c_50571edcf7098631/wt-L6-resident-ir`（ブランチ `wt/L6-resident-ir`）にて、`cfg_engine` 非依存の完全自己完結型 freestanding C++20/WASM Resident IR ストアおよび CFG/DF/Cytron SSA エンジンを再構築した。

### 追加ファイル
- `cpp/src/semantics/resident_ir.hpp`: 統一サブオペコード定数（`HEX_IR_BIN_*` 0..10、`HEX_IR_UN_*` 0..3、`HEX_IR_SUBOP_MASK = 0x0fu`、`HEX_IR_FLAG_WIDTH32 = 0x10u`）を一元定義。世代付き `HexIrHandle`、SoA `IrFunction`/`IrBlock`/`IrInst`、2 アリーナ分離 `IrStore`、全 7 公開 C ABI に `HEX_WASM_EXPORT` 適用。
- `cpp/src/semantics/resident_ir.cpp`: 自己完結・完全非再帰の CFG 解析（到達性 DFS・CHK 支配木・Euler tour `tin`/`tout`/`depth`・Kosaraju SCC・逆グラフ Post-Dom・支配ガード付き自然ループヘッダ検出）、2パス Dominator Frontier、`dense_to_var` 変数 ID 昇順 `stable_sort` 後 φ 配置、`total_phi_incoming` 32-bit オーバーフロー＆上限チェック (`HEX_ERR_RESOURCE_LIMIT`)、非再帰 Cytron リネーミング、`phi_incoming` `stable_sort` 後の `record_use`（`operand_slot` 完全整合）、`ScratchGuard` による Phase 1〜5 全一時データ O(1) 回収、`active_count_ == 0` 時の永続 Arena 自動リセット、128-bit 構造ダイジェスト。
- `cpp/tests/test_resident_ir_native.cpp`: 統一サブオペコード・ダイヤモンド・ループ/エントリループ/side-entry・変数昇順 φ (`[var=2, var=10]`)＆`operand_slot` 整合・世代ハンドル UAF・OOM fail-closed・64回連続ゼロリーク回収テスト。

## 2. 検証結果
- **Native (ASan+UBSan, `-std=c++20 -O2 -Wall -Wextra -Werror`)**: `test_resident_ir_native (ASan+UBSan, self-contained): ALL PASS`（警告 0）
- **WASM32 (`-O3 -nostdlib -fno-exceptions -fno-rtti -mbulk-memory -Wall -Wextra -Werror -Wl,--no-entry` + `wasm-opt -O3 --enable-bulk-memory`)**: `L6_resident_ir.wasm` `49,654` B / `L6_resident_ir.opt.wasm` `49,626` B（警告 0、全 7 C ABI エクスポート＋Node.js スモークテスト PASS）
