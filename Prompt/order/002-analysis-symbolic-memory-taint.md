# 002 — 解析改善: symbolic memory と taint を実装する

## 依頼

Hex の `docs/解析ツール改善.md.txt` のうち、次のまとまった領域を
**実装パッチ・回帰テスト・実測結果まで**進めてください。レビューや提案だけで
終わらず、添付 ZIP に適用できるコードを納品してください。

1. **HEX-SYM-02 / T033:** byte-addressed symbolic memory と既存 executor/translator への接続。
2. **HEX-SYM-03 / T034:** その memory を利用する first-class taint、source/sink/sanitizer、
   evidence projection、既存の証明器を使う deobfuscation 候補の採用境界。

この二つは順番に実装してください。e-graph、solver backend、ISA semantics、
native rebuild、decompiler 全体の再設計は今回の作業ではありません。
既存機能を再実装せず、実際に不足している部分だけを閉じます。

これはユーザーが依頼した **Stage B 向けの先行実装候補**です。別担当が Recovery
と main 統合を進めています。あなたの成果を受け取った後に最新 main と再照合して
採用するため、campaign 全体の DONE、Stage A merge、Stage B 正式開始、roadmap
完了を代行宣言しないでください。納品コードの完成度と main 統合完了は別です。

## 入力 ZIP と既存作業

- **この order を含む PR の head branch ZIP** を使ってください。以前の T016 用
  ZIP、別途取得した main、過去の回答 ZIP へ差し替えないでください。
- コード基準は T014 candidate `f6db4575e10e405a4ef5a649b1e1fcbda9447f89`、
  tree `5d34120b4c25a859a853bc5413090a8a21ffe9e5`。この上には今回の `Prompt/` だけを追加します。
- この ZIP には既存 exhaustive backend に加えて **32/64-bit bitblast/tiered solver
  の Recovery 実装候補**が入っています。SYM-01 を未実装と決めつけて作り直さないこと。
  ただし candidate であり、main merge 済みという意味ではありません。
- ZIP に Git 履歴がなければ Git SHA の検証は `UNVERIFIED` と書けば十分です。
  入力 ZIP の SHA-256 と変更前ファイルの SHA-256 を記録できます。ローカルで作った
  Git commit や ZIP コメントを、提示 SHA の検証証拠にしないでください。
- `Prompt/order/001-*` は今回の入力として不要です。T016 discovery/rebuild は別担当です。
- 2026-09-05 の重複確認では open PR **#6602**、head
  `1bcd57812e843f2e5f9039adfd85f982b7e1d8bf` が
  `js/symbolic/verify/equivalence.js` と memory-region/sort-mismatch 回帰を変更中でした。
  **そのファイルの修正は別担当に残す**こと。ネット接続がなくても作業を止めず、
  下記の読み取り専用境界を守ってください。PR title や old roadmap は実装証拠ではありません。
- 追加の現行 OPEN overlap: #6546 (`fb805385989faa5b742bdf3f37b8069c36fd0312`)
  は `translate/semantic-ir.js`、#3421 (`834d3da3a02f3a1dc879ca7cd004401cccaf9384`)
  と #3422 (`a77177a9d9b0896ddbe654f2b4de67e762b144f5`) は
  `function-sandbox.js` / `translate/slice.js`、#6450
  (`d957b7fade9fd8b4bb25fb20010b37cdfd62b84c`) は Expr serialization/width を変更中です。
  これらは本パッチでは読み取り専用。必要な接続差分は別 handoff に分離します。

## Spec Kit の簡易手順（ツールのインストールは不要）

Spec Kit CLI、slash command、Graft、GitHub 接続は不要です。導入作業もしないでください。
`rg` / `grep`、ファイルを読む、利用可能なら Node でテストする、で進められます。
ここでは Spec Kit の考え方だけを次の4手順で実行します。

1. **仕様:** 関連 source/tests/specs を読み、「既にある／今回不足」を短い表にする。
   既存 `specs/005-analysis-final-closure/` の T033/T034 と性能 lock を再利用する。
