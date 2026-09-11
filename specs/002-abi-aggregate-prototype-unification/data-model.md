# HEX-C3-02 ABI Evidence Data Model

This document describes the contract that will be implemented at the existing
ABI-plugin/`semanticAbiAdapter` boundary. It does not create a new runtime
classifier.

## ABI profile identity

| Field | Meaning | Required exactness guard |
|---|---|---|
| `architectureId` | Canonical target architecture, including requested profile context such as arm64e | Must match the analysis input. |
| `platformId` | Platform/sub-ABI selector | Must be explicit when more than one profile matches the architecture. |
| `abiId` | Registered ABI plugin id | Must resolve to one supported canonical plugin. |
| `semanticVersion` / `semanticIdentity` | Versioned ABI semantics | Any mismatch invalidates cached facts. |
| `callingConvention` | Requested convention, when present | Must be claimed by the selected plugin. |
| `supported` | Plugin support state | `false` cannot publish exact placement. |

## Classification fact

A classification result is scoped to one function or call and contains:

- ordered argument or return positions;
- physical register pieces and/or stack pieces;
- ABI class, width, aggregate/member piece order, and hidden-result role;
- stack offset, alignment, padding, and register-save/frontier facts where
  proven;
- `identity` pointing to the profile identity above;
- `provenance` pointing to classifier evidence and Semantic IR origin;
- `completeness` with one of `exact`, `partial`, `unsupported`, `unknown`,
  `stale`, `malformed`, `cancelled`, `truncated`, `budget-limited`, or
  `conflict`;
- diagnostics and invalidation dependencies.

`exact` is allowed only when all bytes/register pieces relevant to the requested
fact are proven and no unresolved aggregate, vararg, indirect-call,
caller/callee, thunk, or tail-call ambiguity remains. A multi-piece result is
not exact if one piece is unknown.

## Aggregate placement

An aggregate argument/return records each piece in canonical order. Each piece
identifies its register or stack location, width, offset, ABI class, and
alignment/padding relation. Split register/stack placement remains split; a
consumer may not repack pieces. Hidden sret records both the hidden input
location and the fact that the user-visible return is indirect. HFA/HVA records
member count and class only when member/layout evidence is complete. For a
forced-stack AAPCS64 HFA/HVA, the physical element span comes from the canonical
member layout and each element occupies an ABI stack slot of at least eight
bytes; the aggregate byte span, alignment, piece `byteOffset`, and `stackOffset`
are derived from that same physical layout. A following stack argument may not
overlap any element slot.

Padding is evidence, not a size hint: every padding span has a finite safe
integer byte offset and size, no padding/member spans overlap, and the sorted
member-plus-padding spans cover the aggregate exactly. Unlocated, duplicate, or
overflowing padding is malformed evidence.

## Variadic and unknown prototype state

Known fixed parameters are exact only for the fixed prefix proven by the profile.
Anonymous variadic arguments carry a possible/unknown frontier and register-save
or stack evidence. Unknown prototypes, indirect calls, and contradictory
caller/callee observations retain alternatives and cannot become exact merely
because a register is live.

## Direct-call observation contradictions

Within one decoded function, the existing callsite prototype authority groups
observations by validated direct target address. Unknown targets are not grouped.
Instruction-bound declarations keep precedence over resolver declarations, and
each callsite resolver result is evaluated once and shared with CFG construction.

The canonical adapter compares complete, non-variadic argument placements and
proven return placements for that target. Contradictory physical facts publish
`conflict`, withhold argument/return locations, and retain the
`abi-callsite-observations-conflict` diagnostic through the compatibility IR.
Names, type spelling, confidence and observation majority are not comparison
authority. Contradictions do not propagate to another target.

Argument and return proofs are checked independently: a missing return placement
does not erase a complete argument contradiction. Conversely, an unknown aggregate
return may make hidden-sret and argument placement unproven, in which case those
partial argument observations cannot prove contradiction. A null return classifier
result is not itself proof of a void return.

Matching observations only preserve the original classifier result; they do not
prove independent caller/callee agreement or upgrade partial evidence. Missing,
stale and anonymous variadic observations are not contradiction proofs. Comparison
reads current prototype objects rather than caching an old physical signature.
Groups larger than 64 observations publish `budget-limited` without sampling a
prefix or claiming agreement. The per-target index is constructed once, and each
classification performs at most 64 observation comparisons.

This local contradiction evidence is not automatic thunk/tail-call discovery or
an independent callee-definition proof. Those remain separate required evidence.

## Bound caller/callee declaration comparison

Direct recursive calls can compare their instruction-bound source prototype
against the current function's independent `functionPrototype` declaration.
The adapter validates immutable Semantic IR, node membership, decoded origin,
constant direct target, binary/slice identity and canonical function-start ID.
External callees and custom/unmatched function identities remain `unknown`.

The optional `callerCallee` record has version 1 and the explicit basis
`canonical-source-declarations`. Complete canonical physical argument and return
signatures can produce `agreement`; a proven contradiction in either produces
`conflict` and withholds placements even for a single callsite. Source names are
not compared. Missing, stale, variadic or unsupported declarations remain unknown;
a null return classifier does not prove void. The declaration is read again on
each request, and cancellation invalidates agreement. Compatibility validates the
record's version, node, origin, target, function and ABI identities before carrying
it into call metadata. Agreement never upgrades original partial ABI evidence.

This is declaration consistency, not machine-body equivalence, cross-function
summary proof or automatic thunk/tail-call discovery. Those broader requirements
remain open; same-target caller consensus alone still cannot establish agreement.

## Invalidation dependencies

The following invalidate a published fact or summary: architecture/platform/ABI
identity or semantic version; binary, slice, function, or call-target identity;
Semantic IR schema/pass versions; source prototype/type/layout evidence; summary
digest; classifier input/evidence digest; and cancellation/deadline/budget state.
Publication must be atomic: an invalid or incomplete replacement cannot leave a
previous exact result visible under a new identity.

Physical stack intervals are validated globally for each exact argument and
return result. Overlap is rejected, including duplicate scalar evidence at one
interval; the sole permitted duplicate is an explicitly identified projection
of one canonical split aggregate. Registry-backed caches bind to the actual
frozen plugin object and to a deterministic registry generation/classifier
digest, so replacing a profile with the same semantic id invalidates old
placement rules.

## State transitions

```text
unclassified
  -> exact       (supported + identity-valid + complete + conflict-free)
  -> partial     (some facts proven; unresolved alternatives retained)
  -> unknown     (identity/evidence insufficient)
  -> unsupported (profile does not implement the requested ABI)
  -> malformed   (evidence violates the classifier contract)
  -> stale       (identity or dependency no longer matches)
  -> cancelled / truncated / budget-limited
```

No state except `exact` may be promoted to an exact ABI placement or exact
prototype. Failed runs publish no replacement exact fact.
