# SCPA functional acceptance — session13

基準main: `de6178154884813d90c6437146a99b1155f0c68d`。目標: 情報源architecture MDの100%とPR作成。**100%は NOT ADMITTED。機能完成率は未認定。** Session12の履歴は `archive/scpa/functional-acceptance-session12.md`、更新した設計・未達条件は `HEX_ARM64_POST_ROADMAP_COMPETITIVE_SUPREMACY_ARCHITECTURE.md` 第43章を参照。

## 1. 今回の実装

Session12累積198パスは、変更前hashが最新mainと全件一致したため、mainの無関係な変更を保持して移植した。Git treeと署名付きcommit objectもGitHubから取得したidentityに完全一致した。古いソース一式によるmainの上書きは行っていない。

評価runnerを2点修正した。

- hostの空・空白・改行・制御文字・過大なエラー文字列、非Error拒否で、runner自身が出力したチェックポイントを再開できなくなる問題を修正。512文字以下の診断コードだけを保持し、不適合は固定の `astra-trial-host-failed` にする。
- cancel/closeが `null` / `undefined` / `false` / `0` / 空文字でrejectすると清掃失敗を見落としていた問題を修正。失敗の有無を拒否値と独立に保持し、該当セルをFAILEDへ落として測定候補を撤回する。

回帰22件でpack→validate→resume、失敗セルの非再実行、残セル・分母の保持を確認した。最大8 MiBの記録上限は変更していない。4,096セルの任意の計画・測定量の保存完走は保証しない。

## 2. 実ELF・本番解析owner・公開API

新しい `tests/scpa/threaded-call-memory.test.mjs` は、LLVM 20.1.2のAArch64 assemblerが生成した3関数16命令を、明示的な最小ELF containerへ格納したfixtureを用いる。実Capstone WASM、実Node Worker、Semantic IR、MemorySSA、summary、ArtifactStore、アプリ用adapter、公開AnalysisQueryAPIを通す。

追加5件は、直接callとx0のABI flow、実load/storeの証拠と現在bytesの再照合、異なる関数への証拠再利用拒否、summaryの単回cursor・再開・残入力破棄、transport epoch変更後の継続拒否を検査する。既存5件と合わせて10/10 PASS。fixtureの再生成は二度一致し、SHA-256は `4c76a22d4443d553eb907d9703692256839e5a41ff7dcb77b8ac4cc71dff8e9f`。

**実CPU上での実行、compiler-twin、全ISA/ABI、ブラウザー、実機iPadの証明ではない。** unknown-call fallback、広いmemory region、未知の例外を保持し、結果の `exact:false` / closure UNKNOWN / `releaseQualified:false` は維持する。メモリのsource replayは機械意味論の合成証明ではない。

## 3. 今回の検証結果

| command / scope | result |
|---|---|
| 再帰discovery全53ファイルのSCPA | 1,190/1,190 PASS、fail/cancel/skip/todo 0 |
| trial関連focused | 83/83 PASS（追加回帰22件を含む） |
| 実threaded ELF関連 | 10/10 PASS（追加5件を含む） |
| `npm run lint` | PASS |
| `npm run userscript:build` | PASS。再build後のtracked生成物差分0 |
| module boundaries / evidence writers / runtime / migration | 全てPASS |
| Phase8 scalar / memory / integration | 全てPASS。memoryのDCEコーパスも削減なし |
| `npm run scpa:manifest` | source/分母検査PASS。実競合2,304セルはUNMEASURED |
| `npm run check` | FAIL。machine-effects-contractの19ファイルで停止。後続suiteを全PASSとは扱わない |
| browser launch preflight | Chromium executable不足。ブラウザーテストは未実行 |
| CodeRabbit | 導入時のproxy timeoutにより未実行。独立ローカルレビューを実施 |

Nodeは `v24.19.0`。buildはpackage-lockのintegrityと一致したesbuild **0.28.2**を使用した。添付0.25.9を指定版の代用品として合格認定していない。buildはlocal sourceの生成検証であり、runtimeのdeployment/activationはしていない。

全体checkの19件を、変更後と未変更mainの両方で実際に再実行した（各30秒上限、計38プロセス）。19/19でexit code・最初のassertion・位置・失敗subtestが一致。この19件に今回の差分による新規failureは検出されなかった。内訳はLLVM MC/Clang不足8、歴史Git object不足3、同環境のmainでも起きるx86/RISC-V assertion不整合8。ZIP由来のmainにも同じ読み取りGit metadataを指定して条件を揃えた。これは全体checkをPASSへ変更する根拠ではない。

要約と機械可読のfirst-failure比較: `reports/scpa/session13-functional-acceptance.json`、`reports/scpa/session13-baseline-failures.json`。ローカルの全ログをPRへ転載せず、必要な失敗情報のみ保持する。

## 4. 未完了と再開条件

P0–P5の完了、Baseline Bの全面受入、M3既定有効化、M5競合勝利は未認定。主要な実装不足は、native dispatch/import closure、balanced return/exception/memory flow、negative-query証明、Apple metadata自動抽出、memory/exception変換の合成証明。外部証拠として多言語×要求toolchainのcompiler twins、独立ISA/ABI/relaxed-memory oracle、実provider capture、物理iPad/WebKitの性能・取消、正規competitorの同一Astra T1–T3とT0 model-free、統計・人間評価が必要。

実競合2,304セルと合成の保存再開2,304セルは別分母。欠測やUNKNOWNを達成済みに変換しない。PRはレビュー用であり、merge/default rollout/100%の承認を意味しない。

再検証の主要コマンド（各コマンドに有限timeoutを付与）:

```sh
timeout 180s npm run scpa:test
timeout 120s npm run userscript:build
timeout 600s node scripts/run-quiet-command.mjs --label check -- npm run check
timeout 180s node tests/phase8/run.mjs --group scalar
timeout 180s node tests/phase8/run.mjs --group memory
timeout 180s node tests/phase8/run.mjs --group integration
```

全体checkの前に、要求されるLLVM MC/Clang・歴史Git objectを利用できる正規環境を用意する。ブラウザー検証は必要な固定版ブラウザーを備えた環境で行い、ChromiumでWebKit/iPadを代用しない。
