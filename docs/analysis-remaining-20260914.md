# 解析改善・分担後の再開記録

状態: **IN PROGRESS**。全体完了・マージ・実機受入は未認定。

- ユーザー担当: C4全領域、PHI/CFG、flags/NZCV、fault/exception/unwind。
- この作業の担当: 上記以外の解析改善。既存実装の受入、C0/ME/C1/C2/C3/SYM/X/S2の残件。
- 基準: PR #7036、`d792b212ed85f1d01734cb190caf441ab23f091d`。
- 正本: `docs/解析ツール改善.md` と `docs/analysis-local-acceptance-audit.json`。
  mainにある歴史的finding ledgerだけで現況を判定しない。
- 保存ブランチ: `codex/analysis-remaining-20260914`。小さくcommit/pushし、force-pushしない。
- 作業先: `/mnt/workspace/.dev-state/agent-work/checkouts/analysis-remaining-20260914/integration`。
- 証拠/再開: 同じ永続rootの `evidence/analysis-remaining-20260914/` と
  `checkpoints/analysis-remaining-20260914/`。

## 担当境界

既存PRにはユーザー担当の実装も存在する。基準に含まれるその実装を維持し、
この作業の差分ではC4/PHI/CFG/flags/faultの意味論を編集しない。
ユーザー担当の不合格は全体ゲートから消さず、引き継ぐ。
生成物はcanonical builderでのみ再生成し、二回目一致を確認する。
main統合は既存PRの統合責任と競合させず、まずこの分担の差分と証拠を保存する。

## 現在の調査

1. 主要なC1/C2/C3/SYM/X実装は既存PRにある。再実装せず現候補で検証する。
2. 旧環境でLLVM18.1.3、Playwright、ネットワークinterface検査が阻害されていた。
   この環境はNode24.20.0 / Ubuntu22.04 / LLVM14。指定LLVMの代用とはしない。
   永続Playwright cacheにChromium headless shellがある。実起動はまだ未検証。
3. 物理Apple arm64e/iPad、hardware ordering oracle、署名・active runtimeの証拠は未取得。
4. 23 finding / 21 FRと全分母を保持する。局所テスト成功で全体完了へ昇格しない。

## 次の実行

- 依存を永続workspaceから解決し、既存canonical gateをquiet wrapperで実行する。
- 最初の失敗を環境/非C4製品/ユーザー担当へ分類する。
- 非C4の失敗を最小反例とともに修復し、重点→canonicalの順に再検証する。
- 各区切りでこの記録にcommit・コマンド・結果・残件を追記してpushする。
- exact-head CI、独立レビュー、candidate merge-tree、実機・release証拠が必要な箇所は
  古い合格や疑似fixtureで置き換えない。

再開前に `git status` とリモートheadを照合し、このブランチの未push変更を保存する。
全コマンドに永続 `TMPDIR/TMP/TEMP` を設定する。OS一時領域は使用しない。

## Checkpoint 1: 解析入口の依存欠落

- `2f8d57bd2` をリモートへ保存済み。
- 開始時のC1/C2/C3受入は245件中241成功/4失敗。3ファイルは
  `blocks-base.js` が存在しない `arm64ReadsDestination` をimportして読込不能。
  残る1件はC1の `v2-frame-non-escaping` (`may` vs `no`)。未解消として保持する。
- X-02も旧120行は通るが、追加行列が同じimport欠落で読込不能。
- 根因: `d792b212` がmainのconsumerを採用した際、#3606のproducerが欠落。
  元commit `cd7db4f5ebfebcea0e8b0389760cc769d5626114` のhelperを復元。
  CFG/flags/faultやC4の変更は行っていない。
- 新規回帰は修正前import失敗、修正後6件成功。既存所有権検査も成功。
  実ファイルallowlistと未宣言差分を拒否する回帰を併せて更新。
- npm依存はlockfile通り導入済み（Playwright 1.63.0）。Chromium1243/WebKit2359を
  永続cacheへ取得済み。WebKit共有library不足の解消と実起動は進行中。
- `npm run check` はquiet wrapperで実行中。現時点では合格とはしない。

