# same-address binary symbol semantic ranking

担当範囲: `js/platform/analysis-result.js`（same-address canonical/display/function identity の選択）。
`main` への merge/push は行っていない。worktree `/mnt/workspace/hex-agent-c` / branch `fix/arch-symbol-ranking`。

## 根本原因

`js/platform/analysis-result.js` の `analysisFromBinaryImage()` は、raw provider が同じ address に
複数 record を出しても `entries` Map で **1 address 1 entry** に collapse する。ところが collapse の
勝敗は `priority` の比較だけで決まっていた。

```js
if (next.priority > current.priority) { ...replace... }   // 同 priority は常に incumbent 勝ち
```

`image.symbols` に由来する record はすべて `priority = 10`（exports = 20 / imports = 30）なので、
**same-address の symbol 同士は必ず同 priority** になり、実質「raw input の並び順で先に出た方の name が
勝つ」実装だった。結果として

- `[LOCAL NOTYPE $x mapping marker, LOCAL STT_FUNC foo]` → canonical name は `$x`
- `[foo, $x]` → canonical name は `foo`

と、`image.symbols` の並び順だけで canonical / display / function identity が反転していた。
`SymbolIndex.exact()` → `nameAt()` はこの 1 件だけを読むため、後段（`js/symbols.js`）では復元できない。

再現（修正前）:

```
mapping-first names: [ '$x' ]            kinds: [ 0 ]
func-first    names: [ 'real_function' ] kinds: [ 0 ]
ORDER_DEPENDENT: true
```

## ranking rule

`priority`（import 30 > export 20 > symbol 10）は **既存 semantics のまま** 先に比較し、
同 priority 内の same-address candidate についてだけ、parser が持つ metadata 由来の total order を追加した。

降順の評価項目:

1. `priority` — 既存の tier 比較（変更なし）
2. `identity` — parser が宣言した identity の強さ
   - `3` callable body（`function` / `indirect-function` / `indirect`）
   - `2` typed data（`object` / `tls` / `common`）
   - `1` その他の宣言済み type
   - `0` 宣言された identity なし（`type-0` = `STT_NOTYPE`、または type metadata 自体が無い）
3. `sized` — `st_size` 等の published extent が正の値か
4. `binding` — link-visible definition（`global` / `weak` / `gnu-unique`）か file-scoped（`local` / 未宣言 / `bind-N`）か
5. `name` → `source` — 最後の決定的 tie-break

**`tableIndex` / `index` は naming の tie-break に使わない**（当初の実装から除去した。理由は次節）。

この規則は **name の綴りを一切判定しない**。すべての ELF psABI mapping symbol（AArch64 の `$x`/`$d` 系を含む）は
「local / zero-size / `STT_NOTYPE`」という構造しか持たないので、tier 0 に落ち、callable FUNC/IFUNC や
typed identity には必ず負ける。`$x` 文字列だけを見る場当たり判定は存在しない（`$x`, `$d`, `$x.1`,
`.Ltmp0`, `weird_marker` がすべて同じ結果になることを test で固定した）。

`name` → `source` の tie-break により、**同 priority の candidate が完全に同点でも勝敗が決まる**（input order 非依存）。
同点時の勝者は「record 自身の内容」だけの関数であり、file 内の位置には依存しない。

## `tableIndex` / `index` を canonical-name tie-break に使わない理由（再検討の結論）

当初の実装は `binding` の次に `tableIndex` → `index` を見ていた。これを **不適切** と判断し除去した。

- `tableIndex` / `index` は parser が解釈した「symbol table の物理位置」そのものである
  （`js/binary/elf-core-original.js`: `index: i, tableIndex: table.index`）。
- さらに `BinaryImage.finalize()` は `this.symbols.sort(byAddr)`（stable sort, `js/binary/model.js`）を行うため、
  **same-address の record は物理 table 順のまま ranking に到達する**。つまり ordinal 比較は
  実質「symbol table の先頭 entry が勝つ」= file layout 依存であり、この lane が消そうとしている欠陥
  （raw 入力順で canonical name が変わる）を 1 層下に作り直すだけだった。
