# Data Model: HEX-C2-01

## `ByteForwardingQuery`

An immutable query input containing the current validated MemorySSA artifact, the load use or
entity identifier, access metadata, current analysis identity, cancellation signal, and bounded
resource options. It is not a new analysis artifact and has no independent alias or reaching-
definition state.

## `ByteForwardingResult`

An immutable result with:

- `status`: `exact`, `unknown`, `partial`, `unsupported`, `stale`, `cancelled`, or `budget-limited`;
- `reason`: deterministic machine-readable explanation for every non-exact result;
- `widthBits` and `endian` copied from the canonical load access;
- `bytes`/value only when `status === exact` and all bytes are proven;
- `loadRange`: width-exact byte start/end represented with BigInt-safe canonical strings;
- `contributingDefinitionIds`: sorted or canonical-order IDs for every winning store;
- `provenance`: load, region, alias-provider, definition, and source-origin evidence;
- `identity`: proof digest and source artifact identities used for invalidation;
- `completeness`: validated artifact/provider/cancellation/budget state.

No exact result may contain a missing lane. A non-exact result must not expose a staged value as
complete.

## Byte range

`ByteRange` is a half-open `[start, end)` interval with canonical BigInt/string serialization and
positive byte length. Width must be a positive multiple of eight. Store ranges are derived from
their canonical access metadata; load and store address identity must be proven before ranges can
be compared.

## Proof identity

The proof identity binds the binary/function/snapshot identity, Semantic IR and MemorySSA contract
and build identity, analyzer/version, access entity IDs, definition/use links, alias relation
evidence, ordered winners, endian/width, and provenance digest. Any change to a bound input
invalidates the result.

## Canonical access binding

The canonical builder also emits one immutable `canonicalAccessBindings` row for every serialized
use/definition access row. Each binding covers the MemorySSA entity, entity kind, source/node and
region identity, access role/index/order, memory/sequencing/origin/range/access/alias proof
digests, and canonical store-value digest. The query requires a one-to-one binding-table match
before it considers any load or store evidence. This prevents an IR-less serialized artifact from
redirecting a selected use or definition by changing metadata and re-signing only its local proofs.

## State transitions

```text
validated input -> bounded proof walk -> complete byte assignment -> exact publication
                 \-> explicit non-exact result (hole/uncertainty/stale/malformed/cancel/budget)
```

The publication transition is atomic: no consumer observes a partially assigned byte buffer as
exact.