証拠: 永続evidence配下の `entrypoint-before.{json,log}`、
`entrypoint-after.{json,log}`、`c1-c2-c3.{json,log}`、`x02.{json,log}`。
修正後の実行はcommit前の作業ツリーであり、receiptのsourceHeadだけでexact-head証拠とはしない。
次はcommit後の重点検査、全体の最初の失敗、C1 aliasの正の受入を確認する。

## Checkpoint 2: 重点受入と環境

- source commit `1957bc55b33b0fcf79328bbf88d9e2675f6d0847` はpush済み。
- `focused-restored`: 266/266成功（C1再帰return、C3 ABI、C2 byte forwarding、
  追加X-02、入口依存、call-boundary）。log SHA256:
  `d68cafac2da457a0ee7fc3a2cce64db4a2e48478c4cd933da675a75de76ee18a`。
- 入口依存+既存ownershipは29/29成功。`call-boundary` 単独も成功。
- canonical userscript buildを2回実行し、一致。template SHA256:
  `bed1dd7bb132db1c14f910c858d15a595df54b5d042713ff71552e1eef0a8446`。
- Playwright 1.63.0の不足libraryを導入し、Linux x64上でChromium 153.0.8010.12と
  WebKit26.6の実起動・ページ読込に成功。物理iPad/Safariの証拠ではない。
- canonical `tests/phase9/browser/worker-runtime.mjs` は初回SATがtimeout、続くqueryが
  invalid-queryとなり失敗。起動成功をsolver受入成功に読み替えない。閾値は不変更。
- LLVMはUbuntu14.0.0のみで指定Ubuntu18.1.3は未導入。X02-H-02を成功にしない。
- CodeRabbit0.7.6は未認証。`auth login --agent` はenvironment_unsupported
  （localhost browser callbackが必要）。ユーザー側の `coderabbit auth login` が必要。
  独立レビューは未実施、承認なし。
- 全体checkはmachine-effects-contractを実行中。最終結果は
  永続evidenceの `check-first.json` に終了後atomic保存される。

### 残件の再開順

1. `check-first.json` の有無とログを確認。失敗を削除せず最初の原因を調べる。
2. C1の旧非escape正例と #4977 の両root証拠契約の衝突を解決する。
   片側non-escapeだけでexactを許可する変更・期待値をmayへ変える変更は未実施。
3. Worker初回SAT timeoutを原因分離し、同じ2秒予算・32/64-bit全分母で再検証。
4. 指定LLVMと独立レビュー認証を揃える。物理実機検証は下記ユーザー指示により今回スキップ。
5. 全canonical gates、exact-head CI、candidate tree、ユーザーC4との統合はそれから検証。

環境再開時は `PLAYWRIGHT_BROWSERS_PATH=/mnt/workspace/.dev-state/agent-work/cache/analysis-remaining-20260914/browsers`。
全体は引き続きIN PROGRESS。ユーザー担当の完了も、この分担の全完了も宣言していない。

## リモート提出と継続検証

- Draft PR: https://github.com/rhgrive3/hex-ida/pull/8888 （既存 #7036 のブランチ向け）。
- `76f7b6926d8edb009443f973789862ddec0b5008` をpush済み。
- このclean commitでcanonical buildを再実行し、tracked生成物の差分ゼロ。
  `generated-committed.json` / `.log` に記録。module-boundariesも同commitで成功。
- 全体check終了後、永続checkpointの `publish-check.py` がreceiptのログhash、
  branch/head、clean treeを照合してこの文書だけに結果を追記し、commit/pushする。
  並行変更があれば編集せず `automatic-publication.json` にblocked理由を保存する。
  push失敗でもcommitと全証拠は永続workspaceに残す。force-pushしない。
- 自動記録は診断の保存であり、review/merge/releaseの承認ではない。

## 全体check終了記録（自動保存）

