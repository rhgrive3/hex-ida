# ローカル解析引き継ぎ・検証記録 — 2026-09-13

## 結論と範囲

依頼は、添付ZIPを唯一の開始入力としてdocsの引き継ぎを実装し、検証と文書更新を
ローカルで完結してZIPで返すこと。今回、3つのruntime領域を修正し、検査・監査資料を作成した。
**ただし元の全23 finding / 21 FRの実装・受入は完了していない。**
全体は `CHECKPOINT-LOCKED` / `transformAuthorization:false` のまま。
正の要求を否定テストの成功に置き換えず、欠けた独立/実機/生成物の証拠を補ったことにしない。

同梱 `source/` は入力の全ソースと今回の差分を含む。`.git`、依存キャッシュ、node_modules は含まない。
既存生成userscriptは入力版を保持し、今回のruntimeを内包する再生成物としては扱わない。

## 入力identityと工程

入力: `hex-ida-feat-analysis-roadmap-v8-current-main-20260907 (3).zip`。
SHA-256: `adb2d73eeb0695f380824fad1028ad77eed07fffa04bccdac16caff9edb0a9fa`。
ZIPは4684ファイル。input-manifestは各byteのhashを記録している。
初期Git import commit `5729136d80c8f478c4d22621eed9d6850083dafe` は今回作成したローカル記録であり、
remoteのmain/PRのSHAではない。Git履歴は入力にない。

remote fetch/push/PR/merge/activationは実施していない。
作業は `/mnt/data/hex-ida-local`、不変な開始比較は `/mnt/data/work/`、証拠は
`/mnt/data/local-completion-evidence`。旧文書の `/mnt/workspace/` はこの環境では使っていない。
依存導入 `npm ci --ignore-scripts --no-audit --no-fund` を開始比較側で一度試行したがnpm内部エラーで失敗した。
したがって「ネットワーク要求を一切試行していない」という主張はしない。
追加依存、別solver、別parserを成功偽装のために挿入していない。

実行環境は Node22.16.0、npm10.9.2、Linux x86_64、clang17.0.0。
指定されたLLVM readobj18.1.3、esbuild、Playwrightの利用可能な依存は揃っていない。
環境情報・導入失敗・oracle判定は `evidence/` に保存する。

## 実装の詳細

### 1. Generic terminal-PC observable

`js/symbolic/query/memory-equivalence.js` が、completeなnormal-return generic IRについて
terminal PCをABI返り値およびbyte memoryと別々に比較する。
PCだけが違う反例を `firstDivergence.kind=return-target` として返す。
両側の全終端にPCが必要。一方だけ省略したPCをwildcardにしない。
PC式をinput correspondence、モデル再評価、予算、stale/mutation検査へ含める。

PC scopeはversion3。従来のPCなしscope1/2は維持する。
未モデル化fault、native state/call/clobber、未証明のnormal completionは保留する。
既存private execution receipt、solver/backend、モデル検査を再利用し、native全効果証明を新設しない。

新しい9検査は等値/不等値、PCだけのsymbol、欠落target、stale/mutation、モデル破損、
cancel/budget、native拒否、旧byte契約を覆う。既存1検査をunknownから具体的refutedに強めた。

### 2. Canonical add-with-carryのnumeric/C/V def-use

既存compatがCMP/CMNの数値結果を表示用CMPへ置換すると、N/Zなどの数値consumerの定義が失われる。
primary数値結果のBINを残し、表示carrierを別entityとして保持する。
C/Vはcanonical addendとsumから既存BV操作へ展開し、それぞれ自分のBFX定義を持つ。

```text
C = msb((a & b) | ((a | b) & ~sum))
V = msb(~(a ^ b) & (a ^ sum))
```

数式は新たなISA判定ではなく、既に正規化されたpure intrinsicの投影。
metadataの入出力整合、deterministic、state/control/memory effectsなし、型とcarry条件を確認する。
動的carryのADCS/SBCSは元のCLOBBERを維持し、不正/副作用ありのintrinsicは純粋演算へ昇格させない。
未使用C/Vはsource identityを保持して明示的undefとし、不要な計算で既存予算を消費しない。

32/64-bit CMP/CMNを各81組、計324組で独立BigIntのfull sum・signed boundsと照合した。
追加10検査と既存2検査、計12件を通過した。中間の未使用出力処理は既存回帰を壊したため修正し、
修正後に171件のmemory検査を再実行した。古い中間失敗/成功は最終根拠から区別する。
compat version1.3.0、pipeline version1.7.0。flags state全体の証明は未実装のまま。

### 3. ObjC公開入口とX-02有限検査

既存class/category/protocol parserへ公開セクションを正しく渡す。
category/protocolを落としてcompleteと報告する反例、型address欠落、cacheの旧世代上書きを修正。
category dispatch候補の曖昧性、protocol requirementとIMPの区別、不完全metadataを維持する。
ObjC provider version1.1.0。詳細は [X-02受入](analysis-x02-acceptance.md)。

49入力、59機能検査、2manifest整合検査。hash、種類、architecture、生成条件を記録する。
合成layoutを実OS/compiler/runtime証拠としない。PAC情報保持を認証成功としない。
署名markerによる書換え拒否を有効署名/再署名/OS実行としない。

別remote `684f1f0bb9c4809cd9bbaba01f01a4849151cc0b` の120行成果は未取得・未統合。
この有限59行でその分母を置き換えない。元12要求カテゴリの正の完全受入はすべて未完了。

## 検証結果

