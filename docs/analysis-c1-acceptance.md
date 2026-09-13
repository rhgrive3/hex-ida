# C1 ユーザー側ローカル受入 — 2026-09-13 最終追記反映

正本: `docs/analysis-roadmap-v8-integration-checkpoint.md` の2026-09-12担当分担。
今回の唯一の開始ツリーは `hex-ida-roadmap-v8-user-c1-c3-20260912.zip`。current main、リモートPR、
過去のCOMPLETE記録を今回の実測と混同しない。**C1-01/03のユーザー側有限受入はCOMPLETE、
C1-02の別コンポーネント統合を含む全体はPARTIAL。統合受入はCHECKPOINT-LOCKEDのまま。**

## 前回の分類と今回の担当境界

前回はcheckpoint全6,356行を確認し、下の既存受入を作成した。今回は開始checkpoint全6,476行、
前回manifest・検証証拠・現行ソースを照合してから5分類した。今回の詳細は配布ルートの
`user-c1-c3-final-evidence/preflight-classification.md`。過去の検証記録も削除せず保持する。

| 対象 | 開始時の分類 | 既存canonical owner / 再利用した証拠 | 今回の到達点 |
|---|---|---|---|
| C1-01 完全なstore/load、width/endian、拒否側 | 実装済み・組合せ受入が必要 | `pointsto/local.js`、既存MemorySSA、loaded-pointer 130セル | summary由来pointerをspill/reload/fieldへ接続。arg-returnの不足だけ局所修正 |
| C1-02 有限arg/root/allocation、direct/exhaustive、wrapper | 実装済み・組合せ受入が必要 | `summary/{contract,local,interprocedural}.js`、既存72セルtarget/SCC検査 | summary生成→wrapper合成→caller→MemorySSAの受入。summary production変更なし |
| C1-03 root identity、名前非依存 | 実装済み・受入が必要 | alias solver、30-query corpus、240セルroot rename | 既存matrixを再利用。共有width境界#4515の既存2FAILも今回修正し、同じassertionがPASS |
| より広い再帰値探索・lifetime | 一部実装済み・統合残件 | 既存object/lifetime/summary owner | local-fact SCCと広い再帰returned-value discoveryを区別。既存lifetime 9件PASS。新規solverなし |
| 指定combined tests / 本MD | 未実装 | 機能欠落とは解釈しない | 2つの受入ファイルと本MDを追加 |
| shared alias/MemorySSA、ME/C4、semantic/compat、CI/generated | 原則別担当。今回の明示許可により必須境界のみ局所修正 | alias solver 1.1.1 / MemorySSAのexact issuer versionを同期 | ME/C4 productionは無変更。必要なC2/C4 fixtureのversion literalのみ同期。残る由来/navigation失敗は引継ぎ |

## 受入行列