- コマンド: `node scripts/run-quiet-command.mjs --label check -- npm run check`。
- 終了コード: `1`、実行時間: `2049.792` 秒。
- 開始時HEAD: `2f8d57bd2728a4c8a592110f5073fc05d8678211`。
- ログSHA256: `51d457a5db32990911d3e324a7b12b13655636540d9e1f90ed28f9448e161a13`。
- 証拠: 永続evidenceの `check-first.json` / `check-first.log`。
- この実行は修正commit前に開始し、実行中に生成物・環境が更新された診断。
  exact-head全体受入・全finding完了の証拠にはしない。

## 実機検証の分担更新（2026-09-14）

- ユーザー指示: 「実機はスキップしてください。」
- 今回の担当作業では物理iPad/Safari、Apple arm64e、実機上のordering/signing/runtime検証を
  `SKIPPED (user-requested)` として対象外にする。接続先・過去の実機記録の提出待ちは解除。
- Linux Chromium/WebKit、指定LLVM、コードの回帰検査は継続する。
- 実機成功の記録、全体ロードマップの完了、リリース承認に読み替えない。
  製品の実機受入validator・分母・必須証拠の規則は変更しない。
- 全体checkはmachine-effectsの8ファイルで失敗し、後続のcanonical gateは未実行。
  LLVM非対応、oracle証拠、x86 decoder/診断契約を含む。ユーザー担当の意味論と区別して調査する。

## Checkpoint 3: LLVM受入とWorker依存境界

- 指定LLVM18.1.3とGit2.49.1の永続インストールを発見し、実体・hash・版を確認した。
  LLVMはUbuntu署名と11パッケージのhashを再照合。証拠は `toolchain-restored.json`。
  `/usr/bin/{llvm-readobj,llvm-mc,llvm-objdump,clang}-18` の未使用パスから永続wrapperへ接続。
  Gitは `/mnt/workspace/.local/hex-stage-a-toolchain/install/bin` をPATHの先頭にする。
- `fd0ad1dfe` のclean treeでARM64整数・メモリ全分母とX-02元120行の122検査が成功。
  `llvm-restored.json/.log`、log SHA256 `504d48f7940ea2e22e9f5be83dc345981113fe1b4900eb0e0cd2876451f02419`。
  X02-H-02は実llvm-readobjによる変更後Mach-Oの独立reparse成功。
  元120行の環境依存分類は115 pass / 4 evidence-gap / 1 environment-excluded。
  凍結行列の履歴・分母・実機スキップは保持する。
- 新しいGitでoracle report検査は実行可能になったが、origin/mainとのcandidate treeに
  6パスの競合があり拒否された。機能テストの合格やこのPRのマージ可能性とは別に保持する。
- Worker計測でqueryの `createCompleteness` importがsupport-matrix経由でIR、全target、
  decompilerまで読み込むことを確認。完全性データの同じ定義を依存のないモジュールへ移し、
  public support-matrixは同じ関数と定数を再exportする。query内容・hash・判定・予算は不変更。
- Workerの実依存graphをesbuildで検査する回帰は修正前失敗、修正後成功。
  query/translator/Worker lifecycle/ownershipを含む48検査成功（commit前診断）。
- canonical browser検査は変更後もChromium初回SATで2秒timeout。Linux runtime受入は未完了。
  重い依存の除去を性能合格に読み替えない。生成物はこの変更から次にcanonical再生成する。

- Worker依存分離は `c59ad876485f2eb83f3fac0ccb92007d42102f9c` としてpush済み。
  canonical生成を2回実行し、tracked userscript/release-versionのhash一致を確認。
  `generated-lightweight-{first,second}.json` と `generated-lightweight-hashes.json` に保存した。

## Checkpoint 4: clean commitでの検証と時計回帰

- `c051ab2ede7b2dc211c9ad9ab5540602d4575f37` はpush済み。
  同clean commitでquery/Worker/translator/ownership 48検査とmodule-boundariesが成功。
  `worker-contracts-committed.json` のlog SHA256は
  `4fca9ea43c7ee0b9b7d9bc3e9ee82c48e306cda11018665dceada87bc88d2a24`。
- 同commitで `f6-real-fixtures`、PE/Mach-O layout cell、X-03 discoveryの4ファイル成功。
  4つの実fixture（ELF64、PE32+、PE32、Mach-O64）をLLVM18.1.3で独立reparseした。
  証拠は `rebuild-independent-restored.json/.log`。有限mutation/layoutの受入であり全形式の完成ではない。
