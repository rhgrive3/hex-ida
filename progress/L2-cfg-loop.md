# Lane L2-cfg-loop 完了レポート（永続環境再構築）

## 1. 実装概要
永続 worktree `/working_dir/c_50571edcf7098631/wt-L2-cfg-loop`（ブランチ `wt/L2-cfg-loop`）上で、`cpp/include/hex_core/hex_core.hpp` のみを用いた freestanding C++20/WASM CFG エンジンおよび自然ループ構築エンジンを再構築した（`std::unordered_map`・例外・RTTI・再帰なし、過去レビュー指摘を初期状態からすべて完備）。

### 作成ファイル
- `cpp/src/cfg/cfg_engine.hpp` / `cpp/src/cfg/cfg_engine.cpp`:
  - 入口での厳密 CSR 検証（`n > INT32_MAX / 4` → `HEX_ERR_RESOURCE_LIMIT`、`succ_off == nullptr` / `succ_off[0] != 0` / 非単調 / `succ_off[n] > 0 && succ_dst == nullptr` → `HEX_ERR_INVALID_ARG`）および `size_t` オーバーフロー防御。
  - JS `controlflow.js` と完全一致する非再帰 DFS 到達可能性（DFS 訪問順 `reach_order` 保持）、反復 RPO + Cooper-Harvey-Kennedy 支配木 (`idom`)、非再帰 Euler tour (`dom_tin`/`dom_tout`/`dom_depth`)、反復 Kosaraju SCC、保守的 PostDom（非終了ボトム SCC＋合成 EXIT=`n`）。
  - 全公開 WASM ABI (`get_heap_base`, `cfg_reset`, `cfg_alloc`, `cfg_analyze`, `cfg_get_result_ptr`) に `HEX_WASM_EXPORT` と 4 バイトアライメント検証を適用。
- `cpp/src/cfg/loop_engine.hpp` / `cpp/src/cfg/loop_engine.cpp`:
  - 厳密 CSR 検証・`normalize_successors`・`hex_cfg_analyze_arena` 連携。
  - `reach_order` × `succ[from]` 順でのバックエッジ検出、非再帰ワークリストによる自然ループ本体抽出（サイドエントリ除外・同一 SCC 制約・`UINT32_MAX` ラップ防止・バジェット超過時 fail-closed）。
  - `hex::stable_sort` による外側→内側整列と 1 パス非再帰の親ループ木 (`loop_parent`)・ネスト深さ (`loop_nest_depth`)・`node_innermost_loop`・`node_loop_depth`・`header_to_loop` 構築。
  - 全公開 C/WASM ABI (`hex_loop_reset`, `hex_loop_alloc`, `hex_loop_analyze`, `hex_loop_get_ptr`) に `HEX_WASM_EXPORT` と 4 バイトアライメント検証を適用。
- `cpp/tests/test_cfg_native.cpp` / `cpp/tests/test_loops_native.cpp`:
  - ダイヤモンド・無限ループ・空/到達不能・OOM・不正 CSR 負テスト・深さ 4096 チェーン・バジェット超過・ランダム 500 CFG オラクル一致テスト。

## 2. 検証結果

| 検証項目 | 結果 |
|---|---|
| `test_cfg_native` (ASan+UBSan, `-Wall -Wextra -Werror`) | **PASS** (警告 0) |
| `test_loops_native` (ASan+UBSan, `-Wall -Wextra -Werror`) | **PASS** (警告 0、ランダム 500 CFG `backEdges=1753, loops=1212, maxNest=7` 全一致 + 不正 CSR 負テスト) |
| wasm32 `-O3 -nostdlib -mbulk-memory -Wl,--no-entry` + `wasm-opt -O3` | **PASS** (警告 0、インポート 0、全 9 関数エクスポート、`24,198 B` → `24,180 B`) |
| `js/controlflow.js` vs `p_cfg_loop.opt.wasm` 直接差分テスト (Node.js) | **PASS** (ランダム 300 CFG / 704 ループで `reachOrder`/`idom`/`backEdges`/`loops`/`latches`/`nodes`/`exits`/`walkSteps` 100% 一致) |

## 3. 未解決事項
なし。