| Item / 入力 | 期待結果 | 新しい受入・実測 | 不足 / 対象外 |
|---|---|---|---|
| C1-01/02: arg/root/allocation × direct/exhaustive × little/big × ordinary store/load | exact root・offset・64-bit幅を保持。全候補summary digestを依存に記録。fieldは+8。argの複数offsetは保守的range union | `pointsto/c1-combined-acceptance.test.mjs`: 108組合せ中12成功側、96拒否側、全PASS | この明示的finite summary契約を超えるcall-target探索ではない |
| 同入力 × unknown-call / may-alias / width-conflict / endian-conflict / atomic / volatile / copied-MemorySSA / stale-MemorySSA | loaded/fieldともTOP、有限targetの部分結果を出さない。MemorySSA不在もTOP | 同上。入力不変・再実行一致も全行検査 | MemorySSA自身の第二実装・validator緩和なし |
| C1-01/02: arg machine width 32/64 × return offset 0/16、return width 64 | 64→64のみcall-result originと幅を根拠にspill可能。32→64を型幅だけで64-bit pointer証明にしない | 同ファイル4件PASS | ABI推測やspill幅からpointer幅を補完しない |
| C1-01: cancellation / maxWorkItems | 停止理由を保持し、未完了値を完全な証明に昇格しない | 同ファイル1件PASS | 実時間保証ではない |
| C1-02: 3種類 × 1/2候補 × 9 summary状態 | 完全時のみwrapper offset +8を合成。missing/stale/partial/unknown-return/unknown-effect/wrong-function/contract/non-exhaustiveは拒否 | `summary/c1-combined-acceptance.test.mjs`: 54行PASS。bad候補の順番も反転検査 | native indirect universeの完全探索は未受入 |
| C1-02: changed digest / provider cancellation | 古い依存結果を再利用せずrecompute、キャンセル後に確定させない | 同ファイル2件PASS（合計56件） | recursive returned-value discoveryを新規実装しない |
| C1-03: 既存30-query frozen corpus | exact 15 / conservative 15。左右反転でも同じ関係、NoAlias/MustAliasを名前から作らない | pointstoファイル内1件で30行検査。alias既存95件PASS（240セルrename検査を含む） | 下記#4515の2反例は修正済み。unknown pointer widthはmayを維持 |

新しいC1テストは **114 + 56 = 170件PASS**。内部matrixのセル数をNode test件数と重ねて加算しない。
既存72セルsummary行列、130セルloaded-pointer、240セルroot renameを複製していない。
新しいhelperは既存IR/SSA/MemorySSA/alias APIでfixtureを構成するだけで、semantic truthを所有しない。

## 前回の局所修正と反証（今回そのまま保持）

`js/analysis/pointsto/local.js` の既存returns-arg枝だけを修正した。
arg setのroot/range/lossReasonsを維持して、検証済みcall resultのoriginを証拠に加える。
returnとargumentのmachine widthが一致し、既存target幅と矛盾しない場合だけ幅を補完する。
これにより既存 `storedPointerSetIsValid` が同じcall resultとの対応を確認できる。
MemorySSA側の証拠チェックは緩めていない。A2 versionは1.3.2→1.3.3。

既存 `FunctionFixture.constant` のbitvector kind、およびzext/sextのfromBits/toBitsを
現行IR契約へ揃えた。summary本体は変更していない。
`c1-02-target-matrix` のreturns-arg assertionはroot/offsetだけでなく追加origin/widthを明示的に検査する。

開始時のproduction 3ファイルだけへ差し戻した別コピーで、最終受入12件中9件が赤。
うちC1のdirect/exhaustive × endian 4件はすべて赤。修正後は同じ12件すべてPASS。
ログ: `counterfactual-old-production.log` / `counterfactual-fixed-production.log`。
これはテストfixtureだけで成功を作っていないことの局所的な反証であり、全体の正しさ証明ではない。

## 今回の最小修正と反証

first divergenceは `pointsto/alias.js:absoluteInterval` がpointer width欠落時にaccess widthを借りたこと。
両者は異なる証拠なので代用を除去した。不明/不正widthは`may`と`provenance-lost`、既知64-bitで
証明できる区間分離は`no`のまま。元の#4515 2assertionは変更せず、malformed値×access幅×左右反転を1testに追加した。

canonical alias solverを1.1.0→1.1.1へ更新し、MemorySSA proof-coreのexact issuer entryも同時に更新。
旧1.1.0からの強い証拠は拒否する。必要な既存positive fixture/version assertionだけを同期した。
#4165の正例にも明示pointer width=64を与え、未知widthの反例はそのまま残した。
新しいalias/latticeやMemorySSA engineは作っていない。

最終テストを保持し、production 6ファイルだけ開始時bytesへ戻した別コピーでは150件中16FAIL。
修正後の同じ150件は全PASS。C1の3反例とC3の13反例が赤になる。これは局所的な差分の反証であり、全体の正しさ証明ではない。
証拠は `user-c1-c3-final-evidence/results/counterfactual-{production-revert,fixed-production}.log`。