- Worker追加計測では、2秒終了時点でもモジュール読込中で初期化完了に届いていない。
  この環境のcold-start受入は未合格のまま。予算・warmup条件を変更していない。
- 全体checkで落ちたmismatch minimizationは単独再実行では成功した。
  aggregate期限の試験はperformance.nowだけを模擬し、内部oracleが使うDate.nowは実時間のままだった。
  同じ模擬時計へ揃え、100ms総予算・1比較30ms・4比較で期限切れという既存期待値を保持した。
  生産コードとISA意味論は変更せず、mismatch/sequence両検査が成功。
  証拠は `minimization-before` と `minimization-clock-aligned`。
- Stage2 canonical suiteは別receiptへ保存する。実機検証は引き続きユーザー指定でスキップ。

## Checkpoint 5: 追加ゲートの実測

- 正本監査JSONにも `integrationFollowup.nonC4Continuation` を追加し、`ed4027f6a` までpush済み。
  既存23 finding / 21 task、ユーザー担当、全体未完了を保持した。
- clean `3ea388914` で管理対象モジュールのidentity重点43検査が成功。
  CIL Module、shared identity、profile identity、identity primitivesの範囲。
  Phase11全体成功に読み替えない。
- clean `ed4027f6a` のPhase12 canonical suiteは **228ファイル成功 / 5ファイル失敗**。
  全233ファイルを実行した。残る失敗はremote collaborationの2件、foundation denominator、
  checkout action旧版を期待するCI契約、EvidenceStoreの旧verified昇格期待。
  独立再構築の重点成功と区別し、この解析修正からremote権限や証拠昇格を緩めない。
  receiptは `phase12-current.json`、完全ログは `phase12-current-full.log` に保持。
- Stage2はclean treeを要求するため、dirty実行の停止を保存し、commit後に再実行した。
  不足していたLLDB14/QEMU6.2を導入。LLDBが報告するPythonディレクトリの欠落を、
  実際にインストールされた同版モジュールへの接続で補正した（`lldb-package-layout.json`）。
  ARM64/arm64eのローカル検証を経て、RISC-V LLDB接続で失敗した。Stage2全体は未合格。
  実機の検証・実機成功の証拠ではない。LLVM18系LLDB環境を継続準備している。

## Checkpoint 6: 関数要約の入力依存も復元

- PR #8888のレビュー指摘に従い、`analyzeFunction` 側にも #3606 の共通
  `arm64ReadsDestination` を接続した。MOVK/PACIA/BFIの入力x0欠落を修正。
  CASPの入力ペア処理を保持し、MOVZ/MOVNは入力x0を要求しない。
- 修正前は追加5検査中3件が失敗。修正後はentrypoint・ownership・既存CASP/
  exclusive-store検査の36件が成功（`summary-entrypoint-repaired.json`）。
  このreceiptは編集差分付き検査であり、exact-head受入ではない。
- canonical userscriptを2回再生成し同一hashを確認
  （`summary-generated-hashes.json`）。
- CircleCIの実ログで作業ブランチがroadmap用ownership経路に未登録と確認。
  別の修正で正確なbranch名の経路を追加し、全diffの宣言検査を維持する。
- LLDB18.1.3によるStage2のARM64/arm64e/RISC-Vローカルprovider検証は成功。
  続くx86 native fixtureのLLDB起動で失敗し、Stage2全体は未合格。
  `stage2-lldb18.json` と完全ログを保存。実機検証の代替成功とはしない。

## Checkpoint 7: 続行ブランチのCI経路

- `codex/analysis-remaining-20260914` だけを既存roadmap manifestの経路へ追加。
  CircleCIとGitHub exact-SHA fallbackの両方を接続した。全changed-file宣言検査と
  各phase所有権検査を維持し、隣接branch名・未宣言pathは拒否する。
- 修正前の回帰は21成功/2失敗、修正後は23成功
  （`continuation-route-before` / `continuation-route-repaired`）。
  リモートCI成功の認定は新headの実行結果を待つ。
