# 002 — 解析改善: symbolic memory / first-class taint 実装候補

## 0. 納品の結論と適用基準

添付 PR head ZIP を基準に、bounded Bool/BV byte-memory、既存 executor からの実行、同じ memory 上の taint query / evidence、既存 judge を使う pure-expression proof consumer を実装した。完全 unified diff と変更後ファイルだけの ZIP を別添する。新規回帰は **63/63 PASS**。元 ZIP への MEM → TAINT → PROOF 分割適用、および別展開先への完全パッチ一括適用後も **63/63 PASS**。

**T033/T034 全体の状態は PARTIAL（先行実装候補）**。一般 Array theory、共有 translator 全体、認証済み static forwarding の消費、Phase 8 optimizer/decompiler transaction、実機、最新 main への統合は完了していない。main merge、Stage A merge、Stage B 正式開始、campaign/roadmap DONE は宣言しない。

広域 `npm run phase9:test` は **224 tests / 223 PASS / 1 FAIL**。失敗は既存 release test が `playwright` を import できない環境要因で、未変更の入力 ZIP でも同じ失敗を再現した。したがって広域テスト全体を PASS と扱わない。

### 入力 identity とハッシュ

| 項目 | 値 |
| --- | --- |
| 入力ファイル | `hex-ida-28a2d6e04a75374a6600d2ee597ab4e1b04a6ba6.zip` |
| 入力サイズ | 8454294 bytes |
| 入力 SHA-256 | `87690c46f0e87ba5e60da0948bd9c7471d70d145643cb61fb132d0a32f3649a7` |
| ユーザー提示 candidate commit | `f6db4575e10e405a4ef5a649b1e1fcbda9447f89` |
| ユーザー提示 candidate tree | `5d34120b4c25a859a853bc5413090a8a21ffe9e5` |
| Git identity 検証 | **UNVERIFIED** — ZIP に `.git` 履歴なし。ZIP 名・コメントや新造 commit を検証証拠にしていない |
| 完全パッチ SHA-256 | `e5b0bd7920970733f63fff79a0d899ededf39489cf3805f55d29963685ceb964` |
| 差分規模 | 既存 3 ファイル変更、新規 22、削除 0。25 files / 1541 insertions / 13 deletions |
| 範囲監査 | 元の 2531 regular files のうち 2528 は byte-for-byte 不変。既存 test / readonly owner はすべて不変 |

本文の source path はすべて添付 ZIP／パッチ内の実物を指す。`baseline-files.sha256.json` は変更前全ファイルの SHA-256、manifest の `files` は変更対象ごとの before/after SHA-256。実装・試験の authority はこのローカルスナップショットであり、現在の GitHub PR 状態を再検証したものではない。

## 1. 簡易仕様 — 既にあるもの／今回不足していたもの

`AGENTS.md`、`docs/ENGINEERING_PROCESS_GUARDRAILS.md`、`.specify/memory/constitution.md`、`docs/flash.md` の symbolic/semantic truth、`docs/解析ツール改善.md.txt` の HEX-SYM-02/03・C4-04、`specs/005-analysis-final-closure/` の T033/T034・performance locks、`specs/002-byte-exact-memoryssa/contracts/byte-forwarding.md` を基準にした。campaign/spec/checklist 自体は変更していない。

| 領域 | 入力の現行実装 | 今回の差分／残差 |
| --- | --- | --- |
| 意味論 | canonical Expr は Bool/BV。既存 executor には別の互換表示 SYM がある | scalar は共有 translator 経由で canonical 化。同名 object を Expr として信頼しない |
| solver | exhaustive と Recovery bitblast/tiered 候補が存在 | 一切変更なし。既存 session/backend で有限 Bool/BV query を検証 |
| 実行 memory | executor は location-key 単位で値を保持 | opt-in の query-local byte memory。部分上書き、alias 等式、fork 履歴を保持 |
| static memory | MemorySSA / alias / points-to に既存 authority | 読み取り専用。独自 reaching-definition / static alias 判定なし |
| taint | 対象 production entrypoint に必要な first-class query/byte-flow/evidence が不足 | 一つの lattice と flow graph、versioned models、public query/projection を追加 |
| 証明 | 既存 equivalence judge / eligibility / evidence が存在 | 小さい consumer のみ追加。memory/effect proof の不足を補認定しない |
| 性能 | P-SYMMEM / P-TAINT 各9ケースと上限が lock されている | case ID / units / thresholds / denominator は不変。owned fixtures で実測。公式 collector・実機は NOT RUN |

非目標は e-graph、solver backend/Expr schema の拡張、ISA semantics、native rebuild、共有 decompiler 全体の変更。T016 / Recovery 他 lane は触っていない。

## 2. 計画・責務境界

canonical semantic value ID は IR の `value.id`、式内の symbolic identity は canonical `symbolId` を使う。ID は query/snapshot に束縛される。名前や文字列化した式から MustAlias / NoAlias を作らない。memory の具体アドレス用 Map key は安全な BigInt の byte address であり、static alias authority ではない。

