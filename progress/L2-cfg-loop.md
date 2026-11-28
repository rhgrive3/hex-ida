# L2: CFG & Natural Loop Engine (`cpp/src/cfg`)

統合済み `wasm/hex_engine.wasm`（`scripts/build-wasm.mjs`）に組み込まれている freestanding C++20/WASM CFG 解析および自然ループ構築エンジンの現行仕様。

## 対象ファイル

- `cpp/src/cfg/cfg_engine.hpp` / `cpp/src/cfg/cfg_engine.cpp`
- `cpp/src/cfg/loop_engine.hpp` / `cpp/src/cfg/loop_engine.cpp`
- `cpp/tests/test_cfg_native.cpp` / `cpp/tests/test_loops_native.cpp`

## 実装内容

- **CFG エンジン (`cfg_engine.{hpp,cpp}`)**:
  - 入口での厳密 CSR 検証（`n > INT32_MAX / 4` → `HEX_ERR_RESOURCE_LIMIT`、`succ_off == nullptr` / `succ_off[0] != 0` / 非単調 / `succ_off[n] > 0 && succ_dst == nullptr` → `HEX_ERR_INVALID_ARG`）と `size_t` オーバーフロー防御。
  - JS `controlflow.js` 互換の非再帰 DFS 到達可能性（`reach_order` 保持）、反復 RPO + Cooper-Harvey-Kennedy 支配木 (`idom`)、非再帰 Euler tour (`dom_tin`/`dom_tout`/`dom_depth`)、反復 Kosaraju SCC、保守的 PostDom（非終了ボトム SCC + 合成 EXIT=`n`）。
  - 公開 C/WASM ABI (`HEX_WASM_EXPORT`): `get_heap_base`, `cfg_reset`, `cfg_alloc`, `cfg_analyze`, `cfg_get_result_ptr`（4 バイトアライメント検証付き）。内部アリーナ連携関数 `hex_cfg_analyze_arena`。
- **自然ループエンジン (`loop_engine.{hpp,cpp}`)**:
  - 厳密 CSR 検証・`normalize_successors`・`hex_cfg_analyze_arena` 連携。
  - `reach_order` × `succ[from]` 順のバックエッジ検出、非再帰ワークリストによる自然ループ本体抽出（サイドエントリ除外・同一 SCC 制約・`UINT32_MAX` ラップ防御・バジェット超過時 fail-closed）。
  - `hex::stable_sort` による外側→内側整列と 1 パス非再帰の親ループ木 (`loop_parent`)・ネスト深さ (`loop_nest_depth`)・`node_innermost_loop`・`node_loop_depth`・`header_to_loop` 構築。
  - 公開 C/WASM ABI (`HEX_WASM_EXPORT`): `hex_loop_reset`, `hex_loop_alloc`, `hex_loop_analyze`, `hex_loop_get_ptr`。内部アリーナ連携関数 `hex_loop_analyze_arena`。

## 検証

- **Native テスト**: `cpp/tests/test_cfg_native.cpp`, `cpp/tests/test_loops_native.cpp`（ASan + UBSan、ダイヤモンド・無限ループ・空/到達不能・OOM・不正 CSR 負テスト・深さ 4096 チェーン・バジェット超過・ランダム CFG オラクル一致）。
- **WASM 統合ビルド**: `node scripts/build-wasm.mjs` により `wasm/hex_engine.wasm` に統合ビルドされる。