- LLDB18の補助server実体を専用wrapperへ接続。コンテナがpersonality変更を拒否するため、
  専用LLDBの起動設定はASLRを有効のままとした。静的fixtureと検査assertionは変更なし。
  native fixtureの起動・停止が成功（`native-lldb-aslr-enabled.log`）。
  実行設定とwrapper hashは `lldb18-runtime-configuration.json` に保存した。

- 実際の477 changed-fileを照合し、既存 `js/blocks-base.js` と #3911の
  call引数来歴検査だけがmanifest未宣言と確認した。両ファイルは作業開始時の
  親head `d792b212e` と同一で、今回ソース変更はしていない。
  既存integration ownerへ2つのexact pathを登録し、削除時の拒否回帰を追加した。

## Checkpoint 8: clean headとリモートCIの結果

- `e6f694e89e2ff14a6cd7bc1c8921c0c6f8e3b635` はpush済み。
  clean headで実差分のPhase7/8 inventoryが成功し、同headのリモートCircleCI
  Phase7/8 ownershipも両方SUCCESS。`continuation-inventory-committed.json` と
  `remote-checks-e6f.json` に保存した。全体admission成功とは区別する。
- 同clean headで関数要約・CASP/exclusive store・Worker import境界の検査が成功
  （`summary-contracts-committed.json`）。PR #8888の説明も修正後の実装へ更新した。
- 同headのcanonical Stage2はARM64/arm64e/RISC-Vの実LLDB/QEMU検証を通過し、
  x86 nativeの起動・レジスタ・メモリ操作も進んだが、attach用launcherで失敗した。
  完全ログ `stage2-native-restored-full.log` とreceiptを保持する。
- LLDB内蔵Pythonの環境を外部子Pythonへ持ち込まないよう専用wrapperを修正した。
  外部Pythonの起動成功を実測したが、x86重点再検査は同launcherで失敗した。
  stderrを独立に取得すると `PR_SET_PTRACER` 呼出しが `EINVAL` を返していた。
  この環境では `/proc/sys/kernel/yama/ptrace_scope` も存在しない。
  根拠は `lldb18-ptrace-launcher-diagnostic.log` と
  `stage2-x86-child-environment.json`。attach検査・必須assertionは変更していない。
- C1の固定corpusと非escape契約、Workerの2秒browser受入、全体check、
  Phase12の5失敗、main競合と最新headの独立受入は残る。
  実機はユーザー指定でSKIPPED。監査JSONの23 finding / 21 taskと未完了状態を保持。

## Checkpoint 9: Worker起動依存の追加修正

- Worker entrypointがID/version定数のためにhost transportをimportしていた。
  既存worker-protocolへ同一定数を移し、両host APIのre-exportを保持した。
  exhaustive/tiered両Workerの実import graphでhost transport不在を検査する。
- 修正前2回帰失敗、修正後の関連51検査とexact path所有権回帰が成功。
  canonical生成物は2回buildで同一。receiptは `worker-host-import-*`、
  `worker-protocol-ownership`、`worker-protocol-generated-*`。
- `worker-host-browser` ではChromiumの既存2秒SAT/UNSAT、32/64bit、stale拒否、
  proofが全て成功。WebKitはlibxslt等の環境ライブラリ不足で起動できず、
  browser全体は未合格。以前のChromium timeout記録は履歴として保持する。

- WebKit共有ライブラリを永続cacheから復旧し、clean `70fe267fd` で
  canonical browser検査を再実行。**Chromium / WebKit両方PASS**。
  既存2000ms予算、narrow SAT/UNSAT、32/64bit、stale拒否、exact proofは変更なし。
  `worker-host-browser-committed.json` のlog SHA256は
  `42be5bf15faf94d25227ae135a3c169489e8769c43f1c7666d2209828c0c819b`。
  同clean commitの関連51検査も成功（`worker-host-contracts-committed.json`）。
  Worker browser受入の残件はこの環境・commitで解消した。実機成功とはしない。

## Checkpoint 10: ユーザー指示による #7036 への集約