- 実際に識別力を確認した: 完全同点の alias 2 件（同一 section offset / 同一 `st_size` / 両方 global `STT_FUNC`）
  を含む ELF fixture の `.symtab` の物理順を入れ替えると、ordinal 版では canonical name が反転し、
  現行版では反転しない（test で固定）。
- 一方 ordinal は **identity key** としては正当であり、その用途は維持している（relocation の symbol 解決
  `symbolsByTable` / `${tableIndex}:${index}`）。同じ値を「どの record か」の同定と「どの name を表示するか」に
  流用しない、という切り分けである。

同点時の `name` 選択は綴りの順序（lexicographic）で決める。identity / extent / binding がすべて同点な候補は
parser から見て区別不能な alias（同一 address・同一宣言 kind・同一 extent・同一 linkage）であり、
残る唯一の差分が綴りだからである。

## `GLOBAL` / `WEAK` / `GNU_UNIQUE` を同 rank にする根拠（再検討の結論）

結論: **同 rank のまま**（binding は「link-visible definition か file-scoped か」の 2 段のみ）。分離しない。

- weak は *link-time* の規則（「同名の strong 定義が override する」）である。image を記述する時点で link は
  終わっており、override しに来る第 2 の定義は存在しない。最終 image に残った weak 定義は定義そのものであり、
  weak bit は「どちらの name が canonical か」を何も語らない。
- 分離すると **著者側の idiom が表示名を決めてしまう**。glibc の `weak_alias (__printf, printf)` は
  strong `__printf` と weak `printf` を同一 address に置く。strong/weak で順序付けると public な綴り
  （`printf`）が internal 名（`__printf`）に降格する。これは layout/authoring artifact がユーザー可視 name を
  決めることであり、この lane が除去しようとしている欠陥と同じ class である。
- `STB_GNU_UNIQUE` は process-wide unique な定義で、preemption の意味では global より強いが naming の意味では
  等しい。`STB_GLOBAL` の上下に置く規則はいずれも naming の根拠を持たない。
- naming 上の意味を持つ唯一の分割は **file-scoped か link-visible か** であり、これは ELF reader が既に
  公開している linkage 概念（`externallyVisible = bind === 1 || bind === 2 || bind === STB_GNU_UNIQUE`）と一致する。
  `bind-N`（OS/processor-specific）も reader の同概念に合わせて file-scoped 側に置く。

この判断は test で固定した（3 binding すべてが local に勝つ / 3 binding 間の全 pair で binding が勝敗を決めない /
`bind-N` は local と同じ tier）。

## normalization layer で直す理由

- same-address candidate loss は `SymbolIndex.exact()` より **前**（`entries` Map への collapse 時点）で
  起きている。`js/symbols.js` 側には raw candidate が 1 件しか届かないため、後段修正では情報が既に失われている。
- `analysisFromBinaryImage()` はこの repo における binary raw metadata → canonical analysis transport の
  **正規化層**であり、`addrs` / `names` / `kinds` / `flags` / `nameProvenance` という下流すべての唯一の供給元。
  ranking をここに置けば、consumer 側の意味論を 1 か所で決定的にできる。
- raw layer は触らない。`image.symbols` の record、`metadata.aarch64MappingSymbols`、`metadata.riscvIsa`、
  `image.dataInCode` はすべて parse 時のまま保持される（変更は naming projection だけ）。

## 変更ファイル

| file | 変更 |
| --- | --- |
| `js/platform/analysis-result.js` | same-address candidate の semantic ranking を追加（pure function 追加 + `add()` の勝敗判定を差し替え）。raw record は不変。 |
| `tests/phase4/platform/same-address-symbol-semantic-ranking.test.mjs` | 新規 focused regression（18 test。順序非依存 / 完全同点 alias / ordinal 不参照 / binding rank を含む）。 |

`js/binary/**` の symbol / mapping metadata 層は **変更なし**（必要性が無かった）。

## permutation test

