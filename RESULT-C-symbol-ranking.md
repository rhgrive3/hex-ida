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
4. `binding` — `global` / `weak` / `gnu-unique` か `local` か
5. `tableIndex` / `index` — parser 自身の record 順（ELF の symbol table index。無い format は unknown）
6. `name` → `source` — 最後の決定的 tie-break

この規則は **name の綴りを一切判定しない**。すべての ELF psABI mapping symbol（AArch64 の `$x`/`$d` 系を含む）は
「local / zero-size / `STT_NOTYPE`」という構造しか持たないので、tier 0 に落ち、callable FUNC/IFUNC や
typed identity には必ず負ける。`$x` 文字列だけを見る場当たり判定は存在しない（`$x`, `$d`, `$x.1`,
`.Ltmp0`, `weird_marker` がすべて同じ結果になることを test で固定した）。

なお `binding` tier と ordinal/name tie-break により、**同 priority の candidate が完全に同点でも勝敗が決まる**
（input order 非依存）。ordinal を先に見るのは、ELF で「symbol table の先頭 entry が勝つ」という従来挙動を
同点時にそのまま保つため。ordinal を持たない format（Mach-O / PE）は name → source で決まる。

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
| `tests/phase4/platform/same-address-symbol-semantic-ranking.test.mjs` | 新規 focused regression（12 test）。 |

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
- **他 format / architecture**: Mach-O / PE の record は `kind` を持ち（`other` / `section` / `function` / `symbol` 等）
  同一 format 内では同一 tier に落ちるため、判断は binding → ordinal → name に委ねられ、address/name が同一の
  重複 entry では結果が変わらない。`tableIndex` / `index` / `symbolIndex` を持たない record は tie-break を
  name/source に委ねる。判定は `kind` / `size` / `binding` の primitive metadata のみを読み、
  provider 由来の structured 値の coercion hook は実行しない（#4739 の非 coercion 契約を維持）。
- **benchmark 固有 hack なし**: CodeFuse の helper 名・address・hash への依存は一切なし。

## 検証

focused（すべて PASS）:

```
node --test tests/phase4/platform/same-address-symbol-semantic-ranking.test.mjs   # 12/12
node --test tests/phase4/binary/issue-8255-aarch64-elf-mapping-symbols.test.mjs   # 4/4
node tests/phase4/platform/issue-4739-analysis-result-name-types.test.mjs
```

`npm run lint`（`tests/check.mjs`）: `syntax lint: 5266 files ok`。

広域 gate は baseline と failure set を diff して新規 failure ゼロを確認（同一 commit `05c93a1c9` の
未変更 `main` worktree `/mnt/workspace/hex-ida` と比較）:

- `npm run phase4:test` — 自分 / baseline とも failure は `tests/phase4/binary/dyld-shared-cache-slide-v5-page-start.test.mjs`
  の 1 件のみ（symbol とは無関係な既存 red）。
- `npm run phase6:test` — 自分 / baseline の failure set が完全一致（13 件、riscv corpus 系の既存 red を含む）。
  `diff` 結果 `IDENTICAL_FAILURE_SET`。

新規 regression はなし。したがってこの lane の所有 surface に新規 failure は導入していない。
