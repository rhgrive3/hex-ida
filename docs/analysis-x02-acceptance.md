# X-02 Apple 横断受入 — ユーザー並行作業

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
