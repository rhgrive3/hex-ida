# 001 — T016: discovery を保持する rebuild 連携の実装依頼

## 今回してほしいこと

レビューだけでなく、以下の未実装部分について、既存コードに適用できる
**最小の実装パッチと回帰テスト**を作ってください。大規模な設計刷新や
リポジトリ全体のレビューは不要です。返答は日本語で構いません。

対象は Hex の Recovery T016 です。別担当が他の Recovery 項目を進めており、
この依頼では下記の境界だけを担当します。解析改善 roadmap 全体や Stage B
には手を広げないでください。実装を採用する際の検証・統合は別担当が行います。

## 入力の読み方

- 添付された **この依頼の PR の head branch ZIP** が入力です。main ZIP ではありません。
- プロンプト以外のコード基準は T016 WIP commit
  `5eb62e32f9c0062da69a4e040fe1d52fb303ecbf`、tree
  `00ede08a2811a8f4ef329cde19aefc66ff328587` です。
- 依頼ブランチにはこのコードと `Prompt/` だけを含めます。差分添付はありません。
- ZIP に Git 履歴がなくても分析できます。SHA の実検証ができなければ、その旨を記してください。
- `AGENTS.md`、`docs/ENGINEERING_PROCESS_GUARDRAILS.md`、関連する rebuild/discovery
  の仕様を読み、以下の実装対象に絞ってください。過去の Done 記載は実装証拠ではありません。

## 既にあるもの — 作り直さない

`js/analysis/discovery/` に canonical artifact、typed identity、fusion rules、
producer provenance と conservative function candidate が存在します。
`js/analysis/index.js` の production `functionCandidates` から artifact が出ます。

特に次は既に実装されています。再実装せず実コードとテストを確認してください。

- `discoveryArtifactForRebuild` は collision/reference だけでなく
  `functionCandidates` と `intervalClaims` を保持する。
- collision がない「開始位置は分かるが extent は unknown」の入力も扱う。
- `verifyDiscoveryReparse` は collision ID が同じというだけで unknown extent の
  exact 化を許可しない。
- `tests/final-closure/t016/discovery-preservation.test.mjs` に unknown-only
  positive/false-exact negative と typed-identity budget の回帰がある。
- この基準点では既存 discovery 試験と上記試験の計43件が PASS だった。
  これは新しく書く rebuild 連携の合格証拠ではない。

## 未実装の作業

`js/rebuild/transaction-v2.js` の既存 create → materialize → validate → publish
という本番経路へ、canonical discovery の保存検証を接続してください。
別の transaction engine、parser、reaching-definition engine を作らないこと。

### A. 本番 parser から source/output の discovery を得る

- `js/binary/index.js` の既存 `openBinary` と production `functionCandidates` を使う。
- exact source bytes と binary/source hash/snapshot/architecture を束縛する。
- parser が partial、unsupported、cancelled、budget-limited なら完全な証拠にしない。
- 入力から渡された関数一覧や public metadata の「complete」を parser の代わりにしない。
- output は writer の戻り値だけで valid とせず、fresh parser で独立に読み直す。
- `verifyDiscoveryReparse` の既存 canonical authority を使い、比較ロジックを二重実装しない。

### B. 必須検証を途中で外せない identity contract

- discovery を検証すべき transaction であることを、materialized/validation の
  identity に保持し、publish まで改竄・脱落できないようにする。
- explicit opt-in、正規 artifact/binding、discovery に影響する operation/impact
  の扱いを、既存 contract に沿う最小の規則として定義する。
- caller の `false` や構造だけ似た object で、既に必要となった検証を無効にできないこと。
- ただし、未分類の既存 transaction を勝手にすべて新しい必須 lane に移さない。
  互換性が成立する判定と、その適用範囲を明記する。
- hash-shaped string、public boolean、caller の「検証済み」は authority ではない。

### C. committed bytes の確認と既存 caller の互換性

- discovery-required lane では `atomicPromote` の identity-shaped receipt だけで
  publish 成功にしない。実際に committed された bytes の読み返し・一致検証を要求する。
