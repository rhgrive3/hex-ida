# RESULT — Semantic IR reachability cache ownership fix

担当: Semantic IR reachability cache architecture fix
worktree: `/mnt/workspace/hex-agent-a`
branch: `fix/arch-ir-reachability`
base: `05c93a1c92b34f4876060bd858e4393557d02dd4`
main worktree / main branch は未編集・未 merge・未 push。

## 根本原因

`js/ir-base.js` の `blockReachability(ir)` が、生成した closure `canReach`(+ その内部
`Map` memo)を `ir._canReachBlock` として **Semantic IR 自身の own property** に保存して
いた。`unknownStoreBetween(ir, from, to)` は候補 barrier の有無に関わらず先頭で
`const canReach = blockReachability(ir);` を実行するため、reachability / unknown-store
query を 1 回実行するだけで IR に function 値の own property が追加される。

実測（最小 synthetic IR、unknown store を含む小さい CFG）:

```
before query: ownKeys = [ instructions, blocks ]
barrier? true
after  query: ownKeys = [ instructions, blocks, _unknownStoreBarriers, _canReachBlock ]
typeof ir._canReachBlock = function
structuredClone FAILED: DOMException DataCloneError
```

影響は 2 系統ある。

1. **serialization**: `structuredClone(ir)` が function 値を転送できず DataCloneError。
   分析 query を 1 度でも通した IR は snapshot / transport できなくなる。
2. **identity**: `js/decompiler/phase8/analysis-identity.js` の `semanticObject()` は
   function 値の own property を `identity-non-semantic-value` で拒否し、
   `_canReachBlock` は `DERIVED_IR_KEYS` に登録されていない。したがって query 済み IR は
   canonical identity も取得できなくなる（本ファイルは lane 外のため変更していない）。

### 周辺 runtime cache 監査（指示項目）

`js/ir-base.js` 周辺で IR に付く runtime cache は次の 3 つのみ。

| 実体 | 値の型 | 保存先 | 本変更での扱い |
| --- | --- | --- | --- |
| `_canReachBlock` | **function** | `js/ir-base.js` | IR 外 (`WeakMap`) へ移動 ← 本修正 |
| `_unknownStoreBarriers` | array | `js/ir-base.js` | 移動しない（指示通り） |
| `_branchConstraints` | array | `js/ir-base.js` / `js/ir-public-base.js` | 移動しない（derived key 契約） |

function 値の cache は `_canReachBlock` **のみ**（`js/` 全体 grep、`_canReachBlock` の参照は
`js/ir-base.js` の 2 行だけ）。実 ARM64 fixture の `buildIR` 生成物から到達可能な
1022 object を深く走査しても、function 値 own property は既存契約 `ir.defUse` ただ 1 つで
あり、他に function-valued runtime cache は発見されなかった。
`js/ir-core.js` は元から module-level `WeakMap` 群で runtime cache を IR 外に持っており、
本修正はその既存方式に揃えている。

## 変更ファイル

```
js/ir-base.js                                              (blockReachability のみ)
tests/semantic-v2/ir-reachability-cache-ownership.test.mjs (新規 regression)
RESULT.md                                                  (本ファイル)
```

- `js/analysis/query/app-adapter.js`、`js/analysis/query/api.js`、
  `js/platform/analysis-result.js`、`js/symbols.js` は未変更。
- `ir.defUse` 等の無関係な既存契約は未変更。公開 API の追加・削除・改名なし。
- benchmark 固有特例・固有 ID/関数名/address/hash の production 混入なし。

## cache ownership before / after

**before** — IR が cache を所有していた。

```
Semantic IR (ir)
  └── _canReachBlock : function canReach   // closure
        └── Map memo                        // from+'>'+to → boolean
```

**after** — cache は module scope が所有し、IR は data のまま。

