# 001 — T016: discovery を保持する rebuild 連携の実装候補

## 1. 実装範囲と入力

既存の `createRebuildTransaction → materializeRebuildTransaction → validateRebuildTransaction → publishRebuildTransaction` に discovery 保存検証を接続した。別の transaction engine／parser／同値性証明器は追加していない。canonical artifact、typed identity、fusion、producer、`verifyDiscoveryReparse` の実装は変更していない。

**対応範囲**は、discovery 必須に分類された transaction のうち、production parser が完全な artifact を生成でき、unsigned な入力に対する既存の固定長 metadata 変更（`elf-comment`、`pe-timestamp`、`macho-min-version`）で、既存 `validateFormatSafeMutation` と canonical 保存比較の両方に合格するもの。ELF64、Mach-O64、PE32、PE32+ の既存 compiler fixture を使用し、実際に bytes を変更してファイルへ commit／readback する正常系を実行した。

**unsupported／rejected** は、他の変換、layout moving、サイズ変更、署名済み入力、parser の partial／unsupported／warning・budget 停止、保存できない discovery、長さ・identity 不一致、cancel／deadline、readback 不在・不一致。artifact が表現できる unknown や未解決の曖昧さと、parser／artifact 全体が不完全であることは区別する。前者を保持した往復は成功できるが、後者を完全な証拠として採用しない。

### 入力 identity

入力は添付 **PR head ZIP** `hex-ida-docs-astra-semantic-review-orders-20260905.zip`。main の取得・差し替えは行っていない。

```text
ユーザー提示 WIP commit: 5eb62e32f9c0062da69a4e040fe1d52fb303ecbf
ユーザー提示 tree:       00ede08a2811a8f4ef329cde19aefc66ff328587
入力 ZIP SHA-256:       452fc4958c857c43bc1f0ae27e299b836c2b17631a02c1fb3c043e731d1a2093
```

ZIP に Git 履歴がなく、提示 commit／tree との一致は**未検証**。差分生成用のローカル index は作成したが、その identity を提示 SHA の証明には使用していない。ZIP コメントも commit の検証証拠として扱っていない。

`AGENTS.md`、`docs/ENGINEERING_PROCESS_GUARDRAILS.md`、関連仕様と実装を読み、次の **3 ファイルのみ**を変更した。

| ファイル | 内容 |
|---|---|
| `js/rebuild/transaction-v2.js` | 本番経路への接続、発行 identity、bounded readback |
| `tests/final-closure/t016/rebuild-integration.test.mjs`（新規） | 52 件の本番経路・拒否境界回帰 |
| `tests/final-closure/t016/canonical-reparse.test.mjs`（新規） | 6 件の canonical 比較境界回帰 |

元 ZIP の既存 2,526 ファイル中、transaction 本体以外の **2,525 ファイルは byte 一致**。`tests/stage2/**`、`format-safe.js`、registry、CI、tools、profiles、thresholds、生成物、campaign specs/status は無変更。

## 2. 最初の counterexample と修正した boundary

### 実装前に失敗を確認した境界

最初に実 ELF fixture を使う 1 件のテストを作成し、`requireDiscoveryPreservation: true` を指定して、materialize／validate の後に identity-shaped receipt だけを返す promoter を渡した。`readCommitted` は渡さなかった。

```js
const { materialized, validation } = await prepare();
let promotions = 0;
const publication = await publishRebuildTransaction(materialized, validation, {
  atomicPromote: async (_bytes, { materialized: m }) => {
    promotions += 1;
    return receipt(m);
  },
});
assert.equal(publication.status, 'not-published');
assert.equal(publication.reason, 'rebuild-v2-discovery-readback-required');
assert.equal(promotions, 0);
```

変更前は **actual=`published`、expected=`not-published`** で失敗した。実行当時の結果は `evidence/01-counterexample-before.log`（1 件中 1 FAIL）。修正後の同じ境界は PASS（`02-counterexample-after.log`）。今回修正した最初の境界は、discovery の検証義務が transaction identity に入らず、publication が writer の receipt のみを信じていた点である。

自己レビューでは、abort と deferred adapter 呼び出しの間の race も failing test で確認した。Promise race が拒否されても未実行の callback が実行され得たため、deferred invocation の直前にも control を確認するよう修正した。red／green を `08`／`09` のログに保存した。

