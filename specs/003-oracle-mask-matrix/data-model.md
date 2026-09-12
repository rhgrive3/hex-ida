# Internal matrix record contract

`ORDERING_UNDEFINED_MATRIX` is a recursively frozen array of ten records.
Six cover every `SEMANTIC_MEMORY_ORDERINGS` value exactly once; four cover fully,
partial, conditional and operand-dependent descriptors. Tests lock literal IDs.

Each record has `id`, `kind`, `ordering` (null for non-memory records),
`mustPreserve`, `mustForbid`, `expectedClassification`, and `evidenceScope`.
`machineOrdering: null` means an omitted field that V2 normalizes to unknown.
Undefined inputs carry width, mask, class, reason and an optional condition.

`mustPreserve` is the fixed transport observation: V2 memory accesses, MemorySSA
access metadata and sequencing, V1 memory descriptors, V2 undefined descriptors
and masked V1 outputs. `mustForbid` names prohibited loss/precision upgrades.
Known orderings reference an existing litmus source path, artifact record ID and
permitted/forbidden targets. Those program claims are distinct from transport.

The existing differential vocabulary is reused. `exact/equivalent` means matching
these observations only; every record is `contract-transport-only`, never a new
architectural proof or permission to extract a concrete masked value.
