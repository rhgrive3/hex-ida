# ABI-to-Prototype Contract

## Inputs

The consumer receives a canonical ABI adapter bound to one architecture/profile
identity and the Semantic IR/function/call evidence for that same binary slice.
The adapter is the only interface through which a consumer requests argument,
return, aggregate, stack, sret, or variadic placement.

## Required output contract

Every published prototype or summary must preserve:

1. `abiId`, semantic version/identity, architecture/profile identity, and
   calling convention knowledge state;
2. ordered visible arguments and physical pieces, including register classes,
   widths, stack offsets, alignment, and padding;
3. aggregate piece order and split register/stack placement without repacking;
4. hidden sret location/role, distinct from visible user arguments;
5. known fixed variadic prefix and an explicit anonymous frontier;
6. classifier evidence/provenance, completeness, diagnostics, and invalidation
   dependencies;
7. caller/callee agreement or an explicit conflict/unknown state.

For forced-stack AAPCS64 HFA/HVA, the output must use one canonical physical
element-slot layout (at least eight bytes per element, with wider element spans
retained), expose the full aggregate span, and place the next argument after
that span. Every padding and stack interval is finite, safe-integer, located,
non-overlapping evidence. Duplicate scalar stack intervals invalidate the
result; only a same-index register/stack aggregate split may be duplicated
across its canonical projections.

## Exactness rule

An exact location or prototype may be published only when the selected supported
profile is identity-valid, the classifier result is complete for that fact, all
aggregate/layout pieces are proven, and no call/prototype/profile conflict is
unresolved. Unsupported, partial, unknown, stale, malformed, cancelled,
truncated, budget-limited, or conflicting evidence must remain conservative.

## Profile rows

The phase8 matrix must exercise Darwin ARM64, arm64e identity behavior, AAPCS64,
SysV AMD64, Microsoft x64, Microsoft vectorcall, and RISC-V LP64/LP64F/LP64D.
Each row declares its expected terminal completeness state; a profile-specific
partial result is a valid outcome and must not be upgraded to exact.

## Invalid inputs

The consumer must reject or explicitly mark stale/malformed evidence when the
ABI identity, architecture, platform, Semantic IR version, binary/slice/function
identity, source type/layout, or summary digest does not match. Cancellation,
deadline, truncation, and budget exhaustion invalidate staged exact output.
Unsafe/string/non-finite offsets and sizes, contradictory aggregate piece
placement, and registry replacement with stale cached rules are malformed or
stale rather than exact.

## Consumer responsibilities

### Function-local control uncertainty

Canonical compatibility projection calls `adapter.observeFunction({ semanticIr })`
with the full validated immutable function. It shares the declaration producer's
control-transfer frontier; it does not infer thunks from mnemonics or rendered
text. Ambiguous and budget-limited frontiers reach the adapter's live completeness
and the real enhanced decompiler's own `prototype`. Own-function argument/return
locations, return registers and return classification are withheld, including
when a previously classified return is supplied by the consumer.

This observation is negative evidence only. Resolved observations do not mint
body-equivalence or return-summary proof. Reprojecting the same function is safe;
resolved copies cannot erase prior ambiguity or truncation. Another function on
the same adapter is stale; mutable/malformed observations remain malformed.
Snapshot/context drift and cancellation stay live at the publication boundary.
Separately resolved external callee declarations retain their own scoped
classification; caller function uncertainty must not impersonate callee evidence.

### Inter-function source declaration handoff

`adapter.functionDeclaration({ semanticIr })` exports a version-2 declaration
with basis `canonical-source-declarations` only for a registered supported ABI,
validated immutable function and current nonempty snapshot identity. It binds the
entry address and function ID to the same binary/slice, and preserves ABI semantic,
registry, profile and schema identity. It does not infer a prototype from names or
from the caller's observations.

Callers may supply `calleeDeclarationFor(canonicalTargetAddress, context)` in the
ordinary adapter input. The resolver must return synchronously, with either a
matching declaration record or null. Errors, partial data, mismatched identities
and asynchronous results become unknown. Snapshot producers/providers own record
invalidation; fresh calls are not served from an adapter-private declaration cache.
Agreement metadata binds caller and callee function IDs separately. Contradictions
withhold placements even when only one callsite exists; agreement does not upgrade
partial ABI classification or claim machine-body/return-summary equivalence.

Version 2 additionally requires `controlTransfers` version 1: a bounded list of
unresolved transfer candidates derived from the supplied Semantic IR, with
`resolved`, `ambiguous` or `budget-limited` status. Unknown control effects and
branch/switch destinations represented only by empty target blocks are unresolved.
Canonical missing-fallthrough issues remain unresolved even after CFG projection
has removed the corresponding edge; a remaining known target does not erase them.
Ordinary local branches, loops and returns are not thunk classifications. The
entire supplied function is scanned; without bound CFG reachability evidence no
apparently dead node is discarded. At most 64 candidate records are published;
overflow explicitly reports budget-limited, never a sampled resolved result.

Declaration status must match this control evidence. An ambiguous or budget-limited
callee withholds caller placements and carries that terminal status through the
compatibility projection. Version-1 source records cannot satisfy this new check.
This detects unresolved transfer candidates, not proven thunk forwarding or an
exact tail-call target summary. Those require additional independent evidence.

### Projection

Prototype, aggregate layout, type recovery, summaries, and decompiler rendering
may format or project the canonical fact, but may not add register literals,
architecture heuristics, majority-vote caller/callee inference, or hidden
fallback classifiers. A consumer that cannot represent a canonical partial or
unknown result must preserve the uncertainty and diagnostic rather than claim
exactness.