### Identity contract と互換性

factory 入力の次のいずれかで discovery 必須とする。

| 分類条件 | 規則 |
|---|---|
| explicit opt-in | `requireDiscoveryPreservation === true` |
| 引継ぎ contract | `discovery != null` |
| artifact／binding | `discoveryArtifact`、`discoveryBinding`、`expectedOriginalState.discovery` のいずれかが non-null |
| 明示された影響 | transaction または operation の `impact.discovery === true` |
| 追加 validator | `additionalValidators` に `discovery-preservation` が含まれる |

他の条件で必須になっている場合、caller の `requireDiscoveryPreservation: false` は解除にならない。artifact は既存 canonical factory により検証し、binding は `isFactoryIssuedDiscoveryRebuildBinding` による発行確認と binary/source/snapshot/architecture の照合を行う。hash-shaped string や public な `complete`／`verified` は authority にしない。

必須 lane は `sourceLength` と `snapshotId` を必要とする。snapshot は正規 binding からも引き継げる。immutable な `transaction.discovery` に required、scope、parser identity、snapshot、source/output length、上限、外部 supplied artifact ID を束縛し、required validator set に `discovery-preservation` を追加する。

transaction、materialization、validation は private WeakMap で発行・相互対応を管理する。materialization は実際に解析した source binding と非公開の source/output byte snapshot を保持する。validation はその **同一 materialization** に結び付く。publish は digest の自己整合性だけでなくこの発行関係を確認するため、cloned／forged／stripped object や、同じ transaction ID と output hash を持つ別 materialization の stale receipt を受け付けない。

**互換性の適用範囲:** discovery 未分類の既存 factory 経路には、新 validator／fresh discovery parse／readback を追加しない。一般的な `layoutMoving`、relocation 等の既存 flag だけで全 transaction を必須 lane に移していない。一方、strip した receipt を legacy receipt と区別するため、実行に使用する object の発行確認は両 lane に適用した。**既存の factory 呼出し順は維持するが、JSON・structuredClone・spread 等で複製した execution object をそのまま実行する用法は非対応となる。** 必要なら同一 realm で factory から作成し直し、materialize／validate もやり直す。

この保証は「発行された transaction の処理途中で必須検証を外せない」という範囲であり、discovery の分類を一切渡さず別 transaction を新規作成する caller policy 全体を推測・強制するものではない。その新規定義に既存 receipt を流用することはできない。

### 本番 parse と conservative な保存

source の実長を先に確認し、owned bytes にコピーして既存 byte hash を計算する。その値が transaction の `sourceHash` と一致することを確認してから、`openBinary` と production `functionCandidates` を呼び出す。binary ID／snapshot は transaction の指定に、architecture は parser の観測結果にも照合する。caller の関数一覧や image／metadata は解析入力の代わりに使用しない。

output は materialization の非公開 byte snapshot を **fresh `openBinary`** で読み直す。source と output の比較、および supplied source artifact と fresh source artifact の照合は、いずれも既存 `verifyDiscoveryReparse` に委譲した。output 用 snapshot は `rebuild-reparse:${materialized.outputIdentity}` とし、変更後の sourceHash／artifact ID／digest の差そのものを意味喪失とは扱わない。

固定長であるだけでは許可しない。canonical 保存比較に加えて、読み取り専用の既存 `validateFormatSafeMutation` を内部から呼び、実際の変更箇所・構造が対応範囲であることを検証する。public な unsigned claim ではなく source bytes の signature state も確認する。既存 transaction が要求する independent oracle 等の validator は外さない。

parser metadata の completeness は **自身の fresh parse が返した観測値**のみを用いる。warning、metadata の reasons、既知の symbol/relocation 停止、dynamic/unwind/import/exception の不完全状態、discovery/fusion/artifact budget 不足を成功扱いしない。

### Publication/readback contract

既存 `atomicPromote(bytes, { materialized, validation })` の receipt contract は維持し、discovery 必須 lane にだけ以下を追加した。`readCommitted` は commit 後の対象を開く callback であり、ByteSource 互換の `size` と bounded `read` を返す。