`tests/phase4/platform/same-address-symbol-semantic-ranking.test.mjs`:

- `raw symbol order is irrelevant: every permutation yields one canonical name`
  — `[$x, real_function(local), alias_name(global), weak_alias(weak)]` を 4 通りに rotate し、
  `names` / `addrs` / `kinds` / `flags` / `nameProvenance` が完全一致することを assert。
  さらに reverse でも一致することを assert。
- `the ranking never keys off the marker spelling`
  — marker 名を `$x` / `$d` / `$x.1` / `.Ltmp0` / `weird_marker` と変え、順序も入れ替えて
  常に `real_function` が勝つことを assert（name pattern 非依存の証明）。
- `AArch64 ELF: permuting the raw symbol table cannot change the canonical identity`
  — 実 ELF fixture を `parseELF()` し、`image.symbols` を 4 通りに rotate / marker-first に再構成しても
  canonical name が `foo` のままであることを assert。
- `mapping marker first and FUNC second …` / `FUNC first and mapping marker second …`
  — 順序 2 通りの canonical display name / function name が同一であることを assert。

**完全同点 alias（semantic evidence がすべて同じ）に対する物理 symbol-table 順の test**:

- `parser record ordinals are never consulted as naming evidence`
  — 同一 address・同一 kind・同一 size・同一 binding の 2 record に `index` / `tableIndex` を振り、
  layout 順と name 順が矛盾する配置でも常に name 順の勝者になることを assert。
- `AArch64 ELF: fully tied global aliases keep one canonical name under every physical table layout`
  — 実 ELF fixture の `.symtab` entry 順を入れ替えて 2 通りの file を生成。
  `index` が実際に 1/2 → 2/1 と入れ替わっていること（物理順が本当に変わったこと）を先に assert したうえで、
  `names` / `addrs` / `kinds` / `flags` / `nameProvenance` が完全一致することを assert。
- `AArch64 ELF: a three-way tied alias set agrees under every rotation and the reversed table`
  — 3 件同点 alias で 3 rotation + reverse の全 layout が同一の（かつ決定的な）name に収束することを assert。
- `AArch64 ELF: rebuilding .symtab with foo before the marker keeps mapping authority and the same identity`
  — 実 `.symtab` の物理順を `$x`-first → `foo`-first に再構築しても canonical name と mapping authority が不変。

**binding rank の test**:

- `declared non-local bindings share one naming tier: global, weak and gnu-unique are not ordered`
- `an OS/processor-specific binding stays file-scoped, matching the reader externallyVisible notion`

## existing mapping tests

意味を弱めずに全通過:

- `tests/phase4/binary/issue-8255-aarch64-elf-mapping-symbols.test.mjs` — 4/4 PASS
  （`$x`/`$d` の section-scoped code/data authority、`dataInCode` による region exclusion、
  raw program scan の BL 抑制/fallback、`$d` 内 authoritative seed の保持）。
- `tests/phase4/platform/issue-4739-analysis-result-name-types.test.mjs` — PASS
  （structured name の非 coercion、symbol/export/import priority、merge、export flag、provenance）。
- RISC-V mapping 系も回帰なし: `issue-5684-riscv-mapping-identity`、`issue-4091-riscv-mapping-symbol-contract`、
  `issue-4888-riscv-elfclass-xlen-mismatch`、`issue-5990-riscv-identity-string-coercion`、
  `issue-4084-riscv-elf-isa-canonical-exact-evidence`、`issue-4074-elf-riscv32-isa-attributes` — 全 PASS。

## compatibility

- **raw mapping symbol 削除なし**: marker の record は `image.symbols` に残る（test で symbol 件数を assert）。
- **`aarch64MappingSymbols` / `dataInCode` semantics 維持**: `metadata.aarch64MappingSymbols` は object 同一性ごと不変、
  `dataInCode` entry も不変、`isInstructionAllowed()` の `$d` exclusion も不変、
  `describeBinaryImage()` の region `dataInCode`（`ELF_AARCH64_MAPPING_DATA`）も不変。
