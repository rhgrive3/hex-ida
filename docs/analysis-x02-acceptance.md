# X-02 Apple 横断受入 — 2026-09-13 ローカル検証

**有限の公開入口検査を実装・実行。X-02 全体は未完了、CHECKPOINT-LOCKED。**
今回の正本は添付 ZIP。全体の記録は [ローカル引き継ぎ](analysis-local-handover.md)。

## 元要求・別成果との関係

元の `HEX-X-02` / `FR-X-02A` は変更しない。今回の JSON の 12 行は要求カテゴリ、
59 行はこの ZIP で新たに実行できる有限の機能検査、2 件は manifest 整合検査である。
**既存の別 remote 成果の 120 行を 59 行へ縮小したという意味ではない。**
末尾の全体引き継ぎに記録された `684f1f0bb9c4809cd9bbaba01f01a4849151cc0b` の
120 行 matrix は添付 ZIP にない。remote を取得せずローカルで作業したため、
その成果の取り込み・重複照合・再検証は未実施。過去の製品不足6/証拠不足4/環境対象外2行も
今回の数値で上書きしない。履歴にある reviewed は当時の主張で、今回の独立レビュー実施ではない。

新しい pointer decoder/type graph/provider は作成しない。実データを読む公開
`openBinary` / `openBinarySource` から既存 `ObjcMetadataProvider` / `SwiftMetadataProvider`、
既存 dispatch index・image-owned pointer resolver・format-safe transaction を利用する。
完成済み runtime model をテスト対象 provider へ注入していない。

## 原因を修正した範囲

`js/metadata/objc.js` は classlist しか runtime parser に接続していなかった。
実入力に category/protocol が存在しても 0 件に落ち、complete と報告する反例を確認した。
既存の category/protocol parser へ実セクションを接続し、各 table の completeness を集計する。
同一 selector の class/category を別候補・別 entity ID で保持し、protocol requirement を
実装済み IMP と取り違えない。型住所の `addr` と `address` の既存 schema 差も正規化する。

公開セクションの address/size、不完全な宣言、重複 table、明示 null hints を検査する。
複数 table の結合機能を新設したのではなく、未結合なら partial を返す。
probe 開始時に cache を破棄し、private 世代番号で遅延した旧 probe の公開を拒否する。
provider version は 1.1.0。既存の正確性・期限・取消し gate は弱めない。

## 固定入力と期待値

manifest: `tests/scpa/fixtures/x02-apple-version-matrix.json`。
49 入力すべてについて SHA-256・byte 数・生成パラメータ・architecture・format を保持し、
同じ fixture helper による再生成または tracked binary の読み出しで hash を照合する。

基本入力は所有済みの layout fixture から raw memory を得て、VA と file offset が異なる
Mach-O container を生成する。ObjC class/category/protocol と Swift nominal/generic/witness/capture
を読み取る。基本入力 SHA-256:
`be916a8e757454049c1ada945c95208bb34f21ae09d7484bfd582b7fbb602ec4`。
ABI の `swift-5.0` / `objc-2.0` は layout ラベル。観測 OS/compiler/runtime version は null のまま。

authenticated chained-pointer は 5 formats × bind/rebase × 4 keys = 40 行。
raw/site identity、key/diversity/address-diversity、rebase target、missing bind import を検査する。
`authenticationVerified:false` / `executionTargetExact:false` を必須とし、実機認証を主張しない。
format 14、fixups version 1、unknown Swift kind、切れた table、未対応 cache header を否定例に残す。

署名 fixture は LC_CODE_SIGNATURE の marker を持つだけで、有効な Apple 署名ではない。
unsigned-only 書換えが拒否されることを検査し、再署名や OS 起動成功には換算しない。
既存の compiler-produced Mach-O object は tracked manifest の hash と loader 結果を照合する。
記録された producer は Ubuntu clang/LLD 18.1.3。現在の環境での再生成ではない。