- 既存 publication adapter の契約を調べ、必要なら小さい bounded readback 契約を追加する。
- expected byte length と上限を先に確認し、N−1/N+1/過大入力を、コピーや
  `Array.from`・ハッシュ計算に進む前に拒否する。
- 非 discovery lane に一律 readback を強制して既存の正常系を壊さない。
- 特に `tests/stage2/rebuild-transaction.test.mjs` の既存 atomic publication positive
  と `tests/stage2/helpers/rebuild-proof-fixture.mjs` は **変更せず**通す。
- cancelled/deadline/resource-limit を成功にしない。未検証の出力を valid として公開しない。

### D. conservative な保存と許可された変換の線引き

- unresolved overlap、code/data conflict、relocation/reference ambiguity、unknown/
  partial extent を、証拠なく exact にしない。
- sourceHash が変わるために正当な identity digest が変わることと、意味の喪失を区別する。
- 最初の実装の対応範囲は小さくてよいが、何が保存される場合に成功でき、何を
  unsupported/rejected にすべきかを機械的に示す。
- 全出力を拒否するだけの実装や、同一 object を往復させるだけの positive は不可。
  実際の ELF/Mach-O/PE のうち、既存 fixture で証明できる本番往復を最低1つ使う。
- レイアウト変更の全種類に新しい同値性証明器を作る必要はない。

## 編集してよいファイル

- `js/rebuild/transaction-v2.js`
- 接続に必要な最小範囲の `js/analysis/discovery/**`、`js/analysis/index.js`
- `tests/final-closure/t016/**`
- `tests/phase7/discovery/**`、`tests/phase12/rebuild/**` の新規/関連回帰

次は読み取りだけにしてください。

- `js/ai/tools/registry-base.js`、`js/rebuild/format-safe.js`
- `tests/stage2/**`、他 lane の source/tests
- `tools/validation/**`、CI、package scripts、profiles、thresholds、生成物
- campaign specs/tasks/ownership/status と historical specs

別 ownership の変更が不可避なら、無断でパッチに含めず、具体的な first boundary と
必要最小の変更を別欄に報告してください。固定 test/oracle を変えて PASS にしないこと。

## 必要な回帰テスト

既存 fixture を使い、少なくとも次を requirement に対して試験してください。

1. 本番 parser で source → materialize → fresh output parse → publish/readback が成功する実バイナリ正常系。
2. 同じ collision ID でも unknown extent を exact にした output が拒否される。
3. conflict/reference/interval の欠落、source/binary/architecture の不一致が拒否される。
4. public `false`、forged/cloned binding、stale validation receipt が必須検証を外せない。
5. writer-success でも malformed output や異なる committed bytes は valid にならない。
6. readback absent、N−1/N+1、過大入力、cancel/deadline の negative。
7. 既存の非 discovery publication 正常系が変更なしに通る。

最初に不正な境界を示す最小 failing test を作り、その後に実装してください。
手元で実行可能なら focused tests を実行し、コマンドと実測結果を残してください。
実行環境がなければ NOT RUN とし、推測を PASS と書かないこと。
CLIやGitHubへのアクセスがなくても、ZIP 内コードへの適用可能なパッチは作成してください。

## 納品形式

希望する回答名: `Prompt/answer/001-t016-rebuild-implementation.md`

1. 実装した範囲と unsupported の範囲（短く）。
2. 最初の counterexample と修正する boundary、採用した identity/readback contract。
3. **全変更の unified diff**。新規テストを含むこと。別ファイルとして添付できればそれでもよい。
4. 実行した試験と結果、未実行の試験、残る統合上の依存。
5. 重要な trade-off と、採用前に別担当が確かめるべき点（最大5件）。

一般論だけのレポート、未実行 PASS、main merge/CI approval、全 roadmap の Done 宣言は不要です。
成果物は実装候補であり、受け取り側が実際の diff/tests を検証してから採否を決めます。
