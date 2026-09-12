# SCPA functional acceptance — session14 / session15 integration

基準mainを `e60c6a591664447e858a64c80f9ddf5999d0ac68` まで取り込み、既存Draft PR #8247を更新する。**100%の受入は未認定。** 元のMDのMUST・分母・外部検証条件を維持する。設計の最新実装対応は `HEX_ARM64_POST_ROADMAP_COMPETITIVE_SUPREMACY_ARCHITECTURE.md` 第44章、全20ユニットの対応は `reports/scpa/session14-requirements.json`。前回記録は `archive/scpa/functional-acceptance-session13.md`。

## 今回の変更

- 既存PR #8086のSwift witness header offset修正をそのまま再利用。#7036からcanonical ABIのentry/call/return binderだけを移植・適合し、#7097と重なるmemory/taint/solver/summaryエンジンを追加コピーしていない。
- 実binaryのjump table・relative table・import site・thunk候補を、既存range ownerと現在のsource mappingへ接続。
- canonical ABIとMemorySSA portsをcallsite対応付きの有限flow queryへ接続。混合依存経路、resume、owner欠損・世代更新時のopen判定を維持。
- proof DAGの依存順replay、typed range合成、同一source点にある1-byte整数アドレスcellの限定alias証明を追加。aliasはpointer validity・実storage・より広いmemory accessの証明ではない。
- object lifetime/partition、summary/adaptive contextの依存identity、実24-byte counted-loop fragmentとportable capsuleを接続。
- event sequence・geometry・reaching definition・effectsを保持するmemory transformのbyte値/fault-prefix合成検証を追加。一般のload/store除去は既存ownerの領域。
- 実ObjC/Swift parserのselector・IMP・witness・vtable・generic/capture descriptorを公開APIへ接続。
- 開いている実TraceProviderの保持eventsを、明示されたasync契約・ObjC capture・Swift continuationのmodelへ接続。SHA・module・epoch・membershipを照合し、queryによるsession作成や実行は行わない。
- indexed addressの誤exact化、mappingの部分重複/更新、Appleの関数上限不一致、boolean receipt resolver、trace SHA矛盾を修正し、回帰テストを追加。

## 既存PR・mainとの整合

`reports/scpa/session14-existing-pr-reuse.json` に再利用元のhead・範囲・適合理由を記録した。関連open PRの実差分を監査しており、全PR網羅を主張しない。

初回にmainの46 commits / 39 pathsを取り込んだ。非package 38パスはremote blobと完全一致。packageはJSONの3-way mergeで既存SCPA scriptsとmainの追加回帰を保持した。取り込みmainの署名付きcommit SHAとtree `13327e52ffd36579eb74e5f0fd55e2cbaa777d06` を再構成・照合した。履歴のmerge-baseは旧main `de6178154884813d90c6437146a99b1155f0c68d` と一致。公開確認中の追加22 commits /15 pathsも取り込み、最新mainのtree `64399b151ed4919cdf58189839f98f52e76ce448` とblobを照合してpackageの競合を解消した。続く最新mainの6 commits /7 pathsも統合・照合し、3回帰を検証した。詳細は `reports/scpa/session14-main-reconciliation.json`。

## 検証

| scope | result |
|---|---|
| canonical `npm run scpa:test`、再帰discovery全70ファイル | **1,403/1,403 PASS**、fail/cancel/skip/todo 0 |
| 既存PR #8086から再利用した回帰 | 3/3ファイル PASS |
| 取り込みmainの追加回帰 | 初回15/15＋追加7/7＋最終3/3ファイル PASS |
| lint / module boundaries / evidence writers | PASS |
| runtime / metadata / migration | PASS |
| Phase8 scalar / memory / integration | 全てPASS、既存コーパスの削減なし |
| canonical userscript build・再build | PASS、再生成差分0 |
| `scpa:manifest` | 分母・source検査PASS。実競合2,304セルはUNMEASURED |
| `invariants:test` | machine-effects-contract到達後、90秒上限で未完了。PASS扱いしない |
| 全体 `npm run check` | 今回は再実行せず。前回main一致の19件はユーザー指示で保留 |

Node `v24.19.0`、package-lock指定のesbuild **0.28.2**で生成した。添付0.25.9へ置き換えていない。release serialは `2322242192 → 2322242195`、build IDは `dd7bafbeb4c0280da04fd1e4`。runtimeのdeployment/activationは未実施。

各検証のcommand・有限timeout・開始時刻・exit code・ログSHAとソースinventoryは `reports/scpa/session14-functional-acceptance.json`。独立ローカルレビューを実施した。CodeRabbitは前回proxy timeoutで利用できず、今回も実行済みとは扱わない。