- 追加PR #8888は並行作業中の保存先だったが、ユーザーの集約指示に従い、
  実装と文書を#7036のbranchへ統合する。以後の正本は#7036。
- 取り込み元: #7036 `10c718296f28622145696d48257b72880ab3d3fa`、
  追加実装 `321f67610bff908f261f448d12faca2e0e00b2d5`、
  main `f1af93b04a9511703fba61e1b6b14d9fbce4b572`。
  #7036のmainに対する108 behindをmergeで解消し、force-pushは行わない。
- #7036側のCFG予算共有と公開stack escape保持を保存。
  C4 return-target拡張とmainのcontrol-target個数検証を併存させた。
  ARM64 helperの重複を除去。非canonical BVの拒否理由はmainの表記へ統一。
- RISC-Vは共通flatteningを再利用し、struct名にUnionを含む場合の誤判定と、
  canonical layoutで証明済みの単一member unionの扱いを整合した。
  SysV MEMORYのsretはmain #6010の導出契約へ受入期待値を同期。
  不明layout・重複layout・未証明nested aggregateの拒否は維持する。
- canonical userscriptは2回buildで同一
  （`integration-7036-generated-hashes.json`）。
  この統合はbranch集約とmain追従であり、未解決の全体受入を成功に変えない。

- clean `972c01bc0cdd6dc4cc81c14738cd2ee8ebcb2918` で関連305検査と
  Phase7/8の実changed-file ownershipが成功。
  Chromium/WebKitは並行検証時のproof unknownを記録し、同headで単独再実行すると
  両方成功した。2000ms・分母・assertionは維持。両receiptを保存する。
  `integration-7036-tests-committed`、`integration-7036-inventory-committed`、
  `integration-7036-browser-committed`、`integration-7036-browser-isolated` を参照。
  旧「mainに6競合」の残件は今回解消。全体受入と実機SKIPPEDは別扱い。

- #7036へ `972c01bc0` をpush後、GitHubで#8888のMERGEDと
  main比較の **behind=0 / ahead=259** を確認。統合前の108 behindは解消した。
  #7036自身をmainへmergeしたという意味ではない。今後の作業先は#7036へ統一する。


## Checkpoint 11 — C1 truth erratum (2026-09-15)

- C1の不整合はfixtureの期待値にある。`frame-non-escaping` のSPとx0は入力値であり、非escapeでも同じアドレスを指せる。`callee-returned-pointer` もx0をpure callの**前**に読み、callにreturn bindingはない。`tls-vs-stack` は両方memory空間で、SP側のlocal-stack storage/disjointness証拠がない。
- 3件とも重複・非重複の具体的なDataView witnessを追加した。誤ったNoAliasをMayへ訂正し、v1の対応するframe queryも訂正。元のv2 **30 query ID/categoryをすべて保持**し、正例/保守例は旧15/15から **12/18** へ変更した。精度改善の実績とは扱わない。
- `CORPUS_VERSION:2`、v1 truth generator `2.0.0`、v2 truth generator `3.0.0`。スコア算出式、precision/recall=1、falseNo/falseMust=0の閾値、runtime alias/escapeの証明条件は変更しない。旧版の受入証拠はこの訂正版の証拠には流用しない。
- frozen manifestにv2全30行と明示的erratumを追加。旧digest `519bd15f3a918dbc2b436aca4870455d` → 新digest `896de134032f78f88732e2513677e4b7`。除外なし。
- legacy safety-floor baselineを訂正版の同じmanifestで再測定した。これは訂正後の再計算であり、candidate実装前に採取したbaselineという意味ではない。旧manifestとbaselineはGit履歴 `9c105b5e0` および永続evidenceの `c1-before-*` に残す。
- mainのcontrol-input cardinalityにfixture helperを適合させた。条件分岐へ未制約のentry predicateを与え、両経路を保持する。canonical CFG/PHI実装は変更しない。
- witness・全30行precision・frozen corpusの12検査は成功。commit後のC1結合・関連回帰・canonical Phase7とownershipの結果を追記する。全ロードマップの完了宣言ではない。


