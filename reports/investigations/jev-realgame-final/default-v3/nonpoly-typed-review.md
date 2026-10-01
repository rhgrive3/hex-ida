# Non-polymorphic typed-input review — commit `2db94a9a8`

Status: **COMPLETE — no merge-blocking defect found.**
Reviewer: independent (Buffy / DeepSeek V4.1 Flash), read-only.
Date: 2026-10-01.

## Scope and exact binding

- Checkout: `/mnt/workspace/.dev-state/agent-work/checkouts/jev-realgame-final/hex-ida`
- Branch: `integration/jev-realgame-final`
- Reviewed commit (target): `2db94a9a8211738766b2a1bca5764c0864341c86` ("fix(cxx): prove non-polymorphic typed inputs from lifetime ABI symbols")
- Resident HEAD at review time: `b87428ce14f98bd7ac7a63269cbb720844433840`
- All seven in-scope paths are **byte-identical** at target, at HEAD, and in the worktree
  (`git diff 2db94a9a8..HEAD -- <paths>` empty), so reviewing the worktree is reviewing the
  target content. Worktree `git status --porcelain` was empty.

### In-scope file SHA256 (target == HEAD == worktree)

```
5a81669720cd827167cb70301ede789dde6ed77f0f1c1735eadbd00020ec6467  js/analysis/cxx/class-type.js
19ff08fd9800aeefbd7a8846c8df83ef33856e4a6164567c453b0baa76e703de  js/analysis/cxx/typed-argument.js
e38b73f379d1e9cc600ff9079b0fa79d66e06d7fac59ceca8550cc49207dbb0e  js/analysis/cxx/object-evidence.js
f9bf69437b3c961659c782aed38a8f174c215687f8c485c0bf2160be817c964e  js/analysis/cxx/project.js
7be8ceb9794e27801162da0ffd346ecac2464b359bd63326deb419763e16c487  js/analysis/cxx/query-recovery.js
ec1119ac600556ddecca1bfedffac412dd4fe98e5aebe378e2d0bef333d3955f  tests/phase7/cxx/class-type.test.mjs
8f76e8acf3f93e984d42f447aca7fbcc47ba8fd12b2937032b3729c632940641  tests/phase7/cxx/typed-argument.test.mjs
```

## Tests actually run (only the four in-scope tests)

Command:
```
node --test tests/phase7/cxx/class-type.test.mjs tests/phase7/cxx/typed-argument.test.mjs
```
Node `v24.20.0`. Result: **tests 4 / pass 4 / fail 0 / skipped 0** (139 ms).

- `lifetime ABI class proof rejects resemblance, incompatible aliases and forged or stale authority`
- `non-polymorphic input recovery publishes canonical anonymous fields without inventing this or layout`
- `exact release ABI object-pointer signatures produce immutable argument evidence`
- `unsupported or ambiguous signatures and ABI bindings fail closed`

All commands ran with `TMPDIR`/`TMP`/`TEMP` = `/mnt/workspace/.dev-state/agent-work/scratch`.

## What the commit does

`class-type.js` (new) decodes a constructor/destructor Itanium symbol into a class name and
publishes canonical, snapshot-bound `cpp-class-type-evidence/v1` proofs. `object-evidence.js`
accepts such a proof as an alternative to a primary vtable identity for the *typed-argument*
receiver role. `project.js` synthesizes a named owner from the class-type index only when no
primary vtable owner exists, and passes the proof through. `query-recovery.js` adds
class-type names to the V3 planner's candidate class set. `typed-argument.js` adds an `S`
(later-parameter substitution) arm to the trailing-signature parser.

## Adversarial probe results

### Exact constructor/destructor ABI class proof vs enum/name resemblance
- `classNameFromLifetimeSymbol` calls `cxxAbiFunctionRole(symbol)` **first** and requires
  `role.kind ∈ {constructor,destructor}`; it returns `null` unless the whole symbol parses
  (full `p.i === s.length` validation inside `cxxAbiFunctionRole`). Its own decoder is then a
  plain ASCII length-prefixed decoder that requires a literal `C[123]`/`D[012]` marker.
- Probed resemblance/counterexamples, all rejected (`.size === 0`): member functions
  (`_ZN6Entity6EntityEv`), a name that merely contains `C1` (`_ZN6Entity5aC1EbEv`), member
  `_ZN6Entity1fEv`-style names, free functions (`_Z1fP6Entity`), const-qualified
  (`_ZNK6EntityC1Ev`), template form (`_ZN6EntityIiEC1Ev`), trailing junk (`_ZN6EntityC1Evjunk`).
- Accepted only the real ctor/dtor forms: `_ZN6EntityC1Ev`, `C2`, `C3`, `D1`, `D2`, and
  `_ZN2ns6EntityC1Ev` → `ns::Entity`. Templates/substitutions/operators in the class name fall
  through the ASCII decoder and are rejected (fail closed).

