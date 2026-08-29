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
member count and class only when member/layout evidence is complete.

## Variadic and unknown prototype state

Known fixed parameters are exact only for the fixed prefix proven by the profile.
Anonymous variadic arguments carry a possible/unknown frontier and register-save
or stack evidence. Unknown prototypes, indirect calls, and contradictory
caller/callee observations retain alternatives and cannot become exact merely
because a register is live.

## Invalidation dependencies

The following invalidate a published fact or summary: architecture/platform/ABI
identity or semantic version; binary, slice, function, or call-target identity;
Semantic IR schema/pass versions; source prototype/type/layout evidence; summary
digest; classifier input/evidence digest; and cancellation/deadline/budget state.
Publication must be atomic: an invalid or incomplete replacement cannot leave a
previous exact result visible under a new identity.

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