```ts
// 説明用の型。別 API engine や TypeScript ファイルの追加ではない。
type ReadbackRequest = Readonly<{
  publicationIdentity: string;
  transactionId: string;
  outputHash: string;
  outputIdentity: string;
  expectedLength: number;
  maxBytes: number;
  signal?: AbortSignal;
  deadline: number; // epoch milliseconds
}>;

type CommittedSource = {
  readonly size: number | bigint; // committed object 全体の実長
  read(offset: bigint, length: number, limits: ReadbackRequest):
    Uint8Array | Promise<Uint8Array>;
};
// options.readCommitted(request): CommittedSource | Promise<CommittedSource>
```

実行順は以下のとおり。

1. `readCommitted` の存在を **atomicPromote より前**に確認する。なければ `not-published` とし promoter を呼ばない。
2. promoter の atomic protocol と transaction/output/publication identity を照合する。
3. committed source の `size` が expected N に等しく、固定上限 **16 MiB** 以内であることを確認してから `read` を取り出す。`read(0n, N, request)` の前に N−1／N+1／過大サイズを拒否する。
4. read 後に source の `size` を再確認し、返された raw bytes 自体の実長も N／上限に照合する。TypedArray 等では intrinsic byteLength を使用する。不一致を copy、`Array.from`、hash より前に拒否する。SharedArrayBuffer-backed bytes は非対応。
5. 非公開の fresh-parser 検証済み output bytes と完全一致したときだけ `published` とする。出力を同じ object のまま往復させたことや、promoter の hash/boolean は読返しの代替にならない。

readback は型としては byte sequence を返せるが、**adapter は `publicationIdentity` が指す実際の committed storage を読み、writer に渡された buffer や cache を返してはならない**。この origin と immutable/stable read は adapter の信頼境界であり、任意の虚偽 callback から storage の真正性を証明する機構ではない。実正常系テストでは実ファイルへの write／rename／stat／bounded read／再 stat を使っている。

signal と deadline は各段階・await 前後で確認する。deadline は各段階の開始から最大 10 秒で、caller は短縮できるが延長できない。停止を伝えない never-resolving callback も成功にはならない。readback 失敗・cancel・deadline 等を commit 後に検出した場合は `commitState: 'unverified'` として返し、valid/published とはしない。ただし外部 storage の変更を自動 rollback するものではなく、キャンセル非対応の adapter の副作用を必ず停止できる保証もない。同期 parser/hash は呼出し途中には preempt せず、戻った時点で期限を確認する。

## 3. 全変更の unified diff

全変更は同梱の **`001-t016-rebuild-implementation.patch`** に収録した。新規テスト 2 ファイルを含み、省略部分はない。

```text
js/rebuild/transaction-v2.js                       | 331
.../t016/canonical-reparse.test.mjs                |  96
.../t016/rebuild-integration.test.mjs              | 459
3 files changed, 873 insertions(+), 13 deletions(-)

patch SHA-256:
df4f7ffab9008ed5fb1d881cf14657d2e6384669bebd7c2280112040c65980f7
```

ZIP のルートディレクトリへ移動して適用する。

```sh
git apply --check /path/to/001-t016-rebuild-implementation.patch
git apply /path/to/001-t016-rebuild-implementation.patch
```

別のクリーンな ZIP 展開先で check／実適用し、変更 3 ファイルが作業版と byte 一致すること、その展開先でも focused tests が 101/101 PASS することを確認した。納品 bundle 内の `js/`、`tests/` はパッチ適用後の変更ファイルのみ。入力 repo 全体や生成物は含めていない。`Prompt/answer/` は本回答資料であり、実装パッチの変更範囲には含めていない。

## 4. 実行した試験・結果・残る依存

実行環境: Node.js **v22.16.0**。日時: 2026-09-05。PASS は実測結果のみ。