## 今回の実測

すべて配布ルート `user-c1-c3-final-evidence/` の新しい結果。以下のgroupはcombinedを含むため合算しない。

| 範囲 | 最終実測 | results/ 以下のログ |
|---|---|---|
| C1 combined | 114+56=170 PASS | `combined-final-initial.log`（C3を含む358件） |
| #4515 2ファイル | 10/10 PASS（開始時9件は7PASS/2FAIL） | `fixed-4515.log` / `baseline-4515.log` |
| points-to（combinedを含む） | 270/270 PASS | `pointsto-regression-synced.log` |
| summary（combinedを含む） | 469/469 PASS | `summary-regression.log` |
| alias | 95/95 PASS | `alias-regression-fixed.log` |
| bounded object lifetime | 9/9 PASS | `lifetime-existing-acceptance.log` |
| shared alias/MemorySSA/ABI selected regression | 32/32 PASS | `broader-semantic-alias-memory-abi.log` |
| Phase7 root / discovery | 428/428、130/130 PASS | `broader-phase7-root-final.log` / `broader-phase7-discovery.log` |
| Phase7 integration/crossarch/foundation/negative/analysis | 155/155 PASS | `broader-phase7-selected.log` |

## C1-02の残件を区別する

有限arg/root/allocation・wrapper・exhaustive候補・summary digest・stale/cancelのユーザー側受入は完了。
`tests/scpa/object-lifetime.test.mjs` の既存9件も再利用して、frame内normal lifetimeとescape/free/foreign-owner拒否を確認した。
これはruntime heap instanceのsingletonやfree/reuseをexactにする証明ではない。

**真のrecursive returned-value discoveryは全体要件のnon-goalではなく、別C1コンポーネントの統合残件。**
開始checkpoint 5074–5090行はlocal-fact SCCと呼出し経由の発見を明確に区別し、5205–5222行は
別C1 1.4 recursive-equation schemaをこのcontractへ混ぜないと記録している。
現行 `summary/interprocedural.js` は収束後も`local.returnProvenance`を公開し、call-return equationを所有していない。
`recursive-boundary.mjs` の抽象contract probeでも未知のlocal returnを勝手にargへ昇格せず、明示的な有限arg正例は通る。
これはnative recursive oracleではない。必要操作は既存C1 1.4成果物のcanonical schemaを統合担当と照合して取り込み、
recursive call経由のreturnをそのownerで受入すること。今回、禁止された別ZIP取込み・第二equation solverは行わない。

native indirect-callの全候補探索、runtime heap/free-reuse/TLS identity、typed CALL/native全型再構成は、
有限の明示候補・宣言layoutの受入から推論しない。boundedな候補列挙を完全なwhole-program universeと呼ばない。
**C1-01 COMPLETE、C1-02 PARTIAL（有限ユーザー側受入は完了）、C1-03 COMPLETE。**

## broader gateと統合

#4515は修正済みであり残件ではない。既存のC4 origin/navigation失敗は開始ZIPでも再現した別担当の残件。
exact-head/ownershipのGit履歴不足、full Phase8/9のtimeout、esbuild/playwright不足、generated再build、
current-main照合・独立shadow・実機releaseは、本受入の成功で代替しない。full gateの最終件数はcheckpoint末尾とfinal manifestに記録する。

```sh
timeout -k 2s 30s node --test tests/phase7/pointsto/c1-combined-acceptance.test.mjs \
  tests/phase7/summary/c1-combined-acceptance.test.mjs
timeout -k 2s 30s node tests/phase7/run.mjs --group summary
timeout -k 2s 30s node tests/phase7/run.mjs --group alias
timeout -k 2s 30s node tests/phase7/run.mjs --group pointsto
timeout -k 2s 20s node --test tests/scpa/object-lifetime.test.mjs
```

