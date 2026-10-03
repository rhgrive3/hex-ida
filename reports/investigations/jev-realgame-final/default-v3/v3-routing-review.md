# Independent READ-ONLY review — prospective anonymous C++ routing (v3)

- Date (UTC): 2026-10-01T03:1x
- Reviewer: Freebuff (DeepSeek V4.1 Flash, high)
- Repository checkout: `/mnt/workspace/.dev-state/agent-work/checkouts/jev-realgame-final/hex-ida`
- Branch: `integration/jev-realgame-final`
- HEAD: `74cba530fa4a0c493b9374e48d524c7cea5767d3`
- TMPDIR/TMP/TEMP: `/mnt/workspace/.dev-state/agent-work/scratch` on every command
- Scope policy: read-only; no source edits, no gold/oracle/holdout/result reads, no API calls, no extra agents, focused tests only (cap 4; ran 3).

## Source identity (sha256 bound)

Reviewed source at the exact HEAD above:

| file | sha256 |
| --- | --- |
| `js/analysis/query/jev-advisory.js` | `3200a87cd385267f76ce7ea1840e306fb4fc6ab411e78cf664cc431c5b8769a8` |
| `js/analysis/cxx/member-types.js` | `fd4f3dce9c2c2be38ff26b1013fc7fa0057ee63fc9290b898b5c624a7973b11f` |
| `js/analysis/cxx/object-evidence.js` (canonical role allowlist) | `7a3f2e2d8b8db990b783a496af627cd8a516bfafb43d2817c252f44b5948e23a` |
| `tests/phase7/cxx/jev-recovery.test.mjs` | `8139a6e7d288c0b8e644c2a3138349f6999180716fdaf8f7201c76b735154e8f` |

All four hashes were re-read at the end of the review and were unchanged from first read.

### Dirty bytes / concurrent-tree caveat

The tree was clean at first inspection, then (while the review ran) a concurrent rebuild added:

```
 M tools/validation/phase7/cross-lane-inventory.mjs   (+ "scripts/verify-jev-default-v3.mjs")
 M tools/validation/phase8/cross-lane-inventory.mjs   (+ "scripts/verify-jev-default-v3.mjs")
?? scripts/verify-jev-default-v3.mjs
```

No reviewed source file changed; the addend only registers the new (out-of-scope) verifier script in the cross-lane inventories. This receipt is bound to the four sha256 values above, which are stable at HEAD.

## Checks performed

### 1. Pure-context signature (`jevMemberContextSignature`)

- Builds `className` + per-`address` union of `accessRoles`, address-sorted; does not include offset/size/read/write counts. Confirmed by the focused test: an offset/width difference does not change the signature.
- Duplicate provenance with the same address collapses into one Map entry; duplicating a context list (same addresses, same roles) leaves the signature identical. Confirmed by test assertion "duplicate provenance does not invent semantics".
- Signature is used only to detect indistinguishability (`rerankAnonymousCxx` rejects a selection whose signature collides with another non-conflict view). It does not mint semantics and cannot by itself promote a decision.

### 2. Routing decisions (`jevSemanticRoute`, `rerankAnonymousCxx`)

- Fail-closed lattice: non-array, >400 views, any non-`cxx` or non-`anonymous` view → `{call:false}`.
- Conflict views are filtered before scoring; strong local results (`confirmed`/`likely`) veto routing; unique accessor requires `best.key===topKey`, a strict score lead, and a `return-input` context; otherwise routing requires at least one non-construction/destructor (runtime) named context.
- `rerankAnonymousCxx` requires explicit `options.enabled === true`, a function `isCurrent`, and a callable `client`; disabled, strong-verdict, stale (`isCurrent` flip after call), timeout, malformed, invented, out-of-range, and conflicting selections all fall back to `rerankWithJev`. Verified by the focused test.
- Non-mutation: input `local` (`verdict`, `top`, candidates) is not mutated by routing/signature code; asserted in tests.

### 3. HTTP client boundary (`createJevMemberClient`)