| owner | 入力 → 出力 | identity / unknown / lifecycle |
| --- | --- | --- |
| memory/byte-memory.js | 1/2/4/8-byte load/store → canonical Expr + byte label | query-local。unknown 初期 byte は fresh BV8 と alias 等式。barrier 後 exact read 不可 |
| translate/memory.js | 既存 IR memory op / scalar value → canonical Expr | 実メタデータを検査。scalar semantics は既存 translateSemanticIR を再利用 |
| executor.js | 既存 function-local IR + byteMemory options → immutable paths/metrics | 既存 scheduler に接続。budget/cancel/stale/unsupported は complete にしない |
| taint/flow.js | semantic IDs と同じ byte-memory の label handles → fixed-point lattice | data/control/phi/memory の単一 graph。未知は TOP、上限前検査 |
| query/taint.js → projection/taint.js | 実行結果 → source→value/memory→sink evidence | query/snapshot/model identity と発行済み result を検査。既存 evidence factory/graph を使用 |
| taint/proof-consumer.js | before/after + observables + binding → eligibility | 既存 judge/session/evidence のみ。pure-expression 限定。private receipt による再利用検査 |

public memory executor の実行方法は `symbolicExecute(ir, { byteMemory: { identity, ...memoryOptions }, ...executionOptions })`。既存 `FunctionSandbox.symbolic(ir, opts)` はこの関数へ実際に委譲するので、共有 sandbox の編集は不要。デフォルト互換経路は変更せず、`byteMemory` を渡した呼び出しだけ新経路を使う。

## 3. 先に固定したタスクと結果

実装前の原本は evidence ZIP の `tasks-frozen.md`。下表は同じ順序の結果欄を埋めたもので、scope を後から拡張していない。path は特記のない限り `js/symbolic/` 以下。分割単位の正確な changed paths は §10。