### Alias order / ICF conflict
- `buildCppClassTypeIndex` keys records by address and **blocks** the address on any
  incompatible or non-decodable alias, in either order:
  - `_ZN6EntityC1Ev` + `_ZN5OtherD1Ev` same addr → `[]`
  - `_ZN6EntityC1Ev` + `_Z1fP6Entity` same addr → `[]`
  - `_ZN6EntityC1Ev` + `_ZN6EntityC2Ev` + `_ZN6EntityC1Evjunk` → `[]` (third alias poisons)
  - C1+C2+D1 of the same class → single `Entity` (consistent aliases retained)
- Non-function addresses are ignored (`symbols.funcs` gate); missing/blank `snapshotId` or a
  non-safe-integer / oversized `names` array returns an empty index.
- Minor non-blocking observation: `indexFromReport` builds `typedArguments` order-dependently
  (only if the *first* symbol at an address is a `_Z\d…` proof); this can only lose a positive
  proof, never fabricate one. Pre-existing behavior, unchanged by this commit.

### No fabricated vtables/layout
- `class-type.js` performs a single metadata walk over `symbols`; it reads no code, RTTI, debug
  or source data, and emits no vtable/typeinfo/layout fields. `rule` is
  `exact-lifetime-function-ABI-class-type`. The evidence carries `vtableAddress: null` for a
  lifetime-derived owner (test asserts `classIdentity.vtableAddress === null`).

### Canonical WeakSet + snapshot/function binding
- Proofs are added to a module-private `WeakSet` only inside `buildCppClassTypeIndex`; the record
  is `deepFreeze`d with a `stableDigest`. `{...p}` and hand-built shapes fail
  `isCanonicalCppClassTypeEvidence` (tested).
- `createCppTypedArgumentReceiverEvidence` requires `isCanonicalCppClassTypeEvidence(p)`,
  `p.className === argumentProof.className`, and `p.snapshotId === input.snapshotId`; stale
  snapshot (`'later'`) and mismatched class name both throw `cpp-typed-argument-class-proof-required`.
- The receiver path also binds `functionAddress === proof.functionAddress` and
  `argumentsAtX0.length === 1`, `vtables.length === 0`, `metadata.isStatic !== true`,
  `!isAdjustedThunk`.
- Provider cache note: even if a cached class-evidence report is stale, `classTypes` is rebuilt
  from the **current** `symbols` and **current** `snapshotId` (not from the cached report), and the
  proof/receiver snapshot comparison is against that same current id — no cross-snapshot leak.
- Conflict precedence verified: when `typedClasses.has(className)` is true but its stored value is
  `null` (two vtables disagree), `argumentOwner` is `null` and the lifetime proof cannot repair it
  (`owner?.kind !== 'named'` → throw → `bind(null)`), matching the source comment.

### Trailing parameter substitutions fail closed; x0 cannot become `this`
- New `S` arm accepts only `S_` or `S<1..6 of [0-9A-Z]>_` **and** additionally requires
  `demangleCxx(symbol) !== null` (full-symbol validation). The first parameter is still required
  to be `P[K]<qualified name>` and is parsed before any trailing token, so a later substitution
  cannot relocate arg0.
- Probed: `_Z1fP6EntityS0_` and `_Z1fP6EntityS_` accepted (arg0 still `Entity`, register `x0`,
  index 0); `_Z1fP6EntityS1_` and `_Z1fP6EntityS9_` (out-of-range substitution) rejected;
  `S1234567_` (index > 6 chars) rejected; `_Z1fP6EntityS0_E`, `_Z1fP6EntityS0_extra`, `St`, `Ss`
  rejected; member-with-substitution `_ZN6Entity1fES0_` rejected; varargs `_Z1fP6Entityz`
  rejected. `_Z1fP6EntityS0_ii` accepted with `parameterCount: 4`.
- The `S` arm consumes ≥1 byte per call and `trailingType` never returns `true` without consuming,
  so no zero-width loop; `parameterCount` is capped at 16, symbol length at 1024.
- `register` is hard-wired `x0` and `argumentIndex` `0`; `receiverRole` is `typed-argument` only.
  `currentCppReceiver` requires `receiverRole === 'this'`, so a typed-argument receiver can never
  become `this` (test asserts `currentCppReceiver(...) === null`). No `this`/member/non-static
  capability is claimed by the new proof (module header states this explicitly).
- ARM64 ABI note (verified by reasoning, not by a new test): AArch64 passes an indirect-by-value
  result address in **x8**, so the first source pointer parameter remains in `x0` even for
  sret functions; only `arm64`/`arm64_32` are accepted, so this module's x0 assumption holds.
- `enableTypedArguments` defaults to `false` in `projectForFunction`; typed projection is opt-in,
  not a default activation.

## Blockers / incompletes
- None blocking. Out of feature scope and therefore **not** run or read:
  `tests/phase7/cxx/projection.test.mjs`, `tests/phase7/cxx/fixtures/game.cpp`, the userscript
  version files, and `tools/validation/phase8/cross-lane-inventory.mjs` (all touched by the same
  commit but outside this review's declared scope).
- No oracle/gold/holdout/result files were read; no Jev API calls were made; no extra agents were
  spawned; no source files were edited.
- This is a focused review of one commit's evidence logic only. It is **not** a claim of default
  activation, a release-gate pass, or runtime activation — parent independently verifies.