## Checkpoint 12 — C1 committed acceptance and full-gate result (2026-09-15)

- `cc1a923c9ddc4f93bd6af70632290c21522ecce8` のclean headでC1結合・escape・corpus・240 rename cellを含む **201/201 PASS**。実差分Phase7/8 ownershipもPASS。`c1-final-acceptance` log SHA256 `19f821bca7f0f1f9277c7d7247423121583c8310d97a251c17fbaa996dc93654`、inventory `a5c56083091242fe5d6c819e27df59a09c2efd9ac7a716e11c794bf38ad9f6ec`。
- 同headのcanonical `npm run phase7:test`（440 discovered files）はexit 1。成功扱いにしない。全ログを永続evidence `c1-canonical-phase7-final-full.log` へ保存、SHA256 `efb762e2f06de24d9195c6d7233342a8c10d677748413c93350d422544458827`。runner出力は最終集計前で途切れており、全件のpass/fail数は確定できない。
- その実行で残っていた #5215 の旧片側non-escape正例を修正した。正例には両allocation rootを明示し、両方を観測する副作用のないfixture式を追加。refine時NoAlias、reject後May、escape cache再計算の検査を維持し、5/5 PASS。片側のみの他fixtureと #4977 負例は保持する。
- 未解決の全体検査には #4777 のgenuine scalar chainがunknownになる精度回帰、region debug出力、共有producer/abort、ownership重複、#3754 control-target fixture等がある。#4777は単独でも再現した。今回のtruth訂正を理由にそれらの期待値やruntime条件を緩めない。
- exact Phase7 verifierの訂正版aliasはbaseline 1/2・candidate 2/2、falseNo/falseMust/unknown=0、memory link 2/2。ただしcoldActiveFunctionは並行実行時610.737ms、他の担当検査終了後も368.466msで250ms予算を超え、**BLOCKING**。元の予算を保持する。`c1-isolated-verifier` receipt SHA256 `e94d85deedd69f591cf0990c6da43fd0fe86cde3ee9f2826ecef9551ada4d0f6`。
- 初回の誤ったexpect-sha指定はidentity rejectionとして履歴に保持し、正しい40桁SHAで再検証した。旧headでの中断したfull runもPASSにしない。
- #7036のcandidate source conflictは解消済みでbehind 0を再確認した。統合受入/全ロードマップ完成は未宣言。物理実機はユーザー指示でSKIPPED。

最終追加検証: `6e6fcaf382c9f4ee0a00116cd0fe9d692fa0faae` のclean headでC1・#5215・ownership回帰 **230/230 PASS**、実差分Phase7/8 inventoryもPASS。
acceptance log SHA256 `7aab33d9e8f628787fc466925abdd827064157387e8689ddf695cdf596737991`、inventory `3dfbe71a2599fff2a13bf5e8cafc71c6638a6dc01aba645f4cb6cae3707e4bf4`。
main `f1af93b04a9511703fba61e1b6b14d9fbce4b572` に対してbehind **0**、ahead **263**。以後の文書commitはこの検証対象SHAと区別する。


## Checkpoint 13 — #4777 fixture binding repair (2026-09-15)

- `tests/phase7/alias/issue-4777-forged-scalar-ssa-rename.test.mjs` marked a partial function and included a state-unknown call, but the function-level unknown record had no `detail.nodeId`. SSA correctly treated that unlocated record as potentially separate from the represented call and inserted an entry-wide unknown state definition. That made an earlier, valid SP-relative store unknown before the call.
- Bind the record to `node_call_unknown`. The SSA unknown now remains at its actual call position: the pre-call `sp + 0` chain again classifies as `rooted-offset`; later untrusted rename rows remain `unknown`. Neither production proof logic nor forged-row negative behavior is weakened.
- The issue's two focused regressions pass (2/2). Added its exact Phase 7 owner and a negative ownership-manifest check. Verify current-head inventory and ownership test after commit.
- The earlier 440-file Phase 7 run was on a head before this fixture correction and must remain recorded as red. Other unrelated/full Phase 7 blockers remain; do not claim a full Phase 7 pass from this focused repair.
