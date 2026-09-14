# MachineEffects Architectural Evidence V2 Contract

The V2 envelope extends, but does not replace, `machine-effects-independent-oracle/v1`.

1. Unknown fields, missing fields, duplicate observables/outcomes, identity drift, and stale digest are malformed.
2. Observable categories are `known`, `undefined`, `implementationDefined`, and `unobserved`; complete evidence partitions `declared` exactly.
3. A relaxed-memory claim declares one canonical ordering, atomicity, and a complete permitted/forbidden partition of its outcome universe.
4. Unknown ordering and incomplete universe are never exact-eligible.
5. `UndefinedResult` is canonical MachineEffects data, not an oracle guess. Consumers encountering a non-zero mask must retain an over-approximation.
6. Evidence generation is offline; production/browser code consumes only canonical MachineEffects and Semantic IR.
