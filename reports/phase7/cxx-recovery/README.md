# C++ high-level recovery for game binaries — audit, implementation, measurement

Scope: raise the amount of *meaning* recoverable from a game ARM64 binary —
`obj->vtable[slot](obj, ...)` instead of an unknown indirect call, and
`this->field_38 /* float */` instead of `*(x + 0x38)` — without inventing a
second type system and without a heavy global pass.

Status: **investigation complete for Phases 1–3 and the measured part of
Phase 4.** This is not a master-phase cutover; see
[Phase status](#8-phase-status) and
[Process notes](#9-process-notes-and-what-is-not-done).

- Measurement artifact: [`measurement.json`](./measurement.json)
- Machine-readable taxonomy: [`taxonomy.json`](./taxonomy.json)
- Regressions: `tests/phase7/cxx/{rtti-evidence,virtual-dispatch,member-types,projection,analysis-seam}.test.mjs`
- Measurement script: `tools/validation/phase7/cxx/measure-cxx-recovery.mjs`

---

## 1. What already existed on `main` (audit before writing code)

The repository already had a substantial C++ layer. Nothing here duplicates it;
every new module consumes or feeds these.

| Component | Path | What it owns |
| --- | --- | --- |
| Canonical C++ object evidence types | `js/analysis/cxx/object-evidence.js` | `CppClassIdentity`, `CppVtableEvidence`, `CppReceiverEvidence`, `CppVirtualSlotEvidence`; canonical-identity WeakSets; the `closureProven` rule |
| RTTI / demangler / vtable byte reader | `js/rtti.js` | Itanium demangler, `findCxxClasses` (symbol-only), `readVtable` (bytes → slots), chained-pointer/ILP32 handling |
| Decompiler evidence projection | `js/decompiler/cxx-evidence.js` | Validates canonical receiver/slot evidence against the live IR and function identity; `isCppReceiverAlias` |
| `this` / field projection | `js/decompiler/semantic-core.js`, `pipeline-core.js`, `types/high-variables.js`, `type-recovery.js` | `this->field_38` rendering, `fieldFor` hook, argument-0 naming |
| Aggregate layout | `js/decompiler/types/layout.js` | Groups accesses by base, array detection, per-field `size`/`type` |
| Class UI | `js/tools-base.js` (`showCxxClasses`, `showVtable`) | User-facing class/vtable listing |

Two facts from the audit drive the work:

1. `extractCppObjectEvidence` (the Phase 7 producer) has **no production
   caller** — only tests. Nothing in the analysis pipeline builds
   `cxxEvidence` from a real binary, so the decompiler projection is reachable
   only when a caller hand-builds canonical evidence.
2. Class/vtable discovery is **symbol-only**. `findCxxClasses` requires
   `_ZTV`/`_ZTI`/`_ZTS` symbols, and `readVtable` is called with a fixed slot
   cap, so it reads past the table end into the neighbouring object. Neither
   parses a `typeinfo` record, so there is no inheritance and no RTTI-present /
   RTTI-absent distinction.

## 2. Taxonomy of `main` capability, binary-grounded

Measured with `tools/validation/phase7/cxx/measure-cxx-recovery.mjs` over three real clang-produced
ARM64 ELF fixtures (see [§4](#4-fixtures-real-binaries-not-hand-written-bytes)).
`taxonomy.json` carries the same table.

| Capability | State on `main` | Evidence |
| --- | --- | --- |
| Object / `this` recognition | **partial** | Producer exists and fails closed, but has no production caller; receiver binding is never derived from a real binary |
| Vtable discovery | **partial** | Symbol-driven only (`_ZTV*`). Stripped binaries and unsymbolised vtables are invisible |
| Vtable slot enumeration | **unsafe to infer** | Fixed slot cap over-reads: 64 slot entries enumerated across 8 symbol-derived tables that hold 20. 12 of them resolve to `_ZTI`/`_ZTV`/`_ZTS` symbols, i.e. provably *not* methods |
| RTTI discovery (`typeinfo` record parse) | **missing** | `_ZTI` addresses are used as labels only; never parsed |
| Class-name association | **partial** | From `_ZTV`/`_ZTS` symbol demangling. No name is derived from a typeinfo string, so a stripped-but-RTTI binary yields nothing |
| Inheritance (base / derived) | **missing** | `__si_class_type_info` / `__vmi_class_type_info` base arrays are unread |
| Virtual method slot → target | **partial** | Slot *address* is resolved; merged (folded) methods collapse to one arbitrary alias |
| Indirect virtual call target set | **missing** | No call-site-scoped target set exists |
| Constructor / destructor evidence | **partial** | Only via symbol syntax; not used as receiver proof |
| Member offset recovery | **supported** | `fieldFor` + `types/layout.js` already recover offsets and widths |
| Member type inference | **partial** | Width only; no float/pointer/bool/array category |
| Pointer / reference type propagation | **partial** | `types/constraints.js` exists; not connected to member categories |

## 3. Phase 2 and Phase 3 implementation

### Phase 2 — canonical vtable / RTTI evidence

`js/analysis/cxx/rtti-evidence.js` (new) — `buildCxxClassEvidence(input)`.

Turns a symbol index plus a bounded reader into canonical
`CppClassIdentity` + `CppVtableEvidence` records, and adds the facts `main`
could not derive:

- **`typeinfo` parse.** Reads the Itanium record and identifies the ABI class
  from the typeinfo's own vtable symbol (`__class_type_info`,
  `__si_class_type_info`, `__vmi_class_type_info`, …). Reads the base pointer
  (single inheritance) or the base array (multiple inheritance, including the
  `isPublic` / `isVirtual` / `offsetToTop` flags).
- **Class name from real data only.** Prefers the `_ZTS` symbol, else the
  length-prefixed type-name string the typeinfo points at
  (`parseItaniumTypeName`, which rejects templates/substitutions rather than
  guessing). If neither exists, the class stays `anonymous`. A name from a
  `_ZTV` symbol is accepted but recorded as `nameSource: 'vtable-symbol'`, so
  RTTI-derived and symbol-derived names are never conflated.
- **RTTI-present vs RTTI-absent.** Reported explicitly
  (`rttiPresent`, per-record `typeinfoAddress`). Without RTTI no inheritance
  edge is ever emitted.
- **Proven vtable extent.** Slot count comes from the declared symbol size,
  else the next vtable symbol, else the section end — recorded as
  `extentBasis` / `extentProven`. Without a proven extent **no slots are
  reported at all**, which is what removes the 8 fabricated slot entries.
- **Alias-preserving slot targets.** Every symbol name at a slot address is
  kept (`aliases`). Identical-code folding merges `Entity::~Entity`,
  `Actor::~Actor`, `Player::~Player` onto one address; a single-name projection
  silently attributes the slot to one class.
- **Bounded and lazy.** Two cheap passes; the address→aliases index is built
  only when at least one `_ZTV` symbol exists. No global pass, no new type
  system. Optional `createCxxEvidenceCache()` memoises by an explicit
  caller-supplied slice key.

### Phase 3 — call-site-scoped virtual dispatch

`js/analysis/cxx/virtual-dispatch.js` (new) — `resolveVirtualTargetSet(input)`.

Input is the Phase 2 report plus a receiver class and slot index; output is a
**target set**, never a global answer.

- The possible set is the receiver's class **and every in-image class derived
  from it** (transitive, RTTI-proven edges only). A base-class receiver keeps
  every legal override.
- `closureProven` is true only when the caller supplies **both**
  `dynamicClassProven` (per-call-site proof that the dynamic type is exactly
  one class) **and** a `closureAuthority` whose `rule` is in the frozen
  allow-list (`constructor-vtable-store`, `exact-object-definition`) with a
  call-site id. A single discovered candidate is *not* a proof — a class
  derived outside the image could legally override the slot.
- On closure the candidate set is **narrowed** to the exact class's own vtable
  (`possibleCandidates` keeps the wider set for evidence).
- Without RTTI the derived set is unknown, so the result is `partial` with the
  reason `rtti-absent-derived-classes-unknown` instead of pretending the static
  class's slot is the whole answer.
- `virtualSlotEvidenceFor()` projects a target set into the canonical
  `CppVirtualSlotEvidence`, which is the type the existing decompiler path
  already consumes.

### Phase 4 — member type categories (measured, narrower than requested)

`js/analysis/cxx/member-types.js` (new) — `recoverMemberTypeEvidence(input)`.

Layout grouping stays with `types/layout.js`. This module adds a **type
category** per receiver offset from access evidence: width and machine
sign-extension, flow into a vector register (float/double), use of a loaded
8-byte value as an address or call/return argument (pointer), indexed access
with a matching element scale (array-like), and a 1-byte member compared
against 0/1 or stored from literal 0/1 (bool-like).

Honest boundary: a plain `ldr w` proves *32-bit integer*, not *signed int*.
Those members report `category: 'int32'` with
`typeLabel: 'int32_t|uint32_t'`, `signedness: null` and `widthOnly: true`.
Only a sign-extending load (`ldrsw`, `ldrsb`, …) proves signed. Field *names*
are never produced here, so a projection can render
`this->field_38 /* int32_t|uint32_t */` without conflating name and type.

## 4. Fixtures (real binaries, not hand-written bytes)

`tests/phase7/cxx/fixtures/game.cpp` + `abi-stubs.cpp` are cross-compiled at test time
with clang/`ld.lld` (`--target=aarch64-unknown-linux-gnu -nostdlib`, Itanium
C++ ABI declared by hand so `_ZTVN10__cxxabiv1*` records are emitted). The
result is a genuine compiler-produced ARM64 ELF with a real game-shaped object
model: `Entity` → `Actor` → `Player`, virtual destructors, overrides, one
inherited slot, integer/float/pointer/char-array/bool members.

| Fixture | Shape |
| --- | --- |
| `game-rtti-o2` | `-O2`, RTTI present; destructors folded to one address |
| `game-rtti-o0` | `-O0`, RTTI present; receiver spilled to the stack, distinct destructors |
| `game-nortti-o2` | `-O2 -fno-rtti`; vtables and `_ZTV` symbols but no `_ZTI`/`_ZTS` |

The tests skip (with a reason) when clang/ld.lld are absent, matching the
existing compiler-truth convention; they never fall back to synthetic bytes.

## 5. Measurement

`node tools/validation/phase7/cxx/measure-cxx-recovery.mjs` → `measurement.json`. BEFORE is `main`
capability (`findCxxClasses` + `readVtable` with a slot cap); AFTER is the new
producer plus resolver plus member types.

### 5.1 What became provable

| Fixture | BEFORE classes / vtable slots | AFTER classes / typeinfo / inheritance / slots | Slot entries removed |
| --- | --- | --- | --- |
| `game-rtti-o2` | 8 / 64 (12 provably non-method, 3 unresolved) | 5 / 5 / 4 edges / 20 | 44 |
| `game-rtti-o0` | 8 / 64 (12 provably non-method, 3 unresolved) | 5 / 5 / 4 edges / 20 | 44 |
| `game-nortti-o2` | 8 / 64 (0 non-method, 6 unresolved) | 5 / 0 / 0 / 20 | 44 |

The BEFORE class and table counts include three `__cxxabiv1::*` ABI
implementation vtables, which are not game classes; AFTER excludes them. The
AFTER class set is `Entity`, `Actor`, `Player`, `Component` and the
multiple-inheritance `Enemy`, so the four RTTI edges are `Actor→Entity`,
`Player→Actor`, `Enemy→Entity` and `Enemy→Component`, the last two carrying the
`offsetToTop` subobject offsets `0` and `24`.

### 5.2 Virtual calls made concrete

One **enumerated class-slot** target set per `(class, slot)` pair, which is what
a call site on that static class would consume:

| Fixture | Class-slot target sets | Single-candidate | Multi-candidate | Resolved targets | Closure claims without call-site authority |
| --- | --- | --- | --- | --- | --- |
| `game-rtti-o2` | 20 | 11 | 9 | 32 | 0 |
| `game-rtti-o0` | 20 | 10 | 10 | 35 | 0 |
| `game-nortti-o2` | 20 | 20 | 0 | 20 | 0 |

These are counted over the recovered vtables, not over observed call sites: no
call-site identifier exists for an enumerated slot, so the metric is named
`classSlotTargetSets` and every set here stays `closureProven: false`. The
call-site scope is the resolver's contract — it applies only when a caller
supplies both `dynamicClassProven` and an allow-listed closure authority, which
this measurement does not (and must not) invent.

Example: `entityDamage(Entity* e, int amount) { return e->takeDamage(amount); }`
becomes a call with the receiver's vtable slot 2 mapped to 4 contributing
implementations across `Entity`, `Actor`, `Enemy` and `Player` — 3 distinct code
addresses, because `Enemy` inherits `Entity`'s override — instead of an
unresolved `blr x8`. `playerDamage(Player* p, …)` maps to a single candidate and
is deliberately **not** promoted to a devirtualised call: a class derived
outside the image could still override slot 2.

Every target set in `game-nortti-o2` is `partial` with
`rtti-absent-derived-classes-unknown` — the honest answer, because derived
classes cannot be enumerated without RTTI.

### 5.3 Member types improved

Measured on IR built from `llvm-objdump` disassembly of the linked fixtures
(real instruction stream, repository's own model/IR builders, receiver alias
tracking through `-O0` stack spills). `-O0` is the informative fixture because
the member loads survive codegen:

| Function | Field | Category | Label |
| --- | --- | --- | --- |
| `readHealth(Entity*)` | `+0x8`, `+0xc` | `int32` (width only) | `int32_t\|uint32_t` |
| `readSpeed(Actor*)` | `+0x18` | `float` | `float` |
| `readTarget(Entity*)` | `+0x10` | `int64` (width only) | `int64_t\|uint64_t\|pointer` |
| `isAlive(Player*)` | `+0x3c` | `int8` (width only) | `uint8_t\|char` |
| `readNameChar(Player*, int)` | — | (none) | indexed base is a computed `add`, no index in the IR |
| `Player::takeDamage` | — | — | IR build refused the function (`semantic-ssa-control-flow-mismatch`) |

Totals: **7 member fields across the two RTTI fixtures (5 at `-O0`, 2 at `-O2`),
2 typed with a proven category (both `float` at `+0x18`), 5 width-only, 0
unknown**. At `-O2` only `readHealth` and `readSpeed` keep a receiver load that
survives codegen.

The narrow part is deliberate, and two review findings tightened it:

- An 8-byte member that is merely *returned* or *passed as an argument* proves
  nothing — a `uint64_t` member and a pointer look identical there — so
  `readTarget` keeps its honest candidate list instead of claiming `pointer`.
  A pointer claim requires the loaded value to be used as an **address base**.
- `isAlive` returns the byte rather than branching on it, so bool-like is *not*
  claimed. The boundary is a `cmp` against literal `0`/`1`, a `cbz`/`cbnz` on a
  single byte, or a store of literal `0`/`1`; a byte compared against `42` stays
  `int8`.

### 5.4 False positive / overclaim checks

- **Fabricated slots:** the BEFORE enumeration returned 64 entries across 8
  symbol-derived tables (three of them ABI implementation classes), and 12 of
  those entries point at `_ZTI`/`_ZTV`/`_ZTS`, i.e. are provably not methods.
  AFTER reports 20 slots across 5 real classes and every one resolves to a
  method symbol — 0 unresolved, 0 non-method entries.
- **No real slot lost at the sub-table boundary:** the first boundary rule fired
  on the offset word and then discarded the word before it, so the `-fno-rtti`
  build reported one slot fewer than the RTTI build and silently dropped
  `Enemy::tick`. The rule is now purely structural (a slot is a code address, so
  a negative word starts the next sub-table), and the regression asserts the two
  builds agree on slot count, boundary index and the specific slot aliases
- **Fabricated class names:** 0. Names come from `_ZTS` or `_ZTV` symbols; the
  `-fno-rtti` fixture reports `rttiPresent: false`, no typeinfo, no
  inheritance edges.
- **Global devirtualisation overreach:** 0 closure claims without an explicit
  per-call-site authority; a single discovered candidate is never promoted.
- **Alias collapse:** the folded destructor slot keeps 6 symbol names instead of
  attributing the slot to one arbitrary class.
- **Adversarial regressions:** forged receiver/vtable/slot evidence is rejected
  (existing WeakSet canonicalisation), a receiver bound to a different function
  or function address fails closed, a widening cast is not a receiver alias,
  and a mismatched-scale indexed access reports no type.

### 5.5 Runtime overhead

Recorded in `measurement.json` (`performance` / `noEvidenceCost`); 300
iterations per shape on the three-fixture corpus, 75 for the 50k-symbol table:

These are the exact `performance` / `noEvidenceCost` values in the artifact:

| Case | Iterations | Mean |
| --- | --- | --- |
| BEFORE (symbol-only discovery + fixed-cap vtable read) | 300 | 0.659 ms/call |
| AFTER (canonical evidence, bounded extents) | 300 | 0.543 ms/call |
| No C++ evidence, empty symbol table | 300 | 0.008 ms/call |
| No C++ evidence, 50 000 ordinary C symbols | 75 | 0.566 ms/call |

Repeat runs move these means, so treat the ratio rather than the absolute
numbers as the claim: in the recorded run the enabled path measured **0.82x**
the path it replaces (`meanRatio: 0.82`). One run cannot establish that the new
path is *always* faster; the mechanism it relies on (reading each table only to
its proven extent, and no memory reads at all on a C-only slice) is the durable
reason, the ratio is a single sample. The reason is that it reads each
table exactly as far as its proven extent (20 slots across 5 tables, and a
`readBudget` of 14 pooled reads on the RTTI fixtures) instead of a fixed cap that
over-read the table plus a fixed 8 slots per table. The no-evidence path is a
single cheap character test per symbol plus **zero** memory reads; the first
implementation instead built the address→aliases map for every symbol and cost
**25.4 ms** on the 50k-symbol table, which this scan avoids.

## 6. Before / after

**Virtual indirect call**

```c++
// before — target unknown
sub_1000A4 = (*(code **)(*(long *)e + 0x10))(e, 0xa);

// after — call-site-scoped target set, from Entity/Actor/Enemy/Player vtables
// receiver class: Entity   slot: 2
// candidates: Entity::takeDamage | Actor::takeDamage | Enemy::takeDamage | Player::takeDamage
//             (4 contributing classes, 3 distinct addresses)
// closureProven: false (a class derived outside the image may override slot 2)
sub_1000A4 = (*(code **)(*(long *)e + 0x10))(e, 0xa);
```

**Class and hierarchy**

```
// before
_zttv_6entity   vtable 0x220670   no RTTI record
vtable slots: 8 (4 belong to the neighbouring typeinfo record)

// after
class Entity                                  // nameSource: rtti-zts-symbol
  typeinfo 0x220d90  kind __class_type_info
  vtable   0x220670  extentBasis next-vtable  4 slots
  derived: Actor, Enemy
class Actor : public Entity                   // __si_class_type_info
class Player : public Actor
class Component                               // __class_type_info
class Enemy : public Entity, public Component // __vmi_class_type_info
  subobjects: Entity @ +0, Component @ +24
```

**Member type**

```c++
// before
return *(int *)((char *)a1 + 0x18);

// after
return this->field_18 /* float */;   // vector-register-flow
```

## 7. Supported / unsupported boundary

Supported, with real-binary regression coverage:

- Itanium RTTI `typeinfo` parsing for `__class_type_info`,
  `__si_class_type_info`, `__vmi_class_type_info` (≤ 8 bases).
- Class names from `_ZTS` symbols or type-name strings (plain and nested).
- Inheritance edges and transitive derived classes, RTTI-present only.
- Proven vtable extents (symbol size → next vtable → section end) and
  alias-preserving slots.
- Secondary `_ZTV` sub-tables are located **structurally**: a slot holds a code
  address, so the negative offset-to-top that opens the next sub-table is never
  published as one, with neither an RTTI record nor a symbol required. A `_ZTI`
  alias remains a second, independent fail-closed check.
- `__base_class_type_info::__offset_flags` is decoded as the signed `long` the
  ABI declares, so a producer that stores the negated subobject offset cannot
  turn it into a very large positive one.
- Call-site-scoped target sets; closure only under an explicit authority.
- Member categories: float, double, pointer, bool-like, array-like,
  signed byte/halfword/word/doubleword, and width-proven integers.

Unsupported on purpose (kept explicit, never guessed):

- **No RTTI:** no inheritance, no derived-class enumeration, no target-set
  completion. Class names survive only through `_ZTV` symbols.
- **Stripped ABI vtable symbols:** the typeinfo *kind* cannot be identified, so
  base extraction is skipped (`baseEvidence: 'abi-kind-unresolved'`) and only
  the name is read.
- **Templates / substitutions in `_ZTS`:** `parseItaniumTypeName` returns null
  and the class stays anonymous.
- **Closure without a call-site authority:** always `closureProven: false`.
- **Signedness of a plain word access:** not derivable; reported as a candidate
  pair, not a claim.
- **Encoded (chained/auth) slot pointers without fixup context:** reported
  `unresolved`, never coerced to an address.
- **Indexed member bases folded into an `add`:** no array-like claim.
- **Decompiler integration:** the `cxxEvidence` option is now populated from a
  provider built on real binary evidence (see "Wiring into the analysis
  entrypoint"), but the provider's index is built **in-process**. The shipped
  product reaches `analyzeSemanticFunction` across a serialized worker
  transport, and canonical evidence is deliberately an in-process capability
  (a `WeakSet` brand), so a worker-side producer lifecycle is still the
  remaining reachability step. Until it exists, the shipped product renders as
  before and gains nothing from this change.

## 8. Phase status

| Phase | State |
| --- | --- |
| 1 — existing recovery audit + real-binary taxonomy | done (this document, `taxonomy.json`) |
| 2 — canonical vtable / RTTI evidence | done (`rtti-evidence.js`, 23 regressions) |
| 3 — call-site-scoped virtual dispatch | done (`virtual-dispatch.js`, 13 regressions) |
| 4 — field / member type propagation | measured; module implemented and covered (16 regressions); **not** productionised into the decompiler projection because the measured improvement is a category label, not yet a rendered type |
| 5 — wiring the producer into the analysis entrypoint | done in-process (`project.js`, `semantic-function.js` seam, 17 regressions); worker-side producer lifecycle still open |

Per the brief: a capability whose improvement cannot be measured is not
productionised. Phase 4's *rendering* (extending `fieldFor` consumers to display
the label) was left out, because doing it safely means changing pseudocode
output and re-baselining the decompiler suites; the evidence module and its
measurement are the deliverable.

## 9. Process notes and what is not done

- `docs/ENGINEERING_PROCESS_GUARDRAILS.md` was read first. This work is an
  investigation plus new modules and focused regressions — not a master phase —
  so the phase preflight / candidate-merge-tree / verifier contracts are not
  claimed. The applicable habits were kept: exact inputs, fail-closed on
  missing toolchain (skip with reason, never synthetic substitution), real
  binaries rather than hand-written bytes, and a regression for each source
  code change.
### Verification run

- `node tests/check.mjs` (syntax lint, 5473 files) — PASS.
- `node tests/module-boundaries.mjs` — PASS.
- `node tests/phase7/run.mjs --group cxx` — PASS (5/480 discovered files, 69 tests: 23 rtti-evidence, 13 virtual-dispatch, 16 member-types, 13 projection, 4 analysis-seam).
- `tests/phase8/cxx-object-decompiler-projection.test.mjs` and
  `tests/phase7/cxx-object-evidence.test.mjs` — PASS (no regression in the
  existing C++ decompiler projection).
- `node tools/validation/invariant-gates.mjs` — FAIL on
  `machine-effects-contract`, pre-existing and unrelated to this change
  (nothing here imports `tests/machine-effects` or
  `tools/validation/machine-effects`; `grep -rln analysis/cxx` over both trees
  is empty).

  **LLVM 18 is installed in this environment.** An earlier draft of this
  report claimed it was not; that was wrong and is corrected here. From
  `docs/analysis-roadmap-v8-integration-checkpoint.md` and
  `docs/analysis-remaining-20260914.md` the toolchain is meant to be prefixed
  onto `PATH`:

  ```sh
  env PATH=/mnt/workspace/.local/hex-stage-a-toolchain/install/bin:$PATH \
    node scripts/run-quiet-command.mjs --label check -- npm run check
  ```

  `clang-18`, `llvm-mc-18`, `llvm-objdump-18`, `llvm-objcopy-18` and `ld.lld-18`
  there all report LLVM/clang **18.1.3**, and with that prefix the prerequisite
  gate passes outright:

  ```
  node tools/validation/machine-effects/prerequisites.mjs   # -> {"ok": true}
  ```

  Two *environment* causes remained, both separate from this change and from
  each other:

  1. **Ten machine-effects files hardcode an absolute oracle path and ignore
     `PATH`/env.** `prerequisites.mjs` resolves its tools from `env[LLVM_MC]`,
     then `/usr/bin/llvm-mc-18`, then `llvm-mc-18` on `PATH` — so the documented
     `PATH` prefix satisfies it. But the denominator tests bypass that resolver:

     ```js
     const llvmMc = ['/usr/bin/llvm-mc-18','/usr/bin/llvm-mc']
       .find((candidate) => fs.existsSync(candidate));
     ```

     `/usr/bin/llvm-mc-18` does not exist in this environment, so these tests
     silently fall back to `/usr/bin/llvm-mc`, which is **Ubuntu LLVM 14**.
     Nothing consults `LLVM_MC` or `PATH`. Files doing this:
     `arm64-a64-{control,flags,fp,integer,memory,simd,system}-denominator`,
     `arm64e-pac-denominator`, `x86-long64-memory-denominator` (plus
     `tools/validation/phase{5,6}/build-verification-corpus.mjs` and
     `tools/validation/stage2/a7-lldb-real-fixture.mjs`).

     Concretely proven for `arm64-a64-integer-denominator`, which asserts the
     CSSC `abs` encodings through the architectural feature gate:

     ```
     $ printf 'abs w0, w1\nabs x0, x1\n' | llvm-mc-18 --triple=aarch64 --mattr=+cssc --show-encoding
             abs     w0, w1     // encoding: [0x20,0x20,0xc0,0x5a]
             abs     x0, x1     // encoding: [0x20,0x20,0xc0,0xda]
     exit=0

     $ printf 'abs w0, w1\nabs x0, x1\n' | /usr/bin/llvm-mc --triple=aarch64 --mattr=+cssc --show-encoding
     '+cssc' is not a recognized feature for this target (ignoring feature)
     <stdin>:1:5: error: invalid operand for instruction
     exit=1
     ```

     LLVM 18.1.3 emits exactly the bytes the test expects; LLVM 14 rejects
     them. `arm64-a64-memory-denominator` fails the same way via the oracle
     (`LLVM oracle instruction count drift 0 !== 279` — the assembler produced
     nothing). So these two failures are an oracle-**discovery** gap, not a
     missing toolchain and not a defect in the analyser.

  2. **The browser-driven machine-effects files fail on a host shared
     library.** The remaining failures (`x86-address-ir`, `x86-long64-*`,
     `x86-random`, `issue-6079-*`, `issue-6133-*`, `phase2-*`) all launch
     Playwright's WebKit MiniBrowser, and the OS dynamic loader aborts before
     any repository code runs:

     ```
     MiniBrowser: error while loading shared libraries: libxslt.so.1:
       cannot open shared object file: No such file or directory  (exitCode=127)
     ```

     `libxslt.so.1` exists nowhere on this host (`find / -name 'libxslt.so.1*'`
     is empty) and the Playwright WebKit bundle does not ship it, since it is a
     system dependency of WPE WebKit. `chromium-1234` *is* present. This is a
     host-dependency gap in the preinstalled WebKit bundle.

  Neither cause is weakened by this change (guardrails: a required toolchain
  family must not be replaced by a weaker proxy), and neither is caused by it.

  **Cause 1 was resolved at the environment level** (no repository change). The
  missing `/usr/bin/*-18` entries were recreated as symlinks into the installed
  18.1.3 toolchain, matching what the checkpoint docs describe:

  ```
  /usr/bin/{clang,llvm-mc,llvm-objdump,llvm-objcopy,llvm-readobj,llvm-strip,
            llvm-dwarfdump,ld.lld,ld64.lld,lld-link}-18
    -> /mnt/workspace/.local/hex-stage-a-toolchain/install/bin/<tool>-18
  ```

  All of them report LLVM/clang 18.1.3, and the two oracle failures are now
  green at their real denominators:

  ```
  ARM64 A64 integer denominator (68899 Capstone forms + 2 LLVM CSSC forms): PASS
  ARM64 A64 memory denominator (279 LLVM+Capstone cases): PASS
  ```

  `npm run effects:test` with the documented toolchain `PATH` prefix went
  **13 → 11** failing files. A third discovery gap sits in `PATH` rather than
  `/usr/bin`: system `git` here is **2.34.1**, which predates
  `merge-tree --write-tree` (git 2.38), so `independent-oracle-report.test.mjs`
  fails on an empty candidate-tree sha unless the toolchain's `git` **2.49.1**
  is on `PATH`. Running `effects:test` *without* the documented prefix therefore
  shows a spurious extra failure - which is exactly why the documented
  invocation prefixes the toolchain directory.

  **Cause 2 was the Playwright WebKit system-library gap, and it was resolved
  in two steps.** `libxslt.so.1` was absent host-wide; installing `libxslt1.1`
  merely advanced the loader to the *next* missing library (`liblcms2.so.2`),
  and `ldd minibrowser-wpe/bin/MiniBrowser` showed **21** unresolved sonames.
  The official dependency set (`npx playwright install-deps webkit`, 125
  packages - GStreamer plugins, mesa EGL, GTK/soup, codecs, icon themes) closed
  it; afterwards `npx playwright install-deps webkit --dry-run` reports "All
  system dependencies are installed".

  **Result: `npm run effects:test` went 13 -> 11 -> 6 failing files**, and the
  final run contains **zero** loader aborts:

  | stage | failing files |
  | --- | --- |
  | baseline | 13 |
  | + `/usr/bin/*-18` symlinks | 11 |
  | + `libxslt1.1` and `playwright install-deps webkit` | 6 |

  Six failures remain, and every one is **semantic**, not environmental - no
  missing library, no unknown oracle. Each is a production/test expectation
  divergence, now reproducible because the browser actually launches:

  | file:line | observed vs expected |
  | --- | --- |
  | `x86-long64-extended-state.test.mjs:51` | `x86-x87-trusted-decoder-provenance-required` vs `/x86-x87-family-requires-dedicated-semantics/` |
  | `x86-long64-fp-denominator.test.mjs:28` | the same x87 reason divergence, via the public Capstone session |
  | `phase2-integration.test.mjs:86` | `partial` vs `exact-with-intrinsic` |
  | `phase2-release-gate.test.mjs:86` | `exact-with-intrinsic` 7 vs 8, `partial` 4 vs 3 |
  | `x86-long64-closure-matrix.test.mjs:67` | `chromium: no valid witness may remain partial (44/1487)` |
  | `issue-6079-vblendmx-blend-category.test.mjs:52` | `undefined` vs `simd`, inside the browser session |

  The x87 pair carries the same signature that was already present in the very
  first run, before any environment change, so it is pre-existing and real.
  All six are outside this change's scope: none imports `analysis/cxx`
  (`grep -c` is 0 for all six), `git status` shows nothing modified under
  `js/targets/` or any effects tree, and `grep -rln analysis/cxx` over
  `tests/machine-effects` and `tools/validation/machine-effects` is empty.

  None of this is weakened by this change (guardrails: a required toolchain
  family must not be replaced by a weaker proxy). The environment repairs
  restored the toolchain the checkpoint docs already specify; they relaxed no
  gate requirement.

  The 69 C++ regressions under `tests/phase7/cxx/` do not depend on LLVM 18 and
  pass against the LLVM 14 tools on the default `PATH`
  (`node tests/phase7/run.mjs --group cxx` -> 69/69, 5 suites).

### Wiring into the analysis entrypoint

`js/analysis/cxx/project.js` is the producer side of the `cxxEvidence` channel
that `js/decompiler/cxx-evidence.js` already consumed. It offers:

- `createCxxEvidenceProvider({ symbols, read, ... })` — builds the canonical
  class/vtable index **once per slice**, lazily, with the `_Z`-prefix prefilter
  in front so a C-only slice costs zero reads. The async part is only the index
  build; `projectForFunction(...)` is synchronous, so a synchronous analysis
  entrypoint can consume it.
- `projectForFunction(...)` — indexes slots by target address, so a function is
  attributed only to the vtables that actually reference it, then delegates to
  `extractCppObjectEvidence`. It returns `null` when the index is not ready,
  when the slice has no C++ family, or when the function has no positive
  non-static member proof. It never guesses.
- `normalizeCxxEvidenceInput(value)` — the fail-closed consumer gate. Canonical
  evidence passes; a structural clone, a serialized copy or a hand-built
  look-alike is dropped, so nothing but the canonical producer can mint `this`.

`js/analysis/semantic-function.js` now forwards that evidence into the existing
projection options, opt-in and without changing any default path:

```js
// before — the option existed but only tests ever set it
analyzeSemanticFunction(input)

// after — a provider built from the real slice carries it through
analyzeSemanticFunction({ ...input, cxxEvidenceProvider: provider })
```

Measured end to end on the real fixture (`tests/phase7/cxx/analysis-seam.test.mjs`):
with the provider, `_ZN6Player10takeDamageEi` decompiles with a `this` receiver;
without it, and with a cloned receiver object, the pseudocode is byte-identical
to the previous behaviour.

- Not done, and deliberately out of scope for this change:
  - a **worker-side** producer lifecycle, which is what makes this reachable in
    the shipped product (see the boundary note above);
  - rendering member type labels in pseudocode output;
  - validating against a large third-party game binary (the corpus here is
    compiler-produced ARM64 ELF with the same ABI and object shapes; a
    commercial fixture would strengthen the evidence but was not available in
    this environment).
