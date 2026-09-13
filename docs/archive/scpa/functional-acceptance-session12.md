# SCPA functional acceptance — session12

取得基準: `c90d8b38833ae664defb512be58538e397967f72`。これは機能・失敗条件の検証記録であり、ファイル数や合成テストの件数から完成率を計算するものではない。

**目標90%の受入判定は NOT ADMITTED。** 従来の85%は固定30単位の部分実装概算であり、この機能受入基準の85%へ換算できない。今回もP0–P5の完了、実機適合、競合勝利、既定有効化を認定していない。合格した限定経路と未検証の製品条件は下記のとおり。

## 1. 実データを通した公開解析経路

`tests/scpa/threaded-native-acceptance.test.mjs` は、テスト所有のアセンブリをリンクしたELF、配布済みCapstone WASM、実Node Workerスレッド上の`js/platform/worker.js`、正規のSemantic IR/範囲解析、ArtifactStore、アプリ用adapter、公開`AnalysisQueryAPI`を通す。ネイティブ解析ownerや独立チェッカーをテスト用の成功値に置き換えない。入力ソース・ELFのSHA-256と再生成手順は`tests/scpa/fixtures/threaded-integer.json`に記録し、毎回照合する。

| 機能 | 確認した結果 | 受入の限界 |
|---|---|---|
| 入力→整数候補→証拠→現在の機械語の独立照合 | `mov`/`add`から8192を得て、証拠整合性・byte bindingを検査。限定した1導出を再検証できる。 | 結果全体はUNKNOWN、`exact:false`。全命令・経路到達性の証明ではない。 |
| 公開APIからのportable export→再照合 | structuredClone可能なデータだけを返す。現在のownerとbytesに再結合して再検証する。 | detached capsuleの真正性やプログラム全体の正しさを証明しない。 |
| 解析文字列と機械語の不一致 | 改変された即値から生じた誤結論を独立チェッカーが拒否し、発行済みartifactを隔離する。 | この一つの命令系列の拒否確認を、全ISAの適合率に換算しない。 |
| シンボル更新・binary世代変更 | 古いartifactの再検証を成功扱いせず、古いsnapshotからのqueryを拒否する。 | ブラウザーIndexedDBの競合・実機上の全再読込み経路は別途必要。 |
| 開始前・実スレッドへdispatch後の取消 | 開始前は解析を増やさず、dispatch後の取消も遅延成功を返さない。新しいqueryでは回復する。 | 実ブラウザー/実機の遅延、外部プロセス停止の証拠ではない。 |

この経路で、本番producerが発行する`arm64:effects@7`を、独立チェッカーが三要素形式の版番号に限定して拒否していた不一致を修正した。型付きの共通profile判定を使い、配列から文字列への暗黙変換も拒否する。checker versionは`1.0.1`、算術rule versionは変更していない。公開QueryAPIのclone境界は緩めていない。

**Node Workerの検証はブラウザーWorker/WebKit/iPadの代用ではない。** このELFも、多言語・複数toolchain・正解付きcompiler-twinコーパスの完成を意味しない。

## 2. 評価実行の保存・再開

既存`runAstraTrials`と明示実行型CLIへ再開経路を追加した。別の評価エンジン、採点系、証明権限は追加していない。利用手順と制限は`tools/competitive-arm64/TRIALS.md`を参照。

完了したprefixは再実行せず、未実行tail、失敗、利用不能のセルも保持する。別計画・入力・host moduleの記録、順序・分母・参照・版・権限フラグの不整合を実行前に拒否する。バッチをまたぐキャッシュnamespaceの再利用を検出し、T2共通知識が後から不一致になったときは先行バッチの候補測定も撤回する。

負荷試験の**2,304セルは合成計画**（2合成ケース×48反復×3テストadapter×4モード×cold/warm）である。256セル×9バッチでJSON保存・再開し、全セルを重複なく消費した。最終compact payloadは2,954,091 bytesだった。この試験と、Post-B manifestに残る実競合2,304セルは**別の分母**であり、実競合の測定は0件のまま。件数が同じことをもって実験完了とはしない。

従来の8 MiB制限は維持する。planの固定記述子を再保存しない形式へ変え、復元後のサイズにも制限を掛ける。上限を超える記録は拒否し、測定や失敗行を削って通さない。全4096セル・任意の候補測定量の保存を保証するものではない。

失敗したセルの自動再試行、プロセス異常終了時のexactly-once外部実行、記録の認証は提供しない。進捗digestはtransport integrityで、独立受入ではない。hostのroot moduleのSHA-256は検査するが、推移的import・外部依存・OS・実機全体の再現性を保証しない。

## 3. 回帰と未完了条件

SCPA全ケースは1,163/1,163 PASS、fail/cancel/skip/todoは0。関連するPhase8のscalar・memory・foundation・integration、substrateの個別検査、runtime、migration、module boundaries、evidence writersも通過した。SCCP/GVN/verticalのテストは正規のPass transactionへ移し、廃止済み`state.__write`を復活させていない。DCEの全135コーパスを含む検査も分母を減らさず通過した。

`npm run check`は構文と先行検査を通過した後、architecture-boundariesで`esbuild`不足により停止した。`npm run userscript:build`も同じ依存不足で未完了。固定版依存の取得はDNS失敗。広域Phase8の一括実行はtool timeoutで未完了であり、関連groupを通したことを全suite greenとは呼ばない。

ブラウザー試験は`ERR_BLOCKED_BY_ADMINISTRATOR`。環境のURL禁止ポリシーを変更・回避していない。実WebKit/iPadのメモリ・応答時間・取消、実runtime capture、完全なISA/ABI/relaxed-memoryの独立oracle、多言語compiler twins、同一Astraによる競合評価、実人間の読解試験は未受入。

再現用の主なコマンド:

```sh
npm run scpa:test
node --test tests/scpa/threaded-native-acceptance.test.mjs
node --test tests/scpa/trial-continuation.test.mjs tests/scpa/trial-cli.test.mjs
node tests/phase8/run.mjs --group scalar
node tests/phase8/run.mjs --group memory
npm run module-boundaries:test
npm run evidence-writers:test
npm run runtime:test
# 下の2つは、固定された必要依存を持つ許可済み環境で再検証が必要。
node scripts/run-quiet-command.mjs --label check -- npm run check
npm run userscript:build
```

各検査は有限の外側timeoutを付けて実行する。テスト件数は回帰の実行結果であり、機能完成率や本番受入率ではない。
