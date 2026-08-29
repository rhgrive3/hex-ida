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

## Consumer responsibilities

Prototype, aggregate layout, type recovery, summaries, and decompiler rendering
may format or project the canonical fact, but may not add register literals,
architecture heuristics, majority-vote caller/callee inference, or hidden
fallback classifiers. A consumer that cannot represent a canonical partial or
unknown result must preserve the uncertainty and diagnostic rather than claim
exactness.
