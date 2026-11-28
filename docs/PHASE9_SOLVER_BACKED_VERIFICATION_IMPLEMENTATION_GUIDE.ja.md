# ソルバー検証（Solver-backed Verification）実装ガイド

> **最終更新:** 2026-11-28  
> **対象:** `js/symbolic/` サブシステム  
> **関連文書:** [`HEX_MASTER_ARCHITECTURE.md`](./HEX_MASTER_ARCHITECTURE.md), [`PHASE9_SOLVER_BACKEND_ADR.md`](./PHASE9_SOLVER_BACKEND_ADR.md), [`PHASE9_WORKER_PROMPTS.ja.md`](./PHASE9_WORKER_PROMPTS.ja.md)

## 1. 概要とアーキテクチャ

Hex のソルバー検証サブシステムは、従来の軽量・保守的な bounded symbolic evaluator（`js/symbolic/executor.js` の `SYM.UNKNOWN` / `SYM.SYMBOL` および `js/symbolic/function-sandbox.js`）とは分離された **solver-neutral な形式検証スタック** を提供します。

```text
Semantic IR v2 (SEMANTIC_IR_VERSION = 2.0.0)
  ↓  backwardDependencySlice + translateSemanticIR (TRANSLATOR_VERSION = 1.1.0)
Solver-neutral Bool/BV Expression DAG (js/symbolic/expr/)
  ↓  VerificationQuery (QUERY_SCHEMA_VERSION = 1.1.0)
SolverBackend / SolverSession (js/symbolic/solver/)
  ↓  厳格9分類 SolverResult (SAT / UNSAT / UNKNOWN / TIMEOUT / ...)
Model Validation & Proof Eligibility (js/symbolic/verify/)
  ↓  SymbolicEvidence (EVIDENCE_SCHEMA_VERSION = 1.1.0)
Caller / Cache / UI / AI
```

### 基本不変条件

- **ローカル完結・プライバシー保護:** 解析由来の制約やシンボルをリモートソルバーへ送信しない（リモート送信は既定で無効）。
- **Fail-closed 判定:** `timeout` / `resource-limit` / `unsupported` / `unknown` / `cancelled` / `provider-failure` / `invalid-query` は決して `UNSAT` や証明済みとして扱わない（`isSolverFailure()` は `sat` / `unsat` 以外をすべて失敗側として扱う）。
- **Vacuous UNSAT の防止:** `UNSAT` に基づく証明には `checkPreconditionsConsistency()` による前提整合性確認と `checkProofEligibility()` の通過が必須。
- **SAT モデルの再検証:** `SAT` 結果は `validateSatModel()` により評価器上で検証される。
- **未対応セマンティクスの明示:** Semantic IR に未対応命令・副作用が含まれる場合は `TRANSLATION_STATUS` / `COMPLETENESS_STATUS` に明示し、暗黙に unconstrained 記号へ変換しない。

## 2. モジュール構成（`js/symbolic/`）

| ディレクトリ / ファイル | 役割 | 主なエクスポート |
| :--- | :--- | :--- |
| `js/symbolic/index.js` | 公開ファサード | `expr`, `translate`, `solver`, `evidence`, `verify`, `querySymbolicAnalysis`, `queryTaint`, `queryDeobfuscationCandidates`, `queryMemoryEquivalence`, `queryEqualitySaturation` |
| `js/symbolic/executor.js` | 現行 bounded conservative 評価器 | `SYM` (`SYM.UNKNOWN`, `SYM.SYMBOL` 等) |
| `js/symbolic/expr/` | Solver-neutral Bool/BV DAG | `kinds.js`, `bitvector.js`, `factory.js`, `evaluate.js`, `hash.js`, `serialize.js`, `data-boundary.js` |
| `js/symbolic/translate/` | Semantic IR v2 → Expr 変換 | `translateSemanticIR`, `backwardDependencySlice`, `classifyOpSupport`, `TRANSLATION_STATUS`, `COMPLETENESS_STATUS`, `translateMemoryAccess` |
| `js/symbolic/solver/` | バックエンド抽象・実装・レジストリ | `SolverBackend`, `SolverSession`, `SolverRegistry`, `defaultSolverRegistry`, `ExhaustiveBvBackend`, `BitBlastBvBackend`, `TieredBvBackend`, `WorkerSolverBackend`, `TieredWorkerSolverBackend`, `HeuristicSolverBackend`, `FakeSolverBackend` |
| `js/symbolic/verify/` | 形式検証クエリ・判定 API | `createVerificationQuery`, `validateVerificationQuery`, `checkProofEligibility`, `checkPreconditionsConsistency`, `validateSatModel`, `verifyConditionalEdgeFeasibility`, `verifyGlobalEdgeReachability`, `verifyBoundedEquivalence`, `verifyPatchEquivalence` |
| `js/symbolic/evidence/` | 証拠生成とキャッシュポリシー | `createSymbolicEvidence`, `isProvedEvidence`, `isRefutedEvidence`, `computeVerifierFingerprint`, `isCacheableProof`, `getProofToolCacheOptions`, `computeProofCacheKey` |
| `js/symbolic/memory/` | バイト単位メモリモデル・スナップショット | `createByteMemory`, `joinByteMemory`, `semanticValueIdentity`, `isExecutionSnapshot` |
| `js/symbolic/taint/`, `projection/` | テイント解析・難読化解除検証 | `createTaintModels`, `projectTaint`, `verifyDeobfuscationCandidate`, `isAdoptableCandidate` |
| `js/symbolic/egraph/` | 等価性飽和（E-Graph） | `graph.js`, `rules.js`（`query/equality-saturation.js` 経由で利用） |