手書き layout の期待値は repository-owned contract oracle であり、独立した Apple 実装の
差分 oracle ではない。指定 `Ubuntu LLVM version 18.1.3` の readobj は利用できず、
既存 `tools/validation/rebuild-independent-oracle.mjs` は environment-excluded。
clang 17 や同じ parser を独立 oracle にすり替えない。

## 要求→検査→残件

`pass` は記載した有限 contract の合格であり、元要求全体の完了ではない。
全12カテゴリの `fullAcceptanceComplete` は false。否定テストの成功から正の機能を完成扱いしない。

| ID | 要求 | 有限検査の分類 | 残る境界 |
|---|---|---|---|
| X02-R01 | OS / compiler / runtime identity | evidence-gap | No observed Apple OS/runtime versions; synthetic layout labels are not version observations. |
| X02-R02 | Direct shared-cache input | product-gap | Public binary loaders expose Mach-O/ELF/PE, not a direct cache/slide-info reader. Header-only rejection is negative evidence only. |
| X02-R03 | Shared-cache slide / rebase and address identity | product-gap | Nonzero VA/file-offset mapping is exercised; shared-cache slides and extracted-image reconciliation are not implemented here. |
| X02-R04 | Chained fixups | evidence-gap | 40 synthetic authenticated site rows and unknown version/format negatives pass; real versioned producers and independent decode are absent. |
| X02-R05 | Swift generic metadata | evidence-gap | Owned layout descriptor is parsed. Runtime instantiation and substitutions remain unknown. |
| X02-R06 | Swift witness metadata | evidence-gap | Owned layout target passes the image-owned resolver. Real runtime witness execution is unverified. |
| X02-R07 | Swift capture metadata | evidence-gap | Type/source descriptors preserved; object layout and metadata-source interpretation remain unknown. |
| X02-R08 | ObjC class / category / protocol / dispatch | pass | Finite public-input contract passes after provider integration; version-wide and device acceptance are not established. |
| X02-R09 | PAC raw / key / diversity / site identity | pass | Finite byte-bound metadata contract passes; authenticationVerified and executionTargetExact stay false. |
| X02-R10 | PAC runtime authentication | environment-excluded | No Apple arm64e device/runtime oracle; metadata preservation does not establish authentication. |
| X02-R11 | Signing impact | evidence-gap | Synthetic signature marker blocks unsigned-only mutation; no valid Apple signature, re-signing, or OS launch oracle. |
| X02-R12 | Independent Mach-O reparse | environment-excluded | Required Ubuntu LLVM 18.1.3 readobj is unavailable. Checked-in compiler artifact hash is not a current independent reparse. |

## 実行と証拠

```sh
node --test tests/scpa/x02-apple-version-matrix.test.mjs
node scripts/run-quiet-command.mjs --label x02-scpa -- npm run scpa:test
```

focused は **61 PASS / 0 FAIL / 0 SKIP**。canonical SCPA も exit 0。
実コマンド・終了コード・source blob identity は配布 `evidence/verified-results.json` と
`evidence/verification-source-freeze.json` に記録する。
全61件の TAP は `evidence/logs/x02-manifest-final.log` と focused transcript に保持する。
通常 quiet wrapper は成功した内部ログを削除する仕様なので、canonical SCPA は wrapper の
PASS/exit receipt を保持しており、存在しない全成功ログが保存済みとは扱わない。
失敗した baseline・中間試行・最終 gate のログは削除しない。

今回のレビューは実装者による自己レビュー。独立レビュー、実機、remote CI/merge は未実施。
旧担当予約の4パス以外に見つかった provider 原因修正は、今回の全ローカル統合依頼として
別途 changed-file manifest に明示する。旧環境の保存先・subagent 指定を実施したと主張しない。

---

## 当初の担当予約（履歴。現在の未着手状態を示すものではない）

### 旧予約文書

状態: **担当予約済み・未着手**。この文書を置いただけでは受入完了ではありません。
今回の目的は、既存 Apple 解析の実入力→解析結果→下流利用を横断して検査し、
元の X-02 要求に対する成功・実装不足・証拠不足を再現可能に分けることです。
既存 provider や別の pointer/type エンジンを作り直す仕事ではありません。