2. **計画:** canonical memory/taint の owner、入出力、identity、unknown、budget、
   cancellation、production callsite を決める。第二の意味論エンジンを作らない。
3. **タスク:** `MEM-01…` → `TAINT-01…` の依存順リストを作る。
   各行は目的・編集ファイル・反例・試験・結果だけでよい。これを先に固定する。
4. **実装・検証:** 最小 failing test → 修正 → focused test → 関連 subsystem。
   最後に仕様と差分を再照合する。未実行は `NOT RUN`、未実装は `PARTIAL` と明記する。

この短い仕様・計画・タスク表は回答 Markdown にまとめてください。既存 campaign
spec/tasks/checklists を書き換えたり、同じ目的の新しい Spec Kit package を作る必要はありません。
文書の体裁調整を繰り返さず、最初の反例から実装に入ってください。

先に読むもの: `AGENTS.md`、`docs/ENGINEERING_PROCESS_GUARDRAILS.md`、
`.specify/memory/constitution.md`、`docs/flash.md` の symbolic/semantic truth 関連部、
roadmap の HEX-SYM-02/03 と C4-04、campaign の T033/T034・性能 lock、
`specs/002-byte-exact-memoryssa/` の関連 contract。履歴的 TODO より現行コードを優先します。

## 既存 owner — 最初に接続点を確認する

- `js/symbolic/executor.js` / `function-sandbox.js`: 既存 function-local execution。
- `js/symbolic/expr/`: canonical Expr の種類・sort・factory・評価・hash・serialization。
- `js/symbolic/translate/`: Semantic IR から canonical Expr への変換と completeness。
- `js/symbolic/solver/`: 既存 registry/session/result、exhaustive/bitblast/tiered backend。
- `js/symbolic/verify/`: 既存 query、eligibility、equivalence、model 検証。
- `js/symbolic/evidence/`、`js/symbolic/index.js`: 既存 evidence/public API。
- `js/semantics/memoryssa/`、`js/analysis/alias/`、`js/analysis/pointsto/`:
  既にある static memory/alias authority。**読み取り専用**。symbolic memory は
  query-local execution state であり、別の reaching-definition/alias engine ではありません。

path や API 名は ZIP の実物で確認してください。既存 Expr と executor の互換表示が
ある場合、見かけの同名 object を canonical Expr と混同せず、既存 translator を通します。
現行 Expr の sort は Bool/BV であり、一般的な array sort/store/select backend はありません。
まず既存 Bool/BV で証明可能な bounded byte-memory と production executor を完成させ、
一般 array theory 対応とは区別してください。表現できない load を exact にしないこと。

## A. Byte-addressed symbolic memory

具体的に必要なもの:

- concrete-only fast path を維持しつつ、1/2/4/8-byte の LOAD/STORE、部分上書き、
  little/big endian を byte 単位で正しく扱う。64-bit address は安全な BigInt 等を使う。
  width/address-space/wrapping/alignment の契約を明示し、Number の丸めを exact にしない。
- symbolic address が必要になったら明示的に escalation する。既知 concrete bytes と
  store の順序を失わないこと。query-local byte array/store history を既存 canonical
  Expr/backend 能力へ接続する。bounded lowering を使うなら、exact な適用範囲と
  byte array 意味論との対応を示す。未対応 backend を array 対応と名乗らない。
- unknown byte をゼロで埋めない。同じ address の繰り返し read、異なる symbolic
  address が等しい場合、overlapping stores、path fork/merge の整合性を保持する。
  independent fresh symbol を無関係に作って alias 制約を失う実装は不可。
- MayAlias/unknown store、unknown call、volatile/atomic は必要な barrier にする。
  MustAlias/NoAlias の判断を variable 名・string key・solver の public boolean から作らない。
  static exact forwarding が必要なら既存 authenticated MemorySSA query を消費する。
- executor と Semantic IR translator の **実際の production entrypoint** から使えること。
  export しただけ／テスト専用 helper を呼ぶだけは接続完了ではない。
- snapshot/binary/function/architecture/address-space/semantics identity を保持し、
  state fork は独立、結果は immutable、stale state の再利用は拒否する。