| ID / 目的 | 編集ファイル | 反例 | 試験 | 結果 |
| --- | --- | --- | --- | --- |
| MEM-01 byte/endian/width | memory/byte-memory.js; phase9/memory tests | word store → +1 byte overwrite | LE/BE 1/2/4/8・本番 RET parity | 最初 FAIL → PASS |
| MEM-02 bounded symbolic lowering | memory/byte-memory.js | p=q の初期 read、hole、複数 store 順序 | 独立256観測 oracle、既存 backend SAT/UNSAT | PASS（有限 Bool/BV 範囲） |
| MEM-03 identity/fork/budget | memory/query-state.js; memory/byte-memory.js | fork 汚染、stale、cancel、N±1 | identity/immutable/history/work/allocation/alias-fork 境界 | PASS |
| MEM-04 production bridge | executor.js; translate/memory.js; translate/index.js | 部分上書き RET、unknown qualifier が exact | production/Sandbox/descriptor/unsupported tests | PASS（shared translator 全体は PARTIAL） |
| TAINT-01 lattice/models | taint/lattice.js; taint/models.js | TOP≠untainted、sanitize 名/clean:true | join laws・source overflow・scope sanitizer | PASS |
| TAINT-02 one byte flow | taint/flow.js; query/taint.js; executor hooks | source→symbolic partial store→load→control/phi→sink | 本番 integration・cyclic fixed point・N±1 | PASS（interprocedural は PARTIAL） |
| TAINT-03 projection | projection/taint.js; index.js | budget 後 evidence、stale model / copied record | no-publication・replay・既存 EvidenceGraph | PASS |
| PROOF-01 existing judge consumer | taint/proof-consumer.js; index.js | fake proof / vacuity / memory observation 欠落 | actual Bool/BV proved/refuted・tiered32・stale receipt | PASS（pure expression のみ） |
| PERF-01 locked metrics | tests/final-closure/t033/**, t034/**; Phase9 import tests | 自己申告ゼロ、別工程の時間による代用 | 9+9実行・実カウンタ・Phase9全体 | local cases PASS; P-TAINT phase8 NOT RUN; Phase9 FAIL 1 |

## 4. 最初の反例と追加した負例

最初に、little-endian で address `0x100` に `0x11223344` を4 byte STORE、その `+1` に `0xaa` を1 byte STORE、`0x100` を4 byte LOAD → RET する試験を追加した。期待値は **`0x1122aa44`**。入力 executor は location 単位の状態のため、この観測を満たさなかった。`logs/01-prechange-memory.log` が failing run、`byte-memory-production.test.mjs` が固定回帰。

first-class taint public query が存在しない反例は `logs/03-prechange-taint.log`。実装後の自己レビューでは、memory budget 後の evidence 残存、stale model/cancel 後の projection、未対応の dead scalar、空/不正 IR、symbolic effective-address wrap、実際の v2→v1 memory descriptor の unknown qualifiers を追加試験し、偽の complete/exact を閉じた。途中 FAIL のログも削除していない。テスト側の仮定誤りを直した履歴もあり、全ての途中 FAIL を入力コードの欠陥として数えていない。

### 既存 judge の counterexample（読み取り専用）

`verifyBoundedEquivalence` に equal BV4 return 値と `memoryRegions: [{id: 'byte-zero', before: 1, after: 2}]` を渡すと、この入力では実 backend の結果が `proved` になる。byte 0 の観測は独立に `1 != 2`。現在の memoryRegions は差分 predicate を十分に拘束しないため、memory 変換採用の根拠にはしない。

`tests/phase9/taint/proof-consumer.test.mjs` の `the existing judge memory-observable counterexample stays outside adoption` と `READ_ONLY_JUDGE_MEMORY_COUNTEREXAMPLE=proved` の実行ログに記録した。consumer は nonempty memory/effect observable を **`memory-effect-judge-handoff`** で拒否する。既存 judge の不十分な証明を別 engine で補認定していない。#6602 の judge owner へ渡す具体的残差である。

## 5. API・意味論・identity・budget 契約

### 5.1 Byte memory

address width は整数 **1..64 bits**、アクセスは **1/2/4/8 bytes**。具体アドレスは BigInt または safe-integer Number のみ。unsafe Number、負数、範囲外、幅不一致、未対応 sort は unknown/partial。Number の丸めを exact にしない。値はアクセス幅に一致する canonical BV。byte order は `little` / `big`、default little。bit offset ではなく byte-addressed。

`wrapping: 'reject'` が default。アクセスが境界を越えないことを具体値で確定できない multi-byte symbolic access は `address-wrap-unproved`。`wrapping: 'modular'` は明示的に modulo 2^addressBits の契約を選ぶ。base+disp の wrap も reject mode では未証明なら拒否する。`alignment: 'unaligned'` が default、`'natural'` は size 自然整列を具体的に証明できる場合だけ許可する。precondition を勝手に足して非整列 path を落とさない。

Concrete-address fast path は既知 byte map を使う。symbolic address 出現後は `bounded-bv` へ escalation し、既知 bytes と時系列 write history を保持する。初期 memory は「各 read に無関係な fresh symbol」ではなく、**一つの arbitrary byte function の有限観測**として表す。

```text
初期 byte: R_i = ite(a_i == a_j, R_j, ... , fresh_BV8_i)
           （全ての以前の初期観測と、明示された concrete initial bytes を含む）
write後:   load(a) = ite(a == newestStoreAddress, newestByte,
                        ite(a == olderStoreAddress, olderByte, initial(a)))
```

任意の有限 address valuation について、同じ address の初期観測が等しくなり、異なる address には独立の byte を割り当てられる。この有限 trace / bounded domain の read-over-write 表現を既存 Bool/BV backend が扱う。一般 Array sort・quantified memory・unbounded array theory 対応とは異なる。equal address 条件を省略して独立 fresh に分裂させない。

`fork()` は path-local store を独立 copy し、初期 arbitrary function と query budget だけ共有する。`joinByteMemory(condition, yes, no)` は同じ query arena の snapshot を canonical Bool ITE で合成する。結果は frozen。未知 store/clobber、unknown call、volatile/atomic は barrier。MustAlias/NoAlias を名前・string key・public solver boolean から作らない。alias が不明な **既知 symbolic address store** は ITE と source join、address 自体が表現不能な store は barrier にする。

identity は以下7項目すべて必須の bounded nonempty string：
`queryId / snapshotId / binaryId / functionId / architecture / addressSpace / semanticsVersion`。
`getCurrentIdentity()` と各 API で current identity を照合する。stale/cancel/deadline/budget を検知した query から遅延値を公開しない。取得済み immutable result が物理的に消えるわけではないため、再利用側は current identity / 発行済み result の検査を通す。

memory limits は query 全体で precharge。`concreteMemoryBytes <= 65536`, `symbolicMemoryCells <= 4096`, `storeHistoryEntries <= 4096`, `aliasForks <= 16`。補助安全上限は `workItems <= 250000`, `expressionNodes <= 100000`, `allocationUnits <= 1000000`。上限超過は途中 exact 結果を返さない。store history は **byte write entry** を数えるので8-byte STORE は8 entry。fork の複製も割り当て計上する。`expressionNodes` は lowerer が作った node 数、`allocationUnits` は配列・履歴・状態 copy 等の論理単位で、JS heap bytes の実測とは主張しない。

既存 executor の bounded mode は `maxPaths <= 16`, `maxSteps <= 2000`（path 当たり）, `maxBranches <= 32`, `maxBlockVisits <= 3`。IR 配列と path copy は処理前に検査する。deadline default は memory 250ms、taint/proof は各 API の設定を使用。API 自体には明示的 timeout override があるため、固定性能判定では lock の250ms/120msを別に照合する。大きな override を iPad 合格と解釈しない。

### 5.2 Translator と既存 execution の境界

新 `translate/memory.js` は既存 `translateSemanticIR` で scalar placeholder を canonical 化し、既に実行した値へ対応づける。BIN の既存 `.sub` と共有 translator の `.subOp` を adapter が橋渡しする。未対応 opcode を別 evaluator で解釈しない。legacy SYM object を canonical Expr として注入できないよう sort/schema/frozen state を検査する。

対応 address は exact absolute GLOBAL、または既存 generic base+displacement（index なし）。実際の v2→v1 descriptor **`inst.extra.memoryAccess`** の `widthBits/addressSpace/endian/volatility/atomic/ordering`、`addr.widthBits/addressSpace/precise`、`extra.addressPrecise` を読む。descriptor がある場合、volatility/atomic が false と確定し、endian/width/space が一致しなければ fail closed。descriptor 不在の legacy op は明示的な plain-byte IR 契約として扱うが、static authentication を意味しない。

sign/zero-extending LOAD、indexed addressing/ISA extension、TBZ/TBNZ や未接続 flags/SEL は自前再実装せず partial。unknown qualifiers のまま生成される現行 upstream の IR まで一律 complete にする接続ではない。共有 `translate/semantic-ir.js` と `translate/slice.js` は不変であり、単独 shared translator を新 memory state に差し替えたとは主張しない。

### 5.3 First-class taint

lattice は `untainted`（bottom）、有限の sorted source set、`top` の一つだけ。join は commutative / associative / idempotent、TOP は clean と別。未観測/未解決 value、初期未知 byte、unknown semantics/call は TOP。source 集合が `sourceLimit` 上限を越えた場合は TOP にし、切り詰めて clean にしない。

semantic value ID と private byte label handles を一つの graph に載せる。explicit data、address dependency、control dependency、phi/join、byte partial overwrite/load が同じ graph に edge を作る。partial byte sanitizer は対応 value/source のみに効き、隣の byte の source は消えない。control は保守的に引き継ぐため過剰 taint はあり得る。UI/AI が推論し直す構造ではない。

worklist は bounded fixed point。`updatesPerValue <= 8`、最後の更新で TOP widening により終了し、source 集合を無言で落とさない。ループ graph の固定点はテスト済みだが、executor の loop visits を越えた実行は partial/no-publication。interprocedural recursion/call summary は未実装で、unknown call を barrier/TOP にすることで偽の clean を出さない。

model は `createTaintModels({ id, version, provenance, sources, sinks, sanitizers })` で発行する immutable handle。各 entry は `id, valueId, version, provenance` を保持し、全体 digest を `modelIdentity` にする。sanitizer は **`scope: 'value'` と `removeSources: [...]`** が宣言された範囲だけを除去する。名前に sanitize がある、`clean: true`、未知 scope だけでは除去しない。TOP を sanitizer で clean にしない。version/provenance は model の追跡情報であって、その宣言自体を意味保存の証明にはしない。

`queryTaint(ir, { identity, models, memory, execution, limits, signal, isCancelled, getCurrentIdentity, getCurrentModelIdentity })` が本番入口。内部で実際の `symbolicExecute` と byte memory を使う。発行済み result だけ `projectTaint` へ渡せる。query/snapshot/model が不一致・cancel 済みなら再投影を拒否。既存 `EvidenceGraph` と `createSymbolicEvidence` に source→value/memory→sink の依存を投影し、taint evidence の `verdict: unknown / proofAuthority: none` を保つ。

limits は `latticeValues 100000 / flowEdges 200000 / workItems 1000000 / updatesPerValue 8 / sources 4096 / sinks 4096 / emittedRecords 100000`。emitted records は graph nodes/edges/sinks/summary を計上。resource/cancel/stale/deadline 時は sinks/values/edges を空にし evidence/graph を null にする。unsupported semantics の partial は TOP 診断を許すが exact/proof としない。入力型や model 構造の programmer error は TypeError であり、資源中断とは区別する。

### 5.4 Proof consumer

`verifyDeobfuscationCandidate(candidate)` は `candidateId / beforeValueId / afterValueId / identity / before / after / correspondence.inputs / preconditions / memoryObservables / effectObservables` を束縛する。observables の配列自体が無い candidate は拒否。nonempty memory/effect は既存 judge handoff で拒否するため、対象は **pure Bool/BV expression** のみ。空配列を送っただけで、実際の decompiler effect 不在を認証したことにはならない。

実際の `ExhaustiveBvBackend`、または明示した `backendTier: 'tiered'` により既存 `TieredBvBackend` の session を作り、既存 `verifyBoundedEquivalence`（内部の query / eligibility / model / non-vacuity 確認を含む）を呼ぶ。before/after hash、width/sort、input symbol ID 対応、preconditions、snapshot、任意の発行済み taint result/model/queryHash を scope に含める。異なる symbolId の同名 symbol は共有 judge の name fallback を避けるため拒否する。

本当に `proved` かつ既存 proved evidence の場合のみ eligible。contradictory preconditions、refuted、timeout/cancel、unsupported/stale proof、初期 memory symbols、unknown taint/sanitizer は採用不可。`verified:true`、外部 backend/session/proof/solverResult の注入を拒否する。taint が無い／untainted なことを削除 proof にしない。

`isAdoptableCandidate(result, { identity, before, after })` は privately issued receipt と同一の対象/current lifecycle を検査する。clone/JSON/hash-shaped receipt は redeem 不可。receipt は同一 JS process 内の eligibility であり、永続化した証明 certificate の認証 API ではない。既存 decompiler transaction/structuring は触っておらず、これだけで end-to-end adoption は完了しない。

## 6. source → production wiring → 回帰対応

| 対象 / 既存 authority | production wiring | 回帰ファイル（tests/ 以下） | 接続の状態 |
| --- | --- | --- | --- |
| LOAD/STORE / canonical Expr | symbolicExecute → translateMemoryAccess → createByteMemory | phase9/memory/byte-memory-production.test.mjs; backend-executor.test.mjs | 実行済み |
| 既存 Sandbox | FunctionSandbox.symbolic → symbolicExecute（既存委譲） | phase9/memory/backend-executor.test.mjs | 実行済み・sandbox変更なし |
| 既存 adapter | js/adapters/index.js:443 → symbolicExecute(ir, spec.options || this.options) | 既存 Phase9/legacy subsystem；専用UI実機は未実行 | options経路を確認・自動opt-in/UI設定は未追加 |
| scalar Semantic IR | translateExecutionValue → translateMemoryScalar → 既存 translateSemanticIR | phase9/memory/backend-executor.test.mjs; byte-memory-production.test.mjs | 実行済み・shared translatorは不変 |
| v2→v1 descriptor | extra.memoryAccess / addr metadata → translateMemoryAccess 検査 | phase9/memory/backend-executor.test.mjs | descriptor負例済み・upstream qualifier認証はhandoff |
| source→symbolic partial bytes | queryTaint → executor → 同じ byte memory labelDomain → flow | phase9/taint/production.test.mjs | 本番integration実行済み |
| control / phi / fixed point | executor control/phi hooks → taint/flow.js | phase9/taint/lattice.test.mjs; production.test.mjs | 実行済み |
| sink → evidence | queryTaint → projectTaint → 既存 EvidenceGraph/symbolic evidence | phase9/taint/production.test.mjs; lifecycle-regression.test.mjs | 実行済み・証明権限なし |
| candidate → proof eligibility | public index → verifyDeobfuscationCandidate → 既存 judge/session | phase9/taint/proof-consumer.test.mjs | pure Bool/BV実行済み・memory/effects拒否 |
| P-SYMMEM / P-TAINT | Phase9自動発見のperformance.testからfinal-closure owned casesをimport | final-closure/t033/performance.test.mjs; t034/performance.test.mjs | 9+9実行・Phase8/公式 collectorは未接続 |

## 7. 実行結果・再現コマンド

実行環境は Node **v22.16.0 / Linux x86_64**。各コマンドは展開した repo root から実行。既存 package.json/scripts と Phase9 runner を authority とし、それらは変更していない。owned test は `tests/phase9/` の自動発見対象であり、広域テストから除外していない。

| 対象 | 結果 | 件数 / 時間 | evidence ZIP 内ログ |
| --- | --- | --- | --- |
| 最終 focused | PASS | 63 tests / 63 pass / 0 fail; 1075.207ms | logs/27-candidate-focused.log |
| canonical Phase9 | **FAIL** | 224 tests / 223 pass / 1 fail; 40432.450ms | logs/28-candidate-phase9.log |
| 既存 release 単独・現コード | FAIL | 1 test / 1 fail; missing playwright | logs/22-release-current.log |
| 既存 release 単独・未変更 ZIP | FAIL（同じ失敗を再現） | 1 test / 1 fail; missing playwright | logs/23-release-baseline.log |
| syntax lint | PASS | 2109 files checked | logs/29-final-lint.log |
| module boundaries | PASS | 既存 unit validator と production validator の2 commands | logs/29-final-module-boundaries-test.log |
| evidence writers | PASS | 既存 unit gate と production gate の2 commands | logs/29-final-evidence-writers-test.log |
| core contracts | PASS | package authority の5 scripts。統一TAP件数は出さない | logs/38-core-final.log |
| legacy symbolic compatibility | PASS | issues-130-symbolic script 1本 | logs/39-legacy-final.log |
| 分割適用 MEM | PASS | 37/37; 886.127ms | logs/34-reapply-MEM.log |
| 分割適用 TAINT | PASS | 18/18; 341.759ms | logs/35-reapply-TAINT.log |
| 分割適用 PROOF | PASS | 8/8; 426.782ms | logs/36-reapply-PROOF.log |
| 完全パッチ一括再適用 | PASS | git apply --check / apply + 63/63; 1109.069ms | logs/37-reapply-full.log |
| 独立 byte oracle | PASS | 2-bit address domain / 256観測、production memory helper 非再利用 | focused 内 byte-memory.test.mjs |
| browser / iPad-WebKit / 全体CI | NOT RUN | 実機・browser依存未導入。Node合格で代用しない | metricsのNOT RUN項目 |
| 公式collector/verifier / phase8OptimizeStage | NOT RUN | owner接続なし。120msの公式合格は未証明 | metrics/P-TAINT.node.json |

```sh
# Focused + locked owned measurements
HEX_002_METRICS_DIR=/absolute/path/to/metrics \
  node --test tests/phase9/memory/*.test.mjs tests/phase9/taint/*.test.mjs

# Broad runner; full output was captured in the artifact log, not omitted from validation
HEX_TEST_OUTPUT=verbose node scripts/run-quiet-command.mjs \
  --label 002-candidate-phase9 -- npm run phase9:test

HEX_TEST_OUTPUT=verbose node scripts/run-quiet-command.mjs --label 002-lint -- npm run lint
HEX_TEST_OUTPUT=verbose node scripts/run-quiet-command.mjs --label 002-boundaries -- npm run module-boundaries:test
HEX_TEST_OUTPUT=verbose node scripts/run-quiet-command.mjs --label 002-evidence -- npm run evidence-writers:test
HEX_TEST_OUTPUT=verbose node scripts/run-quiet-command.mjs --label 002-core-final -- npm run core:test
HEX_TEST_OUTPUT=verbose node scripts/run-quiet-command.mjs --label 002-legacy-final -- node tests/issues-130-symbolic.mjs

# Existing dependency failure reproduced both before and after the patch
node --test tests/phase9/release/release-evidence.test.mjs
```

release import chain は `release-evidence.test.mjs` → `tools/validation/phase9/verify.mjs` → `tests/phase9/browser/worker-runtime.mjs` → `playwright`。パッチで既存テストを skip したり dependency/lock を改変したりしていない。初回の広域起動は実行ツールの上限で中断したが、上記最終 run は終端の counts/exit code まで取得済み。最終 Phase9 起動時の **2076個の js/tests ファイルハッシュ**は納品時と一致する（`candidate-phase9-run.json`）。

## 8. 性能 lock と実測（固定9ケースずつ）

authority は変更していない `specs/005-analysis-final-closure/contracts/performance-locks.json`。以下は **owned fixtures の Node 実測**であり、official collector の認証結果でも iPad/WebKit 合格証拠でもない。case ごとに実際の query counters を採集し、複数 trial がある場合の count は constituent query の最大値、wallClock は checks/replay を含む case elapsed。生値・trialごとの status/reason/counters は JSON に残した。表のゼロは実行でその resource を消費しなかった値であり、固定ゼロを填めたものではない。

### 8.1 P-SYMMEM

fixture ID `symbolic-byte-memory-v1`、digest `d9f09ee18a64760b2b177646b4d6aee0`、分母 **9 cases**。lock は paths≤16 / stepsPerPath≤2000 / branches≤32 / blockVisitsPerBlock≤3 / concreteMemoryBytes≤65536 / symbolicMemoryCells≤4096 / storeHistoryEntries≤4096 / aliasForks≤16 / wallClock≤250 milliseconds。以下の9ケースは owned runtime assertion と上限照合を通過した。barrier/cancel ケースの期待する partial も正しい negative outcome として検査する。

| case ID | paths | steps/path | branches | visits/block | concrete bytes | symbolic cells | history entries | alias forks | wall ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| little-endian-full-load | 1 | 3 | 0 | 1 | 4 | 0 | 4 | 0 | 6.080 |
| big-endian-full-load | 1 | 3 | 0 | 1 | 4 | 0 | 4 | 0 | 0.868 |
| partial-overwrite | 1 | 4 | 0 | 1 | 4 | 0 | 5 | 0 | 1.061 |
| concrete-to-symbolic-escalation | 1 | 4 | 0 | 1 | 4 | 1 | 5 | 0 | 4.066 |
| may-alias-fork | 2 | 7 | 1 | 1 | 0 | 3 | 3 | 2 | 15.908 |
| unknown-clobber | 1 | 2 | 0 | 1 | 4 | 0 | 4 | 0 | 0.619 |
| volatile-barrier | 1 | 2 | 0 | 1 | 4 | 0 | 4 | 0 | 0.488 |
| atomic-barrier | 1 | 2 | 0 | 1 | 4 | 0 | 4 | 0 | 0.307 |
| cancel-replay | 1 | 3 | 0 | 1 | 4 | 0 | 4 | 0 | 1.130 |

最大 elapsed **15.908ms**。補助カウンタの最大は workItems **127** / expressionNodes **15** / allocationUnits **37**。この小 fixture の結果を、全上限同時到達時の250ms保証や native/device性能と一般化しない。別の N−1/N/N+1 回帰は、memory resource と executor resource の拒否境界を検査している。

### 8.2 P-TAINT

fixture ID `symbolic-taint-proof-v1`、digest `fcbc5318d9ece6eca31de1180edcb92d`、分母 **9 cases**。lock は latticeValues≤100000 / flowEdges≤200000 / workItems≤1000000 / updatesPerValue≤8 / sources≤4096 / sinks≤4096 / emittedRecords≤100000 / phase8OptimizeStage≤120 milliseconds。

| case ID | values | edges | work | updates/value | sources/sinks | records | query ms（参考） | phase8OptimizeStage |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| explicit-data-flow | 4 | 1 | 26 | 1 | 1/1 | 7 | 4.869 | NOT RUN |
| implicit-control-flow | 13 | 15 | 157 | 1 | 1/1 | 30 | 4.753 | NOT RUN |
| byte-memory-flow | 13 | 15 | 142 | 1 | 1/1 | 30 | 1.926 | NOT RUN |
| known-sanitizer | 4 | 1 | 26 | 1 | 1/1 | 7 | 0.521 | NOT RUN |
| unknown-sanitizer | 4 | 1 | 26 | 1 | 1/1 | 7 | 0.468 | NOT RUN |
| may-alias-store | 15 | 17 | 159 | 1 | 1/1 | 34 | 8.994 | NOT RUN |
| proof-timeout | 4 | 1 | 26 | 1 | 1/1 | 7 | 0.483 | NOT RUN |
| cancel-replay | 4 | 1 | 26 | 1 | 1/1 | 7 | 0.500 | NOT RUN |
| proven-deobfuscation | 4 | 1 | 26 | 1 | 1/1 | 7 | 0.573 | NOT RUN |

9/9 case の機能・counter 上限 assertions は PASS。ただし **`phase8OptimizeStage` は全9件 null / NOT RUN** であり、P-TAINT profile 全体の合格は未証明。query 時間（最大8.994ms）をこの120ms指標へ置換していない。`proof-timeout` は実 consumer の deadline 拒否（0.440ms）、`proven-deobfuscation` は実 backend の `proved` / `proofAuthority: exact`（proof elapsed 6.221ms）。これらも Phase8 時間とは別。

公式 collector へは、既存 profile の case ID / unit / denominator を維持したまま、owned JSON の query metrics と実際の Phase8 entrypoint の stage measurement を接続する必要がある。単に `queryMilliseconds` を `phase8OptimizeStage` に rename してはならない。

## 9. 未対応・外部 owner 向け handoff

| 残差 / owner | 現在の安全な境界 | 必要な最小 API / 接続・反例・invalidation |
| --- | --- | --- |
| 共有 translator: semantic-ir.js / slice.js; #6546/#3421/#3422 | 新 bridge は production executor から実際に呼ぶが、standalone shared translator 全体は未接続 | query identity付き execution value resolver / memory resolver を共有 translator に渡す API。load→scalar と alias read-over-write を canonical ID で保持。snapshot/function/architecture/space/semantics変更で invalidate |
| upstream memory qualifiers / authenticated MemorySSA | descriptor が unknown のままなら partial。static forwarding を推測しない | 既存 canonicalMemoryForwardingContextForLoad(fact,load,context) / isCanonicalExactMemoryForwarding(fact,expectedContext) を owner が認証済み fact と照合。byte coverage/endian/clobber/volatile/atomic/identityの反例を維持 |
| Expr / solver general arrays; #6450・T014候補 | 有限 Bool/BVのみ。shared Expr/schema/backend は一切変更なし | 必要なら array sort/store/select/capability と model validation の canonical API を別ownerで設計。現有限loweringをarray対応と偽称しない。schema/backend/semantics版変更でproof invalidate |
| verify/equivalence.js; #6602 | nonempty memory/effect observables は no-adoption | before byte0=1 / after byte0=2 / equal return のcounterexampleをquery差分に含める。memory observable coverageとsort対応をjudge/eligibilityが認証するまでconsumerの拒否を維持 |
| decompiler proof consumer / C4-04 / transaction owner | pure-expression eligibilityだけ。candidateをtransactionへ書き込まない | 現行semantic value ID・input対応・実effects不在をownerが認証し、isAdoptableCandidateをcurrent contextで照合して既存transactionへ渡す。AST/CFG/effects/width/snapshot変化で再証明 |
| taint call/recursive summaries・memory-range sanitizer | unknown callはbarrier/TOP。value-scoped宣言だけ有効 | versioned、identity-bound call/source/sink/sanitizer summary APIが必要。unknown summaryや部分範囲外をcleanにしない。model変更時にevidence/proofともinvalidate |
| Phase8 / official performance collector | owned countersとquery elapsedのみ。phase8 stageはNOT RUN | 既存phase8OptimizeStageの実entrypointを測るhookとcollector入力。固定9ケース、単位、分母、120msを保持 |
| browser / iPad-WebKit / CI / main integration | Node検証済み候補として納品 | 既存依存のある環境でPhase9 release/browserと実機を実行し、最新mainとconcurrent PR差分を再照合。入力SHAからmain mergeは推論不可 |

## 10. 論理単位ごとの exact changed paths・適用

完全パッチは単独で元 ZIP に適用できる。分割版は evidence ZIP の `units/` 内。**完全版と分割版を同じ tree に重ねて適用しない**。分割版は MEM → TAINT → PROOF の順。MEM の optional taint hooks は TAINT 未適用時には何もしない。共有 fixture `tests/phase9/taint/fixtures.mjs` は MEM 試験でも使う純粋な IR fixture のため MEM 単位へ含めた。

### MEM — `units/001-MEM.patch`

```text
js/symbolic/executor.js
js/symbolic/index.js
js/symbolic/memory/byte-memory.js
js/symbolic/memory/query-state.js
js/symbolic/translate/index.js
js/symbolic/translate/memory.js
tests/final-closure/t033/performance-fixtures.mjs
tests/final-closure/t033/performance.test.mjs
tests/phase9/memory/backend-executor.test.mjs
tests/phase9/memory/byte-memory-production.test.mjs
tests/phase9/memory/byte-memory.test.mjs
tests/phase9/memory/performance.test.mjs
tests/phase9/taint/fixtures.mjs
```

SHA-256: `a6fcfa1ca02dc9608ac64c39fff8cea4ae0d6c3d7d6707383657f2810631e4de`

### TAINT — `units/002-TAINT.patch`

```text
js/symbolic/index.js
js/symbolic/projection/taint.js
js/symbolic/query/taint.js
js/symbolic/taint/flow.js
js/symbolic/taint/lattice.js
js/symbolic/taint/models.js
tests/phase9/taint/lattice.test.mjs
tests/phase9/taint/lifecycle-regression.test.mjs
tests/phase9/taint/production.test.mjs
```

SHA-256: `6213cd83acb041958ec21fddf0ed4ee3ff1fcc74865c5ffc9a3fb74a79cae061`

### PROOF — `units/003-PROOF.patch`

```text
js/symbolic/index.js
js/symbolic/taint/proof-consumer.js
tests/final-closure/t034/performance.test.mjs
tests/phase9/taint/performance.test.mjs
tests/phase9/taint/proof-consumer.test.mjs
```

SHA-256: `94ebad3193d5659e2a1dce736867aca50a5bec5481a38300f52aaa2b0dca572e`


```sh
# 完全版（新たな元 ZIP 展開先で）
git apply --check /path/to/002-analysis-symbolic-memory-taint.patch
git apply /path/to/002-analysis-symbolic-memory-taint.patch
node --test tests/phase9/memory/*.test.mjs tests/phase9/taint/*.test.mjs

# 分割版（上記とは別の元 ZIP 展開先で）
git apply --check /path/to/evidence/units/001-MEM.patch
git apply /path/to/evidence/units/001-MEM.patch
node --test tests/phase9/memory/*.test.mjs

git apply --check /path/to/evidence/units/002-TAINT.patch
git apply /path/to/evidence/units/002-TAINT.patch
node --test tests/phase9/taint/lattice.test.mjs tests/phase9/taint/production.test.mjs tests/phase9/taint/lifecycle-regression.test.mjs

git apply --check /path/to/evidence/units/003-PROOF.patch
git apply /path/to/evidence/units/003-PROOF.patch
node --test tests/phase9/taint/proof-consumer.test.mjs tests/phase9/taint/performance.test.mjs
```

既存 executor に末尾 newline が無かったため、最初の artifact diff 生成は EOF marker の扱いで `git apply --check` に失敗した。これは納品パッチの生成処理を修正し、元ファイルの末尾状態を `\ No newline at end of file` で正しく保持して再生成済み。失敗ログを `*-before-packaging-fix.log` として残した。現在の完全版・全分割版は apply/check と試験まで成功している。

再適用後の **全2553 regular files** の SHA-256 を、検証済み work tree・分割再適用 tree・一括再適用 tree の3者で比較し完全一致した（`reapply-audit.json`）。既存 read-only/shared source と既存 test の差分は0。input identity の Git 検証とは区別した byte-level 再現検証である。

## 11. 最終自己レビューと成果物

重複 scalar/solver/static-alias engine は追加していない。byte lowering と taint graph は query-local state の owner に限定した。unknown byte のゼロ埋め、symbol name alias、source overflow の無言切り捨て、TOP の clean 化、fake proof の採用を防ぐ回帰を追加した。resource/cancel/stale 後は新しい exact 結果/evidence/receipt を公開・再利用しない。memory/sink qualifiers が曖昧なケースを unsupported/partial のまま保持した。

production wiring は §6 の実行済み経路に限る。standalone translator、上流の metadata authentication、general arrays、Phase8/decompiler adoption の全接続は残っている。63件の新規試験通過を T033/T034 全体完了や全CI合格へ拡大解釈しない。外部 CodeRabbit review は未実行であり、ここでの自己レビューをその結果とは称しない。

成果物は以下。manifest に input/patch/changed files/units/logs/metrics/report の SHA-256 と試験状態を記録し、外側の SHA256SUMS は最終 evidence ZIP 自体も検査可能にする（manifest自身を再帰hashしない）。

- `002-analysis-symbolic-memory-taint.md` — この仕様・計画・タスク・契約・検証・handoff。
- `002-analysis-symbolic-memory-taint.patch` — 新規ファイルを含む完全 unified diff。
- `002-analysis-symbolic-memory-taint-changed-files.zip` — 変更後25ファイルだけ、repo相対 path。
- `002-analysis-symbolic-memory-taint-evidence.zip` — 生ログ、固定case測定、before hash ledger、再適用監査、分割patch、manifest。
- `002-analysis-symbolic-memory-taint-manifest.json` — standalone manifest。
- `002-analysis-symbolic-memory-taint-SHA256SUMS.txt` — 最終成果物hash一覧。