今回分だけの `analysis-roadmap-v8-user-c1-c3-final.patch` を使用し、前回C1/C3 patchやME budget patchを二重適用しない。
checkpointは末尾の今回追記だけを移植。alias solver・exact issuer map・test fixtureのversionを一体で統合し、
古い1.1.0の証拠を再承認しない。共有semantic/ABI境界とC4側fixtureの同時変更はfinal manifestの一覧で照合する。
**CHECKPOINT-LOCKED維持。remote操作は一切実施していない。**


---

# 2026-09-13 C1-02 recursive returned-value discovery — ローカル実装・受入

**この節が今回のC1-02 laneの最新記録。前半の「C1-02 PARTIAL」「summary production無変更」は開始ZIP時点の履歴である。**
C1-02の再帰的な返り値発見を既存canonical production ownerへ接続した。
**C1-02 recursive lane: COMPLETE（以下の有限契約・反例・実測範囲）。**
同梱の最終レビュー記録で同一配布diffに対するfull reviewが3回連続ゼロ指摘であることも終了条件とする。
統合全体・native whole-program acceptance・releaseの完了は意味しない。**CHECKPOINT-LOCKEDは維持。**

## 基点・最終identity・既存成果

- 唯一の基点: 添付 `hex-ida-roadmap-v8-user-c1-c3-final-20260913.zip` の全bytes。
  Git履歴がないため作成したlocal synthetic **base SHA `48249390d511340db800320081d6a0c5a0abd868`**。
  base treeは `28a5f2aceecc83feba32fe874d58bf4592f3b7ba`。upstream SHAとは区別する。
- **final source/test SHA: `7b45320b7f9dd4321b7656a9cb481bc6f645666e`**。
  実装接続commit `3bd27cdfa7737de6a4defc67511288fada1a0fbf` と、全return経路の修正commitからなる。
  本MDだけの後続commitを含む配布HEAD、patch SHA-256、各fileのbase/final hashは同梱 `manifest.json` に記録する。
  MD自身にそのMDを含むcommit SHAを書き込む自己参照は行わない。下の全gateは上記source/test SHAの実行証拠である。
- 再利用: `df98376aea3e298620ced7fe99f9ceed1b7d0caa` のtransfer/substitution/local equation/SCC hook、
  `12b873ca095922c826b2062f2dcf032f65f3ef5c` の96セルproducer/target/wrapper行列。
  古いbranchのmerge、blind cherry-pick、古いファイル全体の上書きは行っていない。
- `git fetch origin` はDNS失敗。指定commitの `git show --stat/--name-only` はobject不在で実行不能だったため、
  GitHub read connectorで実際のcommit metadata/patch/raw sourceを取得して照合した。
  `analysis-c1-recursive-cea67` は404だったが、上のexact commitsは取得できた。
- read-onlyで観測した#7036 head `0b8e65d122340a0bcba6175b15aa61cd5fc85587` のSCC sourceはZIPと同一blob。
  main `943b13d5abc8c2aed2d489fd7eea2671761c8236` も収束後のlocal返り値再公開のままで、return-equations.jsはない。
  open PRの関連語検索とこれらの実sourceを照合。全open PRの全fileを読んだとは主張しない。
  詳細は同梱 `upstream/read-only-audit.md`。**GitHubへのwriteはゼロ。**
- taskが引用したcheckpoint見出しそのものはZIPにない。実在する末尾の2026-09-13 sole-start C1/C3節を使用した。
  checkpoint/ledgerの内容やlockをこのlaneから変更していない。

## first deterministic divergence・root cause・修正

開始時は、実際のlocal producerが返した再帰callのunknownを、SCC収束後もそのまま再公開していた。
`composeSummary` の `unconverged ? [] : local.returnProvenance` ではcallee由来の返り値を発見できない。
最終テストを保持し、このhookだけ元のlocal再公開に戻したcounterfactualでは、13件中12件がsemantic assertionでFAIL。
最初の差は自己再帰の返り値にunknownが残ること。元へ戻した同じ13件は全PASS。
unknown-native-leafの拒否側1件は両方でPASSであり、単なるimport/構文エラーを反証としていない。