- work/allocation/store history/alias fork の上限を検査してから処理する。
  timeout/cancel/unsupported/budget は partial/unknown、遅延結果は公開しない。

最低限の試験:

1. 既存 concrete-only 結果との parity、LE/BE、1/2/4/8-byte と部分上書き。
2. concrete→symbolic escalation 前後の同じ観測結果。
3. symbolic index、同じ／異なる index の alias、read-over-write、複数 stores の順序。
4. 初期 unknown byte、hole、may/unknown clobber、volatile/atomic、call の negative。
5. 高位64-bit address、境界／wrapped address、width 不一致、未対応 sort の negative。
6. fork/join、cancel/deadline、limit N−1/N/N+1、deterministic replay、snapshot mismatch。
7. 小さい memory/address domain を独立に列挙する byte oracle との differential。
   production の memory helper を oracle の計算に再利用しない。

## B. First-class taint と evidence

- canonical semantic value ID と上記 byte memory 上の一つの taint lattice を実装する。
  explicit data flow、control dependency、phi/join、partial store/load、unknown call を扱う。
- source/sink/sanitizer model は version と provenance を持たせる。
  名前に `sanitize` がある／caller が `clean:true` と言っただけで taint を消さない。
  sanitization は宣言された範囲だけに効き、unknown sanitizer は conservative に残す。
- untainted と unknown/TOP を区別する。source 集合が budget を超えたら切り捨てて
  untainted にせず、明示した conservative state にする。
- monotone join、bounded fixed point、ループ／再帰に対する終了性を持たせる。
  alias 不完全や未対応 semantics で taint を静かに失わない。
- `js/symbolic/index.js` と既存 evidence projection を通じて消費可能にする。
  result は query/snapshot/model identity と source→value/memory→sink の説明を持つ。
  UI や AI が taint を推論し直す実装は不要・禁止。

最低限の試験: lattice laws、explicit/implicit flow、byte memory、phi/loop/join、
複数 source、known/unknown sanitizer、may-alias store、unknown call、stale identity、
source/sink limits、cancel/replay。memory と taint を別々に試すだけでなく、
**source → symbolic address/partial store → load → control/data use → sink → evidence**
の本番経路を通る integration test を必ず追加する。

## C. 証明付き変換への接続

taint や候補スコアは意味保存の証明ではありません。候補を採用可能とする境界は
既存 verification query/session/eligibility/evidence を使ってください。

- before/after、入力対応、preconditions、width、memory/effect observables、snapshot
  を束縛する。precondition が矛盾している vacuous proof は採用不可。
- 小さい pure Bool/BV について、実 backend が証明した equivalent 候補と refuted
  候補を本番 API から区別する。fake `verified:true` や hash-shaped receipt は不可。
- timeout/cancel/unsupported/missing memory observable/stale proof は no-adoption。
  taint がないことを「消してよい証明」として扱わない。
- 既存 proof consumer へ渡す候補・採用資格までを担当する。
  decompiler transaction/structuring の所有権は別担当なので無断で書き換えない。
  downstream 側に不足する接続があるなら、正確な API と最小の残差を別欄に示し、
  end-to-end decompiler adoption を完了と主張しない。
- #6602 と重なる `verify/equivalence.js` は読み取り専用。既存 judge が不十分なら
  consumer 側で fail closed に保ち、具体的な counterexample を納品する。
  別の equivalence engine を作ったり、欠けた proof を自分で補認定しない。

## 編集範囲

許可: `js/symbolic/executor.js`、`index.js`、必要な
`js/symbolic/memory/**` / `taint/**`、`query/taint.js`、`projection/taint.js`、
新規 `translate/memory.js` とその公開に必要な `translate/index.js` の最小変更、
既存 judge を呼ぶ小さい新規 proof consumer、関連する新規
`tests/phase9/**`、`tests/final-closure/t033/**` / `t034/**`。
既存テストは維持し、新規回帰を加える。必要な変更は対応する契約変更を説明する。

読み取り専用:

- `js/symbolic/solver/**`（T014 候補）、`js/symbolic/verify/equivalence.js` と既存判定器。
- `js/symbolic/expr/**`、`function-sandbox.js`、`translate/semantic-ir.js`、
  `translate/slice.js`、既存 `evidence/**`（上記 concurrent PR と shared authority）。
- `js/decompiler/**`（T011/T012/T013/T017）、ISA/ABI/effects/SSA/MemorySSA/alias/points-to。
- native parser/Apple/discovery/rebuild、AI、runtime、collaboration、UI。
- `tests/final-closure/t011/**`〜`t017/**`、他 lane の既存回帰／固定 oracle。
- CI、package.json/lock、tools/validation、baseline/threshold/denominator、生成物。
- canonical roadmap、campaign spec/tasks/ownership/checklists と旧 evidence。

core Expr/schema/solver 拡張や shared translator の接続が必要な範囲は、本パッチに
混ぜず、既存 consumer・必要な最小 API・反例・invalidation を別担当向け handoff にする。
その依存なしに実行できる executor/memory/taint の本番経路を先に完成させる。
新規 `translate/memory.js` を export しただけなら translator 全体の接続完了とはしない。
一般 array theory や未接続 downstream を含めて T033/T034 全体を DONE と書かない。

## 性能・検証

`specs/005-analysis-final-closure/contracts/performance-locks.json` の
**P-SYMMEM / P-TAINT** を読み、case ID、単位、分母、threshold を変更しない。

- P-SYMMEM: 9ケース。paths≤16、steps/path≤2000、branches≤32、block visits≤3、
  concrete bytes≤65536、symbolic cells≤4096、store history≤4096、alias forks≤16、wall≤250ms。
- P-TAINT: 9ケース。lattice values≤100000、flow edges≤200000、work items≤1000000、
  updates/value≤8、sources/sinks≤4096、emitted records≤100000、phase8OptimizeStage≤120ms。

実際の処理から count/time を収集する。固定値のゼロや自己申告の PASS を出さない。
既存の公式 collector/verifier は改変せず、owned test で測定し統合側への接続情報を残す。
Node 上の経過時間を iPad/WebKit の合格証拠にしない。

実行できるものを、focused → symbolic subsystem の順に実行する。現行
package.json/scripts と tests の runner をコマンド authority とする。
広い実行は `node scripts/run-quiet-command.mjs --label <name> -- <command>` で静かにする。
Phase 9 runner が自動発見する新規 test path に置き、owned-only PASS で終わらせない。
実行可能なら `npm run phase9:test`、関連 Expr/translation/evidence tests、syntax/module
boundary checks を実行する。独立 oracle、browser、全体 CI が使えなければ `NOT RUN`。
ネット／Graft／Spec Kit／実機がないことだけでパッチ作成を停止しない。

## 納品

次の名前でダウンロード可能なファイルを出してください。巨大な全文コードを説明欄で
繰り返さず、**完全なパッチ**を別ファイルにまとめると取り込みが速くなります。

- `002-analysis-symbolic-memory-taint.md`: 簡易仕様・計画・タスク表、実装／未対応、
  最初の反例、API/identity/budget 契約、source→production wiring→test 対応表。
- `002-analysis-symbolic-memory-taint.patch`: 新規ファイルも含む省略なし unified diff。
- 変更後ファイルだけを含む ZIP と、実行ログ・入力/patch SHA-256 manifest。

MEM → TAINT → proof consumer の論理単位を区別し、後段だけの失敗で前段の完成パッチを
失わないようにする。ただし未完成を DONE としない。各単位に exact changed paths、
テストコマンド、件数、PASS/FAIL/NOT RUN、性能実測、外部依存を残す。
可能なら元 ZIP の別展開先にパッチを再適用し、差分範囲と focused test を確認する。
返却先はリポジトリの `Prompt/answer/002-*` です。GitHub push/merge は受け取り側が行います。

最終自己レビュー: 重複 engine なし、全 production wiring、unknown/alias/taint の損失なし、
偽 proof の採用なし、budget/cancel の no-publication、範囲外変更なし。
「だいたいできた」という説明ではなく、実装済みの差分と試験証拠を優先してください。
