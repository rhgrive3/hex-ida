# Canonical Byte-Forwarding Contract

## Input

The direct consumer accepts the current canonical MemorySSA contract plus the load use/access
entity and current identity context. It must validate the contract and use links before reading
definitions. The alias relation and clobber kind come only from MemorySSA; callers cannot override
them with a hint.

## Exact result

An exact result is valid only when every byte of the load interval is assigned to a concrete
`memory-def`, each assignment is backed by a `must` alias/use proof, all overlapping winners have
canonical order, all definitions and origins are complete and current, and the endian contract
produces one deterministic width-exact value. The proof lists all winning definition IDs and
source origins.

## Refusal result

The consumer returns an explicit non-exact status for a byte hole, unknown/may alias, any clobber
or phi ambiguity, uncertain order, incompatible width/endian, volatile/atomic uncertainty,
unsupported effect, malformed/stale evidence, provenance conflict, cancellation, deadline, or
resource/iteration limit. The result never assumes zero for an uncovered lane.

## Publication

Only this canonical result may be translated into the existing compatibility/value fact. A
consumer must reject the result when its identity or snapshot no longer matches. No decompiler,
points-to, or architecture-private fallback is allowed to publish an exact value.