`return-equations.js` はcanonical artifactのshape/coverage検証と単一transferの補助だけを持つ。
Semantic IR → local summary → **既存SCC loop** → FunctionSummary → caller/points-toというowner境界を維持する。
既存DemandSummarySessionも同じcomposeSummaryを使用し、元からあるprivate SCC/atomic publicationへ接続した。
新しいsummary engine、第二SCC solver、points-to/alias/MemorySSA engineは作っていない。

local factsと未解決call equationsを分け、全return site/position/alternativeを保存する。
calleeのarg/root/allocation/unknownを実引数の全SSA alternativeへ代入し、offset・addressSpace・allocationSiteIdを保持する。
無根拠な循環のprivate bottomは、既存loop内でunknownへ再評価してから公開する。noreturn証明にはしない。
異なる根拠はsafe union、未知経路を含むunionは未知のまま。複数return位置を混同しない。
void/短いreturnと値を返すreturnの混在は、全経路のposition proofがないためpartial/unknownとし、exactを公開しない。

検査中に見つけた追加の実反例は、同一関数・同一snapshotの古いequations差し替え、call記録順序によるdigest差、
reachable void returnの欠落。いずれも専用red/green証拠と恒久regressionを追加した。
unknown-call-effectsの反例は、broad writeと未確定controlを備えた**有効なpartial契約**であることをassertしてから拒否を検証する。
不正なenvelopeを拒否しただけの結果と混同しない。

## 正例・最小反例・production-path coverage

| 検査 | 分母・期待・結果 | 実際の入口とfixture境界 |
|---|---|---|
| 再利用recursive行列 | 3 kinds × self/mutual × 8 modes × wrapper depth 0/2 = 96セル。24正例/72拒否側、全PASS | 全SCC/wrapper/callerはcanonical IR/CFG/SSA/MemorySSA constructorsと実local producer。root/allocationの非再帰leafだけ明示summaryを供給 |
| 直接/有限間接call | direct、1/2 exhaustive candidate、同根/異根、arg swap、safe union、wrapper chain、複数return位置がPASS | completenessはfixtureが宣言した有限target universe。native indirect universeの発見証明ではない |
| 独立source-path oracle | 256個の2関数graph、512 root検査。240 finite/272 conservative、false exact 0。map/root順序反転も一致 | test-onlyの(function, argument permutation)有限path列挙。production summaryを正解生成に使用しない |
| downstream | arg/root/allocation × little/big × 8 memory modes = 48セル。ordinaryのみloaded/fieldのrootとoffsetを保持、他はTOP | 実caller points-to → store → 既存MemorySSA → load → field。root/allocation leafは上記宣言境界 |
| native hybrid | RV64 `a0 += 1; ret` のdecoder/ABI/lowering/SSA/local producer → inner wrapper → 相互再帰 → outer wrapper → store/loadがPASS。loaded offset 9、field 17 | leafだけ実命令bytes。再帰本体/wrapper/callerはcanonical IR source fixture。完成済みrecursive summaryの注入なし |
| native closest counterexample | `a0 = 7; ret` のleafはargument/root証拠にならず、同じ下流がTOP | 同じ実decoder経路。native全program/全再帰命令のdecode証明とは呼ばない |
| envelope/evidence拒否 | incomplete candidates、missing summary、stale snapshot/digest/source、partial/cancelled、valid unknown effects、old schema/version、malformed/dropped/sparse/ambiguous equationsを拒否 | actual solver → actual callerでTOP。constructor/identityの拒否とcaller結果の両方を検査 |
| 循環/全return | 異根はunion、unknown reachable returnはTOP、無根拠self/mutualはunknown、offset成長は16iterationでtruncated。mixed-arity/voidを落とさない | 実local producerと既存SCC。unknownをnoreturn/exactへ昇格しない |
| counterfactual | 最終test・他productionを保持してhookのみ外すと13件中12FAIL/1PASS、復元後13/13PASS | `counterfactual-only-change.patch` と `results/counterfactual-final-{reverted,fixed}.log`。counterfactual変更は配布sourceに含めない |