<!-- LOCAL-RESULTS-START -->
| 実行 | 終了コード | 実測/境界 |
|---|---:|---|
| `focused-carry` | 0 | 12/12 PASS（新規10+既存2） |
| `focused-x02` | 0 | 61/61 PASS、49入力hash再現 |
| `focused-memory` | 0 | 171/171 PASS |
| `focused-structuring` | 0 | 130/130 PASS |
| `metadata-test` | 0 | canonical全コマンド exit 0 |
| `scpa-test` | 0 | canonical全コマンド exit 0 |
| `phase9-test` | 1 | release-evidence: Playwright不足。全体FAILを維持 |
| `phase7-test` | 1 | canonical exit 1。子reporterの十分な詳細が出ず、このログだけで単一原因に断定しない |
| `semantic-v2-test` | 1 | SSA #4534、C2 byte forwarding、corpus、required regressions、userscript syncの5失敗laneは開始時にも存在 |
| `phase11-test` | 1 | DEX field/code-item、旧category fixture、module identity等の開始時失敗を含む |
| `phase12-test` | 1 | 158 passed / 5 failed（runner集計単位）。独立rebuild/fixture gate等 |
| `effects-test` | 1 | 19 failed files。denominator契約と多数のPlaywright依存失敗 |
| `check` | 1 | lint/syntax後、architecture boundaryでesbuild不足 |
| `full-test` | 1 | AI sessions brokerの削除同期assertionで停止。後続の&&段は未実行 |
| `userscript-build` | 1 | esbuild不足。生成物なし |
| `userscript-build-repeat` | 1 | 同じ不足で再失敗。二回build成功・同期証拠ではない |

追加のC1/C3既存受入は **415/415 PASS**。元引き継ぎの表示/公開projection組は変更前後とも **93 PASS / 3 FAIL**（96件）。
検査中のruntime/test全11ファイルは `verification-source-freeze.json` と最終byte一致。
文書集計とローカルcommitは検査後に確定した。remote exact-head CI/merge-tree/device gateの通過は主張しない。
<!-- LOCAL-RESULTS-END -->

重点の完全TAPは `evidence/logs/transcript-focused-*.log`。
C1/C3再利用415件は `evidence/logs/reused-c1-c3.log`。
引き継ぎの表示不良は `handover-c4.log` / `baseline-handover-c4.log`。
両者96件中93 PASS / 同じ3 FAIL。旧historyにあった公開projectionのpartialはこの組合せでは
失敗として再現しなかったが、120msの製品受入を解消したとは扱わない。

quiet wrapperは成功した内部一時ログを削除する既存仕様。
canonical成功はwrapperのPASS/exit receiptを保持し、重点検査はverbose transcriptも別に保存した。
失敗したwrapperのfull.logは保持するが、子runnerがbounded診断しか出さない場合、
その先の存在しない全個別ログを「保存済み」と主張しない。

開始時にPhase8全体は900秒で打ち切り、exit124。
子プロセス残留を検出して該当process treeだけ停止した記録も保存した。
今回の最終runtimeではconditional-region130件を再実行したが、全Phase8の成功証拠ではない。
full-testが途中停止した後の未実行段を合格にしない。

## 自己レビュー

3観点（契約/権限、実配線/identity、検証/配布）で変更を見直した。
最小反例と正常/異常/境界/並行/取消し/予算を検査した。
C/Vの未使用計算による予算回帰、fixtureのresolver/minimum-version誤り、ObjC型addressの欠落を
実行中に発見して修正した。既存失敗を消すためのdeadline許容、分母削除、version gate緩和はしていない。
独立 reviewer・Codex/CodeRabbit・サブエージェントは使用していないため独立レビュー合格ではない。

## 残る受入と再開

| 残件 | 現在の観測 | 再開入口 |
|---|---|---|
| C4逆引き | precomputed rendering / store-return consumer / elided operator navigationの3失敗が開始時と同じ | `tests/phase8/provenance/compat-constant-history.test.mjs`, `consumer-binding.test.mjs` |
| C4性能 | 標準120msでの全製品受入は未確認。過去の単発PASSを修正証明にしない | `js/core/identity/live-data.js`, `tests/phase8/substrate/proof-projection-origin.test.mjs` |
| C4式族/順序 | canonical Phase9全体は未合格。deadlineを許容結果へ追加しない | `tests/phase9/egraph/family-width-matrix.test.mjs`, `rule-order.test.mjs` |
| C4全領域 | flags/NZCV、PHI/CFG消去、memory/exception/loop、recovery/削除由来の正の受入が不足 | `tests/phase8/structuring`, symbolic query/compatの既存owner |
| ME | 保存資料の独立定義、hardware/PAC/relaxed-memory証拠と全gateが不足 | `specs/003-oracle-mask-matrix` |
| X-02 | direct cache/slide、実version/auth/signing、既存remote成果、指定oracleが不足 | X-02 JSONの12要求行、別remote artifact identity |
| 環境/生成物 | npm依存導入失敗、esbuild/Playwright/LLVM18.1.3不足、bundle未生成 | 下記canonicalコマンド。依存修復後も全再検証が必要 |

```sh
# ZIP展開後、source/で実行。依存が利用可能であることが前提。
node --test tests/phase9/memory/terminal-control-equivalence.test.mjs
node --test tests/semantic-v2/repair-v1-add-with-carry-def-use.test.mjs
node --test tests/scpa/x02-apple-version-matrix.test.mjs
node scripts/run-quiet-command.mjs --label check -- npm run check
node scripts/run-quiet-command.mjs --label test -- npm test
node scripts/run-quiet-command.mjs --label phase8 -- npm run phase8:test
node scripts/run-quiet-command.mjs --label build-1 -- npm run userscript:build
node scripts/run-quiet-command.mjs --label build-2 -- npm run userscript:build
```

最終採用には、元全23/21要求の証拠、依存ゲート、再現できる生成物同期、必要な独立/実機受入が必要。
このZIPは安全に継続できる局所実装と監査記録であり、release/merge/activation許可ではない。