- `apiKey` type/length gate; `candidates` length 2..255; every view must pass the canonical trust boundary `cxxSemanticViews` (branded `isCanonicalCppReceiverEvidence`/`isCanonicalCppMemberEvidence` via WeakSet).
- Serialized/cloned candidates are rejected: the focused test "serialized evidence cannot authorize an external request" asserts no request is issued and the client returns `null`.
- Authorization is carried only in the header; the request body excludes the API key and any `oracle`/`sourceFieldName` value. Response validation requires `model==='openjev'`, `pick.type==='choice'`, `^c(?:0|[1-9]\d*)$` choice keys, confidence/probabilities in `[0,1]`, bounded key count, `unique.type==='noul'`, in-range choice index, and non-conflict candidate.
- Out-of-range / contradictory ids (`c255` against 2 candidates, `noul:2`, wrong model, empty payload, `ok:false`) all return `null`. Confirmed by the focused test.

### 4. Canonical role allowlist (`object-evidence.js`)

- `createCppMemberEvidence` restricts `accessRoles` to the exact 8-role allowlist (`return-input`, `comparison-input`, `arithmetic-input`, `address-base`, `constant-written`, `argument-written`, `zero-written`, `one-written`), caps length at 8, dedupes and sorts; a serialized role cannot exceed it (`cpp-member-access-role-invalid`).
- `cxxSemanticViews` re-checks receiver/member brand, `receiverDigest`/`functionId`/`snapshotId` binding, offset/size equality, owner key and `offsetToTop===0n` before a context is emitted. Serialized provenance cannot acquire a method context.

### 5. Machine literal safety (`member-types.js`)

- `storedBitConstant` walks only `copies` (plain `mov`) chains, bounded by `MAX_CHAIN_DEPTH` with cycle detection, and never arbitrary unary/binary operations; the weaker `constant-written`/`argument-written` roles use `constantValueOf`/`isStoredArgument` over `sources` (mov/unary).
- `zero-written`/`one-written` are added only when the value is an exact `0n`/`1n`. The one-byte `bool-like` classification is a candidate category (`['bool','uint8_t']`), not a source-name claim, and the advisory instructions explicitly warn that a byte 0 write may be a terminator or padding — no binary type or source purpose is promoted by bit writes at the routing layer.
- Value-flow projection (`jevValueFlowRequest`) appends bounded (`slice(0,8)`) store-role and construction-only strings; it ignores unknown keys and does not mutate its input (asserted: input array length 80 preserved).

### 6. Activation / compatibility

- Repo-wide search (excluding tests and `node_modules`) finds no production caller of `rerankAnonymousCxx`, `createJevMemberClient`, `jevSemanticRoute`, or `requestJevAlternative`. The only consumers are the out-of-scope `scripts/evaluate-jev-default-v3.mjs` / `scripts/verify-jev-default-v3.mjs` evaluation harnesses.
- No `dist/`, `worker.js`, or `userscript/` bundle references these symbols. Production default remains OFF and activation requires an explicit `enabled === true`.
- The pre-existing optional advisory (`jevAdvisoryRequest` / `requestJevAlternative`) is retained unchanged in shape and remains explicitly manual.

## Focused test execution (cap 3 of max 4)

Command (quiet, no broad suite):

```
node --test --test-name-pattern='automatic anonymous|anonymous HTTP|selective semantics' tests/phase7/cxx/jev-recovery.test.mjs
```

Result: `tests 3 | pass 3 | fail 0 | skipped 0`, Node v24.20.0.

- ✔ automatic anonymous routing vetoes identical context and fails closed on stale or invalid remote results
- ✔ anonymous HTTP client uses only branded release facts and rejects malformed responses
- ✔ selective semantics preserve strong and unique local accessors and expose indistinguishable contexts

Parent PASS claims were not taken on trust; the tests were re-run independently.

## Findings

No merge-blocking defect found in the reviewed scope. No source edits made. No unexplained red in the focused tests.

## Incomplete / not performed (explicit)

- Not run: canonical full gate `npm run check`, broad suites, real-game, perf — per focused-only cap.
- Not inspected: `scripts/evaluate-jev-default-v3.mjs` / `scripts/verify-jev-default-v3.mjs` internals (gold/oracle-adjacent; forbidden), and no gold/oracle/holdout/result files were read.
- Not run: live network call against `api.openjev.sh`.
- This is a read-only prospective review; it makes no production-activation, exact-head merge, or release claim.
