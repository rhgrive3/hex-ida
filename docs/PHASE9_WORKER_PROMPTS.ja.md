# ソルバー検証モジュール・検証コマンド リファレンス

> **最終更新:** 2026-11-28  
> **対象:** `js/symbolic/` および `tests/phase9/`  
> **関連文書:** [`PHASE9_SOLVER_BACKED_VERIFICATION_IMPLEMENTATION_GUIDE.ja.md`](./PHASE9_SOLVER_BACKED_VERIFICATION_IMPLEMENTATION_GUIDE.ja.md), [`PHASE9_SOLVER_BACKEND_ADR.md`](./PHASE9_SOLVER_BACKEND_ADR.md)

## 1. 主要モジュール一覧

| 領域 | パス | 主な責務 |
| :--- | :--- | :--- |
| エントリーポイント | `js/symbolic/index.js` | 全ソルバー検証・クエリ・テイント・E-Graph API の公開ファサード |
| 既存保守評価器 | `js/symbolic/executor.js`, `function-sandbox.js` | `SYM.UNKNOWN` / `SYM.SYMBOL` による軽量・保守的評価（ソルバー検証層とは独立維持） |
| Expression DAG | `js/symbolic/expr/{kinds,bitvector,factory,evaluate,hash,serialize,data-boundary}.js` | Solver-neutral Bool/BV 式表現、評価、正規ハッシュ、シリアライズ |
| Semantic IR 変換 | `js/symbolic/translate/{semantic-ir,scalar,memory,slice,support-matrix,completeness}.js` | Semantic IR v2 (`2.0.0`) の後方依存スライスと Expr 変換（`TRANSLATOR_VERSION = '1.1.0'`） |
| ソルバー抽象・結果 | `js/symbolic/solver/{backend,session,result,registry,budget,limits,model-boundary,query-analysis}.js` | 9分類 `SOLVER_STATUS`、`PROOF_AUTHORITY`、`SolverRegistry`、`defaultSolverRegistry` |
| ソルバー実装 | `js/symbolic/solver/{exhaustive-backend,bitblast-backend,tiered-backend,worker-backend,tiered-worker-backend,heuristic-backend,fake-backend}.js` | 8-bit 全探索オラクル、64-bit bit-blast QF_BV、階層ルータ、WebWorker 分離実行 |
| 形式検証 API | `js/symbolic/verify/{query,eligibility,preconditions,validate-model,edge-feasibility,global-reachability,equivalence,patch}.js` | クエリ検証、前提整合性、証明適格性、SAT モデル検証、エッジ到達性・等価性・パッチ検証 |
| 証拠・キャッシュ | `js/symbolic/evidence/{symbolic-evidence,cache-policy}.js` | `SymbolicEvidence` (`1.1.0`)、バージョン安全キャッシュキー (`VERIFIER_FINGERPRINT_SCHEMA_VERSION = '1.1.0'`) |
| 応用クエリ・解析 | `js/symbolic/{query,memory,taint,projection,egraph}/` | テイント解析、難読化解除候補検証、メモリ等価性、E-Graph 等価性飽和 |

## 2. 変更時の必須不変条件

- `SOLVER_STATUS` の失敗系（`unknown`, `timeout`, `resource-limit`, `unsupported`, `cancelled`, `provider-failure`, `invalid-query`）を `unsat` や証明済みへ昇格させない。
- `UNSAT` からの証明生成には `checkPreconditionsConsistency()` と `checkProofEligibility()` を必ず通す。
- `SAT` モデルは `validateSatModel()` で検証し、バックエンド固有の内部オブジェクトを公開 API へ露出させない。
- `defaultSolverRegistry` は `allowNonExactDefault: false` を維持し、非 exact バックエンドやリモート送信を既定にしない。
- 一時失敗（`timeout` / `cancelled` / `provider-failure`）を `ObservationStore` 等へキャッシュしない（`isCacheableProof()` を遵守）。

## 3. 検証コマンド

```bash
# Phase 9 テストスイート全体
npm run phase9:test

# 契約・ベースライン検証（preflight 契約および必須ドキュメント存在確認）
NODE_OPTIONS=--experimental-global-webcrypto node --test tests/phase9/foundation/preflight.test.mjs

# Phase 9 統合検証ゲート
npm run phase9:verify

# ブラウザ Worker ランタイム検証
npm run phase9:browser
```