Node test件数と内部セル数は別の分母であり、合算してcoverageを水増ししない。
fixtureで構成したcanonical IRから実producerを通した証拠と、宣言済み非再帰leaf summaryの証拠を区別する。
**全native recursive binaryのend-to-end証明やwhole-program completenessではない。**

## version・digest・invalidation・予算・determinism

FunctionSummary schema **3→4**、contract **1.3.0→1.4.0**。C1.4という節番号に合わせた変更ではない。
source-bound equationsと独立したreturnSourceDigestがcanonical envelopeに追加され、旧wireのexact shape/意味とは非互換なためである。
coreを唯一のversion authorityにし、public producer/validator/consumerが同じ値を使う。local/interprocedural analyzerは1.4.0。
`issue-5242-contract-version-source-of-truth.test.mjs` の既存assertionを弱めず、旧1.2/1.3/schema3拒否も追加した。

開始時すでにdigestへ含まれていたreturnValues/returnProvenance/allocations/calls/status等は維持。
returnEquationsとreturnSourceDigestもhashする。source identityはfunction/snapshotと、順序正規化したproducer IRのdigestに結び付く。
引数位置とblock内命令順序は並べ替えない。unordered node/value/block table・target set・call recordだけ正規化する。
同じlocal factsでも再帰call引数が変わればsource digestが変わり、古いequationsの差し替えは拒否される。
semantic return変更→summary digest変更→caller calleeSummaryIds/root変更を検査。
expectedSummaryDigestsで古い候補identityも拒否する。serialized/unbranded summaryも再canonical化して検証し、private brandへの依存を避ける。
既存のversionless・unboundな**effect-only**入力互換は維持するが、旧versionや返り値factsを自動upgradeしない。

同期solverの28 cancellation checkpointsを全点停止して検査（うち19点はSCC開始後）。active SCCの公開は0。
work budget 0〜96の97セルでは20 exhausted/77 complete、exhausted時のactive SCC公開は0。
既存iteration cap、graph node/edge capに加え、transfer workを共有ResourceBudgetへ課金する。
localは4096 equation rows/sites、256 arguments、65536 payload work、SCCは512 return factsで保守的に打ち切る。
予算は実時間保証ではない。source/graph構築には既存の別capも適用される。
Demandのpause/resumeでもprovisional SCCを公開せず、cancel/budget/stale hostで止める。収束済み別componentとactive componentは区別する。
JSON replay、node/SSA/target/map/root順序反転、同一入力再実行でcanonical result/digestを照合した。

## exact source-head test receipts

実行Nodeは22.16.0。全commandを有限timeoutで実行し、log・exit code・SHA-256・source file hashを
同梱 `test-results.jsonl` に保存した。下表のlog名は `results/` 配下。groupはfocused/combinedを含むため合算しない。

| gate | 結果 | log |
|---|---|---|
| focused | 63/63 PASS; exit 0; 9.408s | `focused-final-source.log` |
| combined | 192/192 PASS; exit 0; 4.071s | `combined-final-source.log` |
| summary | 528/528 PASS; exit 0; 22.668s | `summary-final-source.log` |
| pointsto | 270/270 PASS; exit 0; 9.143s | `pointsto-final-source.log` |
| alias | 95/95 PASS; exit 0; 5.094s | `alias-final-source.log` |
| lifetime | 9/9 PASS; exit 0; 0.629s | `lifetime-final-source.log` |
| scpa | 25/25 PASS; exit 0; 15.159s | `scpa-final-source.log` |
| lint | PASS; exit 0; 1.367s | `lint-final-source.log` |
| module-boundaries | PASS; exit 0; 0.246s | `module-boundaries-final-source.log` |
| ownership | PASS; exit 0; 0.158s | `ownership-final-source.log` |
| phase7 | 2187 PASS / 1 FAIL（baseline-red）; exit 1; 98.441s | `phase7-final-source.log` |