```
js/ir-base.js module scope
  └── reachabilityCache : WeakMap<ir, canReach>
        └── canReach : function            // closure（従来と同一本体）
              └── Map memo                 // from+'>'+to → boolean
Semantic IR (ir)  →  query 後も own key は data のみ
```

不変条件として保ったもの:

- **意味論**: traversal 順序、`from == null || to == null || from < 0 || to < 0 → false`、
  `from === to → true`、memo key `from + '>' + to`、`succ` の読み方は無変更。
- **性能**: per-IR memo は closure 内 `Map` のまま `WeakMap` 値として保持するため、
  同一 IR への繰り返し query は全探索しない（テストで CFG 読み取り回数を計測）。
- **invalidation**: 既存の唯一の invalidate 点 `promoteResolvedGlobals()` の
  `delete ir._unknownStoreBarriers` はそのまま維持（`unknownStores()` は引き続き
  IR 上の配列を read/write する）。reachability memo は CFG (`ir.blocks[].succ`) のみに
  依存し、`promoteResolvedGlobals()` は blocks を変更しない。旧実装も reachability cache を
  invalidate していなかったため、cache ライフタイムは従来と同一。
- **per-IR 分離**: `WeakMap` のキーは IR オブジェクトなので、別 IR に reachability 事実が
  漏れない（旧実装の IR 単位ライフタイムと同じ）。

## regression test

`tests/semantic-v2/ir-reachability-cache-ownership.test.mjs`

`tests/semantic-v2/run.mjs` は同ディレクトリの `*.test.mjs` を自動発見して実行するため、
この regression は追加登録なしで `npm run semantic-v2:test`（= `npm run check` の一部）に
恒久的に入る。

検査内容:

1. **最小 synthetic IR**: entry(0) → body(1) → exit(2)。block 0 に concrete store、
   block 1 に unknown store、block 2 に load を配置（block graph を歩かないと順序が
   決まらない配置）。
2. **barrier 判定は従来通り**: concrete store → load の間に unknown store があれば `true`、
   逆向き (load → unknown store) は `false`、unknown store が無ければ `false`。
3. **query 後も IR は data**: `_canReachBlock` が own property として存在せず
   `undefined`、function 値 own property が増えない、追加 own key は既存 derived key
   `_unknownStoreBarriers` のみ、`structuredClone(ir)` が成功して clone に
   instructions / blocks が保持される。
4. **両入口で同じ**: `js/ir.js` と `js/ir-base.js` の両方から同じ契約を検証。
5. **cache 再利用**: `ir.blocks` を `Proxy` で計測し、初回 query は CFG を走査
   (read > 0)、同一 query の 2 回目は read 数が増えない（= memo 再利用、全探索なし）。
6. **per-IR 分離**: 同じ命令列で CFG だけ異なる 2 つの IR に、異なる正解
   (`true` / `false`) を要求し、交互に query しても他 IR の答えを継承しない。
7. **production IR**: ARM64 fixture から `buildIR` した IR で、query 前後で own key 集合と
   function 値 key 集合（`['defUse']`）が不変、`memorySafety` / `reachingStore` /
   `memUse.kind === 'clobber'` / `unknownAliasBarrier` が従来通り、かつ
   `_canReachBlock` 不在。

**旧コードでの捕捉確認**: `js/ir-base.js` のみを base へ戻すと同 test は exit=1 で
FAIL する（`AssertionError: js/ir.js: the reachability closure must not be stored on the
Semantic IR`, line 90）。fix ありでのみ PASS する。

## focused / broader test 結果

focused:

| command | 結果 |
| --- | --- |
| `node tests/semantic-v2/ir-reachability-cache-ownership.test.mjs` | PASS (0.7s) |
| 同上（base の `js/ir-base.js` に差し戻し） | FAIL exit=1（期待通り、旧欠陥を捕捉） |

関連 existing:

| command | 結果 |
| --- | --- |
| `node tests/migration-guardrails.mjs` | PASS |
| `node tests/ir.mjs` | 34 passed, 0 failed |
| `node tests/ir-alias.mjs` | 9 passed, 0 failed |
| `node tests/performance/analysis-identity.test.mjs` | PASS |
| `node tests/phase8/provenance/validation.test.mjs` | PASS |
| `node tests/semantic-v2/compat-v1-memory.test.mjs` | PASS |
| `node tests/semantic-v2/rmw-query-cache.test.mjs` | PASS |
| `node tests/semantic-v2/integration-unknown.test.mjs` | PASS |
| `node tests/semantic-v2/verification-memoryssa.test.mjs` | PASS |

broader:

`npm run semantic-v2:test`（135 files、`node scripts/run-quiet-command.mjs` 経由）は
新規 regression が `PASS (0.7s)`。suite 全体は 4 lane が FAIL したが、失敗 7 件を個別に
再実行し、**base の `js/ir-base.js`（fix を stash で差し戻した pristine HEAD）でも同一の
7 件が同一 exit=1 で失敗する**ことを確認した。すなわち本変更とは無関係な pre-existing
failure であり、本作業の成果物起因ではない。

内訳:

- 環境要因: LLVM 18 (`llvm-mc`) 不在 → `effects:test`、
  `esbuild` 未 install → `invariants:test` architecture-boundaries / `userscript:test`
- baseline 差分: `semantic-ir-node-{input,output}-arity` 系
  (`c4-return-control-target`, `issue-4534-ssa-definition-binding`)、
  artifact storage integrity (`issue-3327`)、memoryssa access provider (`issue-4513`)、
  storage-class alias (`repair-storage-class-alias`)
- legacy-v1 mode lane: `tests/ir-alias.mjs` / `tests/decompiler-semantic.mjs`
  （`phase3-legacy-differential` は `setSemanticMigrationMode('legacy-v1')` で実行される。
  同じ test は default mode では green）

工程ガードレール（`docs/ENGINEERING_PROCESS_GUARDRAILS.md`）について: 本作業は phase では
なく単一 component lane の architecture fix のため §10 の phase completion checklist は
適用範囲外。適用した規律は EP-002 の「actual changed-file inventory と allowlist 照合」
（変更は上記 3 ファイルのみ）と「process repair には必ず regression を同時に追加する」
（新規 regression test を canonical runner の自動発見範囲に追加）。

## known limitation

- `ir.defUse` は function 値のまま IR 上に残る**既存契約**である。したがって
  **production IR 全体の `structuredClone` は依然 DataCloneError になる**。これは本変更の
  対象外であり、「無関係な既存契約には触らない」という指示に従い変更していない。
  本修正が保証するのは「query が新たな非シリアライズ可能 own property を IR に足さない」
  ことであり、query 前に clone 可能だった IR は query 後も clone 可能になる。
- `_unknownStoreBarriers` / `_branchConstraints` は array 値の derived key として IR 上に
  残した（指示通り無目的に移動しない）。`unknownStores()` は依然 query 時に
  `_unknownStoreBarriers` を IR へ追加するが、これは `analysis-identity.js` の
  `DERIVED_IR_KEYS` に登録済みの既存 derived-key 契約であり、function 値ではないため
  clone を壊さない。
- `js/decompiler/phase8/analysis-identity.js` の function 値拒否と `DERIVED_IR_KEYS` の
  「`_canReachBlock` 未登録」という不整合は、本修正により当該 key が発生しなくなるため
  実害は消えるが、同ファイル自体は lane 外なので変更していない。恒久的に塞ぐなら
  identity walker 側に「未登録の derived key を検出したら fail closed」する regression を
  追加するのが望ましい（本作業のスコープ外）。
- `js/ir-public-base.js` は `branchConstraints` を `js/ir-base.js` と重複実装している
  （どちらも同じ `ir._branchConstraints` に書く）。重複の解消は本作業のスコープ外。