| 検証 | 実測結果 | ログ |
|---|---|---|
| 変更前の既存 discovery + T016 preservation | 43/43 PASS | `00-baseline-discovery.log` |
| 最初の counterexample、実装前 | 0 PASS / 1 FAIL、receipt のみで published | `01-counterexample-before.log` |
| 同境界、修正後 | 1/1 PASS | `02-counterexample-after.log` |
| abort-before-dispatch の追加 red/green | 修正前 FAIL、修正後 PASS | `08`、`09` |
| 最終 focused tests | **101/101 PASS**、TAP 1,830.661 ms、wall 1.864 s | `14-final-focused.log` |
| 無変更 Stage2 transaction | PASS、wall 0.066 s | `15-stage2-final.log` |
| 無変更 Stage2 proof helper を直接呼出し | ELF/Mach-O/PE の 3 形式 PASS | `10-unchanged-stage2-helper.log` |
| phase12 rebuild plan | PASS、wall 0.040 s | `16-phase12-plan.log` |
| module-boundaries policy / unit tests | PASS | `12`、`17` |
| syntax lint | 2,084 files OK、wall 0.496 s | `18-final-lint.log` |
| clean ZIP へ patch 再適用後 focused tests | **101/101 PASS**、TAP 1,606.941 ms | `20-patch-reapply-focused.log` |
| `git diff --check` / `git apply --check` | PASS | scope manifest と本回答 |

### 再実行コマンド

```sh
# 変更前に実行した既存 43 件
node --test tests/final-closure/t016/discovery-preservation.test.mjs \
  tests/phase7/discovery/*.test.mjs

# 変更後の既存 43 件 + 新規 58 件 = 101 件
node --test tests/final-closure/t016/*.test.mjs tests/phase7/discovery/*.test.mjs

# 無変更の既存正常系／関連検証
node tests/stage2/rebuild-transaction.test.mjs
node tests/phase12/rebuild/plan.test.mjs
node tests/module-boundaries.mjs
node tools/validation/module-boundaries.mjs
node tests/check.mjs
git diff --check
```

Stage2 helper は、aggregate test の別 ownership の import 障害と切り離し、次のように **元ファイルを変更せず**呼び出した。

```sh
node --input-type=module <<'JS'
import { validatedRebuildSupportFixture } from './tests/stage2/helpers/rebuild-proof-fixture.mjs';
import { validatedCapabilityProofFixture } from './tests/stage2/helpers/profile-proof-fixture.mjs';
const { proofs } = validatedCapabilityProofFixture();
for (const format of ['elf', 'macho', 'pe']) {
  await validatedRebuildSupportFixture(format, proofs[`S2-F6-${format.toUpperCase()}`]);
  console.log(`[PASS] unchanged validatedRebuildSupportFixture(${format}): materialize/validate/atomic publication`);
}
JS
```

### 要求との対応と証拠の範囲

| 要求 | 追加／既存テストで確認した境界 |
|---|---|
| 1. 本番 source→fresh output→publish/readback | 実 ELF 正常系と manifest SHA-256 照合付き ELF64/Mach-O64/PE32/PE32+ 4 fixture。変更後 bytes を実ファイルへ atomic rename し読み返す |
| 2. 同じ collision IDs でも unknown→exact を拒否 | 非空 collision ID 集合が同じ neutral corpus の canonical regression。既存 unknown-only negative も無変更で PASS |
| 3. conflict/reference/interval 欠落、identity 不一致 | code/data conflict、relocation expression、独立 interval 欠落の canonical regression。実 parser と supplied artifact の不一致、binary/source/snapshot/architecture の不一致、実 ELF entrypoint 証拠の消失も拒否 |
| 4. false／forged／cloned／stale | 全 activation 経路の false override、binding 発行、stripped/rehash transaction、clone validation、別 materialization の stale receipt を拒否 |
| 5. writer-success でも不正 output を拒否 | malformed bytes、output architecture 不一致、caller の fake parser metadata、committed bytes 不一致、callback による materialized bytes 改変を拒否 |
| 6. readback と資源・中断 | readback 不在、source/stat/raw の N−1/N+1/過大、read 前 poison、resize、偽 receipt/bytes、source/output 各 budget、各段階 cancel/deadline、未解決 promise、矛盾した success/status を拒否 |
| 7. 非 discovery 互換性 | Stage2 transaction positive と proof helper 3 形式を無変更で PASS |

canonical corpus 試験は比較 authority の局所試験であり、人工 image を実 parser 証拠とは主張していない。本番往復試験はそれと別に実 bytes／fresh parser／実 storage を使用する。新規本番試験では **discovery contract の検証に限定するため independent oracle を要求しない transaction を作成**しているが、既存 format validator は実物を使う。LLVM receipt は偽造せず、既存 denominator／oracle／固定 test も変更していない。この 101 件は **F6 全体や LLVM differential の合格証拠ではない**。