前回の19件は、当時の変更後と未変更mainで各19本を実行し、first failureが一致した記録を保持する（LLVM MC/Clang不足8、歴史Git object不足3、x86/RISC-V assertion8）。今回の90秒timeoutを、その19件が再度一致した証拠に読み替えない。記録は `reports/scpa/session13-baseline-failures.json`。

## 未完了の条件

要求された限定ローカルproducer/consumerは監査・接続したが、**U20の実際のIDA/Ghidra native-best adapter実装は、正規の固定版SDK/実行環境への接続が残る**。generic runnerだけで実adapter完成とは扱わない。

複数toolchainのcompiler twins、独立ISA/ABI/relaxed-memory oracle、Apple runtime captureの妥当性、物理iPad/WebKitのcold/warm/cancel/memory、同一Astra T1–T3とT0、実competitor測定、統計・blind human studyは未受入。Node Worker・assembler ELF・保持trace fixtureはこれらの代替証拠ではない。

未対応のexception、unknown call、dynamic loading、PAC、Swift packs/resilience、runtime substitutions、generic capture object layoutはUNKNOWNとして保持する。既存Baseline B PRが所有する一般memory/taint/solver実装を、この限定adapterの完了へ換算しない。P0–P5、M3既定有効化、M5競合勝利の受入は未認定。

再検証には有限timeoutを付けて `npm run scpa:test`、`npm run userscript:build`、必要なowner gateを実行する。全体checkを再開する際は、固定版compilerと必要なGit履歴を備えた環境でmain比較を行う。


## Session15 — 既存PRの統合と19件の追跡（2026-09-12）

ユーザーのmain反映指示に従い、#8247を正規のsource統合候補として継続する。今回の基準mainは `c5ae8f993f5585ae19e61cddc1fc9f59a0173183`。ここでのsource統合は、前節の外部受入条件や100%達成の宣言ではない。

- #8086 `d864be09fd53405b3a89b04d5e0cc43bd0e7e5fa` の全11ファイルを照合し、既採用Swift部分に残りのUTF-8検証・文字列切り詰め情報・semantic-function入力検証を統合した。両scannerが最初の切り捨て後にASCIIだけを再追加する不具合も修復し、2/3/4-byte文字境界と次のrunへのリセットを検証した。
- mainの追加16 commits /12 pathsと54 commits /30 pathsを取り込んだ。非packageファイルのblobとmain treeを照合し、packageは双方のscript変更を保持した。新たなGhidra trigger回帰が検出したSCPAの2依存を、workflowの実行対象へ追加した。
- SCPAの正確な変更ファイルと所有者を宣言し、全体inventoryを確認してから既存Phase7/8 validatorへ各対象を渡す。既存の禁止条件・負例検証・最新HEAD承認は維持する。renameの元パスもinventoryへ含め、未登録ファイルの移動を検出する回帰を追加した。
- 19件の対応表を [Issue #8299](https://github.com/rhgrive3/hex-ida/issues/8299) に公開した。11件はLLVM/Git履歴の環境前提として新規追跡。残る8件は既存#7036の作業範囲で、重複実装しない。
- #7036全体は保留。現在headのchanged closure試験は137 partialの記録があり、MOVZX/MOVSX幅契約・native binding性能回帰・生成toolchain整合も未完了。ここでは既採用ABI sliceのみ保持する。

最終main取り込み後のSCPA全70ファイルは **1,403/1,403 PASS**。#8086変更6ファイル、関連consumer7ファイル、metadata、取り込みmain回帰、lint、module boundaries、evidence writersを確認した。最初のSCPA実行は60秒上限で未完了だったため、canonical runnerの180秒上限に合わせて再実行し65.942秒で完了した。main回帰のGhidra trigger 2ファイルは修復前FAIL、修復後PASSであり、既知main失敗とは扱わない。

Node v24.19.0 / lock指定esbuild0.28.2でcanonical build・再buildを実行し、生成差分0。release serial2322242197。詳細な検証記録・統合source identityは `reports/scpa/session15-integration.json`。GitHubの最新HEADとBASEに対する正規admission、および実際のmain到達は別途readbackで確認する。

公開前clean commitでの再実行では、2304セルの保存・復元試験にFAILED行が2つ発生した。旧assertionは理由を記録していなかったためCPU競合は推定に留める。このsynthetic試験のみ継承した100ms/25msの短いfixture期限を既存の有限production既定値へ合わせ、全2304セル・9batch・assertion・20秒総上限を維持した。独立したtimeout試験は変更せず、失敗先頭8行の診断を追加した。詳細と最終再検証はsession15記録と公開PR本文を参照。