- **export/import priority 維持**: import(30) > export(20) > symbol(10)、
  下位 tier の `exported` bit も従来どおり merge。
- **mapping symbol だけの control case**: 唯一の candidate なら canonical name は従来どおり marker 名（`$d`）。
- **input order 非依存**: 上記 permutation test で固定。
- **他 format / architecture**: Mach-O / PE の record は `kind`（`symbol` / `function` / `other` 等）と
  `binding` を持ち（PE は `COFF`: `storage === 2 ? 'global' : 'local'`）、ELF と同じ tier で評価される。
  同一 format 内で同点なら name → source で決まる。`tableIndex` / `index` / `symbolIndex` は **どの format でも
  naming には読まない** ため、layout 順を持つ ELF と持たない Mach-O / PE で規則が揃う。
  判定は `kind` / `size` / `binding` の primitive metadata のみを読み、
  provider 由来の structured 値の coercion hook は実行しない（#4739 の非 coercion 契約を維持）。
  Mach-O 側の既存 contract test（`tests/phase4/binary/issue-8170-macho-dysymtab-indirect-sites.test.mjs`）も PASS。
- **benchmark 固有 hack なし**: CodeFuse の helper 名・address・hash への依存は一切なし。

## 検証

focused（すべて PASS）:

```
node --test tests/phase4/platform/same-address-symbol-semantic-ranking.test.mjs   # 18/18
node --test tests/phase4/binary/issue-8255-aarch64-elf-mapping-symbols.test.mjs   # 4/4
node tests/phase4/platform/issue-4739-analysis-result-name-types.test.mjs
```

`npm run lint`（`tests/check.mjs`）: `syntax lint: 5266 files ok`。

新規 test は無効でないことを確認した。上記の順序非依存 test 3 本（ordinal 不参照 / 完全同点 alias 2 通り / 3 件 rotation）は
**ordinal tier を戻した旧実装（`f24ef441c`）では実際に fail する**（`18 pass` → `15 pass / 3 fail`）。
つまり physical symbol-table 順依存の再発を恒久的に検出する。

phase4 suite への組み込みは `tests/phase4/run.mjs --group platform/same-address-symbol-semantic-ranking` で確認
（`phase4: PASS (1/404 discovered test files)`, independent verification oracles も pass）。

広域 gate は **同一 base SHA の detached baseline worktree** `/mnt/workspace/hex-agent-c-baseline`
（`05c93a1c9`、未変更）と failure set を diff。

- `npm run phase4:test` — 自分 / baseline とも failure 1 件のみで `diff` は空（`IDENTICAL_FAILURE_SET`）。
  既存 red は `tests/phase4/binary/dyld-shared-cache-slide-v5-page-start.test.mjs`（symbol とは無関係）。
- `npm run phase6:test` — 13 件で `IDENTICAL_FAILURE_SET`（riscv corpus / backend-route 系の既存 red）。
- `npm run semantic-v2:test` — 6 件で `IDENTICAL_FAILURE_SET`（#4534 / C4 / x86 系の既存 red）。
- `npm run module-boundaries:test` / `npm run evidence-writers:test` — PASS。
- `npm run lint`（`tests/check.mjs`）— `syntax lint: 5266 files ok`。

`npm run check`（canonical gate）は本 worktree では完走できない。`node_modules` が無いため `esbuild` で落ちるので
`/mnt/workspace/hex-ida/node_modules` を symlink して再実行すると、`[invariant-gate] machine-effects-contract` が
`missing llvm-mc LLVM 18` で fail する。**同一条件の baseline（未変更 `05c93a1c9`）でも同じ箇所で同じ fail** であり
（`diff` は空）、toolchain 前提の環境要因であって本変更によるものではない。
その手前の `invariant-gate` 群は PASS（`invariant-contracts: PASS`、`import-boundaries: PASS
(68 generic entrypoints checked, 85 architecture entrypoints checked)`、`architecture-boundaries (INV-005)` を含む）。

新規 regression はなし。したがってこの lane の所有 surface に新規 failure は導入していない。