## 3. ソルバーバックエンドとレジストリ

`js/symbolic/solver/backend.js` は `PROOF_AUTHORITY`（`none`, `test-only`, `heuristic`, `exact`）を定義し、`isExactProofBackend()` により本番証明権限を厳格に判定します。

- **`defaultSolverRegistry`**（`createProductionSolverRegistry()`）: `allowNonExactDefault: false` で構築され、テスト用・ヒューリスティック実装が本番既定へ昇格することを禁止します。
  - ブラウザ環境（`globalThis.Worker` が利用可能）: `WorkerSolverBackend({ maxBvWidth: 64 })` によりメインスレッドから分離実行。
  - Node / CI 環境: `TieredBvBackend`（`hex-tiered-qfbv` v1.0.0）を直接実行。
- **階層型 exact QF_BV 構成（`TieredBvBackend`）**:
  - 8-bit 以下の狭域クエリは `ExhaustiveBvBackend`（`hex-exhaustive-bv` v1.0.0）で決定論的全探索。
  - 最大 64-bit の広域 QF_BV クエリは `BitBlastBvBackend`（`hex-bitblast-qfbv` v1.0.0）で bit-blasting + SAT 解決。
  - 既定バジェット: `maxBvWidth: 64`, `maxConstraints: 4096`, `maxExprNodes: 100000`, `maxExprDepth: 1024`, `exhaustiveMaxBvWidth: 8`, `exhaustiveMaxAssignments: 1 << 20`, `maxVariables: 400000`, `maxClauses: 1600000`, `maxDecisions: 500000`, `maxPropagations: 8000000`。

## 4. 検証 API と証拠・キャッシュ契約

### 検証 API（`js/symbolic/verify/`）

- `verifyConditionalEdgeFeasibility`: 条件付きエッジの局所的な到達可能性検証（局所不能性を大域未到達と混同しない）。
- `verifyGlobalEdgeReachability`: 大域的な到達可能性検証。
- `verifyBoundedEquivalence`: 明示スコープ・前提条件下での境界付き等価性検証。
- `verifyPatchEquivalence`: パッチ適用前後の副作用・振る舞い等価性検証。

### スキーマバージョンとキャッシュ境界

| 契約 | 定数 | 現行値 |
| :--- | :--- | :--- |
| 検証クエリスキーマ | `QUERY_SCHEMA_VERSION` | `'1.1.0'` |
| 入力 Semantic IR | `SEMANTIC_IR_VERSION` | `'2.0.0'` |
| トランスレータ | `TRANSLATOR_VERSION` | `'1.1.0'` |
| 証拠スキーマ | `EVIDENCE_SCHEMA_VERSION` | `'1.1.0'` |
| 検証器フィンガープリント | `VERIFIER_FINGERPRINT_SCHEMA_VERSION` | `'1.1.0'` |

`js/symbolic/evidence/cache-policy.js` により、検証ツールは `computeVerifierFingerprint()` / `computeProofCacheKey()` を用いてバックエンド・クエリ・式・トランスレータ・セマンティクス各バージョンをキャッシュキーへ含めます。`isCacheableProof()` が `false` となる一時失敗（`timeout`, `cancelled`, `provider-failure` 等）はキャッシュしません。

## 5. 検証コマンド

```bash
npm run phase9:test
npm run phase9:verify
npm run phase9:browser
NODE_OPTIONS=--experimental-global-webcrypto node --test tests/phase9/foundation/preflight.test.mjs
```
