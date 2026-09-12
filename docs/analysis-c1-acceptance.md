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