## 開始元と分担

開始元は PR **#7036**、`feat/analysis-roadmap-v8-current-main-20260907`。
ユーザー C1 パッチを取り込んだ runtime は `1931f30099a1c86dfb649cf6e8c57770b2b3b483` です。
この担当予約を追加した公開コミットの SHA を固定して、別ブランチ
`work/x02-apple-matrix-20260913` から作業してください。開始 SHA は引継ぎメッセージで指定します。
途中で main や移動した統合ブランチを追い掛けず、結果に開始 SHA と最終 SHA を記録します。
統合担当は C4・ME・今回の C1 取り込み確認を進めます。

書き込み担当は、以下の **4 パスだけ**です。

- `tests/scpa/x02-apple-version-matrix.test.mjs`
- `tests/scpa/fixtures/x02-apple-version-matrix.json`
- `tests/scpa/fixtures/x02-apple-version-fixtures.mjs`
- `docs/analysis-x02-acceptance.md`

既存 runtime・共通テスト・ownership・生成 userscript は統合担当が管理します。
新しい fixture の生成手順・小さな元ソースは上記 fixtures.mjs に収め、
大きな入力やログは永続 evidence に置いて hash と再現手順を manifest に記録してください。
別の runtime 修正が必要と分かったら、失敗する受入行と原因箇所を提出物に残します。
特に `js/binary/macho-dyld.js`、`js/metadata/swift.js`、`js/metadata/objc.js` には
別 PR の進行中の変更があります。この担当では読み取り対象です。

## 仕上げる内容

1. **要求と検証行を固定する。** 原文は `docs/解析ツール改善.md.txt` の HEX-X-02 と FR-X-02A。
   OS/compiler/runtime identity、共有キャッシュと slide/rebase、chained fixups、
   Swift generic/witness/capture、ObjC category/protocol/dispatch、arm64e PAC/auth、
   書換えの署名への影響、独立 reparse の各要求に検証行 ID を割り当てる。
   既存対応 profile と元の要求を照合して集合を決め、通る入力だけを後から分母にしない。
   ABI ラベル `swift-5.x` / `objc-2.0` を、確認済みの OS/compiler/runtime version と扱わない。
2. **既存の実経路を通す。** 既存の公開 binary/metadata 入口から結果と下流の
   symbol/type/dispatch/address 情報を検証する。fixture に完成済み metadata や期待結果を
   注入しただけの検査は、入力からの解析成功と区別する。
   既存 tests/scpa の native-apple-metadata / pac-site、tests/metadata-apple.test.mjs、
   chained-fixup テスト、Phase 12 Mach-O rebuild の fixture・検証器を再利用する。
3. **入力と期待値に根拠を持たせる。** 各行に architecture、format、OS/toolchain/runtime の
   確認できた identity、入力 hash、生成元・コマンド、独立した期待値の出典を付ける。
   実 compiler/binary、手作り layout fixture、IR/metadata 注入を別分類にする。
   入手済みの実入力を優先し、未知の version や未入手の実入力はそのまま記録する。
   合成 fixture を実バイナリ由来の証拠へ言い換えない。
4. **境界を具体的に検査する。** 未知 version/kind、部分初期化・切れた metadata、
   slide/rebase と address identity、PAC の raw address と key/diversity/auth metadata、
   category/protocol の dispatch 候補、署名付き入力の書換え拒否・署名状態を対象にする。
   意味的に不完全な結果を exact としないこと、情報を失わないことを検査する。
   PAC fixture の成功は実行時認証成功ではない。署名状態の検査は再署名・OS 起動成功ではない。
5. **不足を引き継げる形にする。** 行ごとに `pass` / `product-gap` / `evidence-gap` /
   `environment-excluded` を記録し、実装の返した `partial` / `unknown` / `unsupported` も保持する。
   期待された unsupported の保持を確認するテストが通っても、その機能の正の要求を完了にしない。
   shared-cache を現在の公開入口が扱えない場合も、未実装の入口と既存の外部 import 経路の
   調査結果を分ける。失敗行を削除して全体 green にしない。