### 実行したが失敗した統合試験

```sh
node tests/stage2/capability-promotion.test.mjs
```

修正後 ZIP と **未変更の元 ZIP の両方**で exit 1。最初の境界は次の import/export 不整合だった。

```text
js/collaboration/remote-authority.js:3
SyntaxError: The requested module './index.js' does not provide an export named 'canonicalizeProjectOperation'
```

`06-capability-promotion.log` と `13-baseline-capability-promotion.log` に保存。該当 collaboration module は別 ownership のため無変更。必要最小の別担当作業は、`remote-authority.js` の import と `collaboration/index.js` の公開 export の責務・整合を確認すること。正しい export 元／公開方針を推測して本パッチに含めてはいない。aggregate の PASS は主張しない。

### NOT RUN

LLVM availability probe は `available: false`、`independent-oracle-tool-unavailable`。要求される `Ubuntu LLVM version 18.1.3` の `llvm-readobj` が利用できなかった。

以下は **NOT RUN**: `tests/phase12/rebuild/f6-real-fixtures.test.mjs`、`f6-pe-layout-cell.test.mjs`、`f6-macho-layout-cell.test.mjs`、全体 npm test/check、全 campaign verifier、CI、生成物の再生成・照合、browser／実機。今回の scope 外の layout cells を実装済みと扱っていない。GitHub 操作、CI approval、main merge は行っていない。

## 5. Trade-off と採用前の確認事項（5 件）

1. **分類を接続する caller:** 今回の patch だけで未分類 caller が discovery 必須になるわけではない。読み取り専用の `createFormatSafeRebuildTransaction` は新オプションの forwarding をしないため、現行 caller は下記のように `createRebuildTransaction` で opt-in できる。既存の oracle／追加 validator は必ず保持する。wrapper に直接オプションを渡す API が必要なら、その first boundary は `js/rebuild/format-safe.js` の入力 forwarding であり、別 ownership に `requireDiscoveryPreservation`、`sourceLength`、`snapshotId`、必要な canonical binding の最小 forwarding を依頼する。本パッチにその変更は含めていない。
2. **発行 object の寿命・互換性:** receipt は同一 JS realm 内で発行から publish まで保持する。cross-worker／serialization／clone された execution object の受入れは非対応。通常の既存 factory flow と readback なし legacy positive は確認済みだが、受け取り側の実 caller にそのような serialize／restore がないか確認する。discovery lane の publication `result` は adapter の任意 payload 全体を clone せず、検証した identity 部分だけに限定する。
3. **狭い意味保存範囲:** unsigned の固定長 metadata 3 種類に限定し、未対応変換や不完全 parser は保守的に拒否する。sourceHash の変化は許すが、canonical projection が示す曖昧さの喪失は許さない。将来の layout 変換、partial parse の受入れ、追加 parser metadata の扱いは今回の成功証拠から一般化しない。
4. **storage と停止の境界:** adapter は実 committed object を安定して bounded read し、全長を正しく返す必要がある。readback 失敗後に既存 commit を rollback する機能はない。caller は `unverified` を valid と公開してはならず、停止非対応の非同期 adapter／同期 parser の中断限界も確認する。
5. **採用時の統合証拠:** 提示 SHA/tree と実採用 head の照合、既存 oracle 要求を残した LLVM 18.1.3 differential、collaboration import 障害解消後の aggregate、必要な生成物／CI／実機検証は受け取り側で行う。今回の候補 patch と focused PASS だけでは roadmap／F6／main merge の Done 判定をしない。

既存 wrapper を変更しない opt-in の例:

```js
const planned = createFormatSafeRebuildTransaction(existingInput);
const transaction = createRebuildTransaction({
  ...planned,
  // planned.requireIndependentOracle も spread で保持する。
  additionalValidators: planned.requiredValidators,
  requireDiscoveryPreservation: true,
  sourceLength: source.byteLength,
  snapshotId,
});
// 既存 format validator と独立 oracle を維持して materialize/validate する。
// publish 時は実 storage adapter の readCommitted を追加する。
```

本回答、完全な patch、変更後 3 ファイル、red/green と最終試験ログ、source/patch SHA-256 manifest を納品 bundle に含めた。