## baseline-red / ownership外への引継ぎ

broad Phase7唯一の失敗は `tests/phase7/ownership/c1-01-inventory.test.mjs:94`、
`the actual HEX-C1-01 branch inventory stays inside its exact allowlist`。
最初のdeterministic divergenceはhistorical inventory用
`git diff 852fcc559711eac680f6853644d390fdb5c1b7f8 66664d4b5ec29ad503c785e50f3d2ff78df1dbe3` が
`fatal: bad object 852fcc559711eac680f6853644d390fdb5c1b7f8`、exit128で失敗すること。
**無変更の開始base worktreeと候補の両方で同一testが2PASS/1FAIL**。新規解析regressionではなくZIPにGit履歴がないことによるbaseline-red。
`baseline-ownership-history.log` / `candidate-ownership-history.log` に比較証拠を保存。
full Phase7をPASSとは記載しない。missing歴史objectを捏造したり、環境変数で空diffへ差し替えたり、gateを弱めたりしない。

integration ownerに必要な入力: 上記2つの実Git commit/treeが取得可能な履歴。
期待結果: historical C1-01 inventoryをそのまま再検証できること。現在のC1-02 9-path auditとは別の検査である。
ownership外である理由: historical runner/manifest/Git環境をこのlaneは変更しないというtask指定。

native全再帰binary/全indirect target探索、root/allocation leafの実heap/layout由来証明、free/reuse/TLSのruntime identity、
generated userscript再build、CI/release、独立verifier、実機受入はこの有限証拠から推論しない。
入力/期待: canonical native CALL/return/targetとheap/layout根拠を各ownerが提供し、同じsummary入口へ接続して再検証する。
現在のproof boundaryは上のnative leafと宣言leafであり、これを架空の全program failureやPASSには置き換えない。
対象ownerはABI/semantic/MemorySSA/alias/runner/integrationで、本laneの許可path外。C3-01/C3-02の再実装はしていない。

## changed-file inventory / review

今回のrepo差分は次の**9 pathのみ**。このMD以外のsource/testは上記final source/test SHAで固定した。

```text
js/analysis/summary/contract-core.js
js/analysis/summary/contract.js
js/analysis/summary/interprocedural.js
js/analysis/summary/local-core.js
js/analysis/summary/local.js
js/analysis/summary/return-equations.js
tests/phase7/summary/c1-02-recursive-return-discovery.test.mjs
tests/phase7/summary/issue-5242-contract-version-source-of-truth.test.mjs
docs/analysis-c1-acceptance.md
```

最終配布物にはbase→配布HEADのactual diffと9-path hash inventory、実行receipt、
`reviews.json` / `reviews.md` の3連続full review記録を含める。各回で18項目すべて
（soundness、SCC、local/discovery分離、候補完全性、unknown/矛盾、停止/予算、version、digest、stale、順序、
producer→consumer配線、正例、最小反例、回帰、scope、重複実装、既存成果再利用、docsの実測一致）を再確認する。
有効な指摘が出た時点で連続ゼロをリセットし、修正・関連gate再実行後にやり直した。
レビューは同一assistantによるfresh full self-reviewであり、独立sub-agent/CodeRabbitレビューを実施したとは記載しない。
局所回帰のfalseNoAlias/falseMustAlias/semantic mismatch/根拠なしunknown→exact/stale publicationは0。
これは上記有限corpusのassertion結果であって、全programに対する数学的証明ではない。