実機チェック、環境修復、別 issue の修正は今回も対象外です。
独立 Mach-O 検証は既存 oracle を使い、必要な LLVM version がなければ
`environment-excluded` として証拠を残してください。version gate を緩めません。
外部の仕様確認が必要な場合は Apple/Swift/LLVM 等の一次資料の版を固定してください。

## 検査と提出物

新しいテストは `tests/scpa/run.mjs` の既存再帰 discovery に入ります。
まず `node --test tests/scpa/x02-apple-version-matrix.test.mjs`、次に
`node scripts/run-quiet-command.mjs --label x02-scpa -- npm run scpa:test` を実行します。
関係する既存テストと baseline の失敗も記録し、新しいテスト自身の失敗を baseline で免除しません。
これは今回の検証担当の完了条件であり、X-02 全体の機能完成や release の宣言ではありません。

パッチと検証 ZIP に次を含めてください。

- 開始/最終 SHA、実際の 4 ファイル差分、各ファイルと入力の hash。
- 要求→検証行→実入口→期待値→結果の対応表と、削除していない全行の集計。
- 実行コマンド、toolchain identity、終了コード、成功・失敗の全ログと hash。
- 残る実装不足ごとの再実行コマンド、観測された結果、期待される契約、原因候補のパス。
- レビューの実施者と範囲。自己レビューと独立レビューは区別する。

`/tmp`、`/var/tmp`、`/dev/shm` は使わず、作業・入力・ログ・checkpoint は
`/mnt/workspace/.dev-state/agent-work/` 配下へ保存してください。
開始前に保存先の実体を確認し、TMPDIR/TMP/TEMP は既に設定済みなら繰り返し export しません。
サブエージェントを使う場合はユーザー指定の **Luna / max**、同じ永続保存先を共有します。

担当パスの重複確認: 2026-09-13、ページング済みオープン PR 103 件・変更ファイル 1,638 件の
一覧に対して新規 4 パスは一致なし。後日の変更まで重複なしと保証するものではありません。
# 2026-09-14: 元の120行を追加のcanonical検査として統合

元の `684f1f0bb9c4809cd9bbaba01f01a4849151cc0b` から、検査・JSON・fixture helperを
`tests/scpa/x02-prior120-apple-version-matrix.test.mjs` と同名のfixture群へ追加しました。
既存の59機能caseと2manifest検査は変更していません。元のJSONのSHA-256は
`c95ea2ba89d072fe9110565072462d5efca496b72a66ff365d8b8d15a95274ad`、helperは
`2448aec993b4b7151f05ae5be4fb03574649926f2b9eab23d90dc851962e2b2a` で、双方をそのまま保持します。

元の検査への変更は、fixture参照2か所の名前変更と、現在の厳密なMach-O一覧へ
`tests/phase12/integration/fixtures/issue-8280-arm64_32-objc.o` を追加する調整のみです。
追加fixtureの由来は `3389040ff402493b277410f9f3c11518f585fcb3`、blobは
`b650274f3acd6f038b8c63238880f145c3f4233a`。一覧の完全一致を維持し、未知の追加を除外しません。
このfixtureを署名・arm64e・実機の証拠には使いません。

`9ba6a0a` に適用した作業ツリーでは、120行・既存61検査・所有権21検査の計202件が通過し、
canonical SCPAも通過しました。再帰的な検査探索が追加moduleを含むことを確認しています。
120行の分類は108 pass・6 product-gap・4 evidence-gap・2 environment-excludedです。
gapを観測する検査の成功は、正の機能要求の達成を意味しません。
独立レビューと元blobとの照合を行い、X-02全体とreleaseは引き続き **CHECKPOINT-LOCKED** です。
新しいコミットやmain統合後の検査結果は、対応するexact-headの記録で別途確認します。
