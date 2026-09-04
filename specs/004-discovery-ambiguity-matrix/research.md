# Research and Existing-Contract Decisions

## Reuse audit

The supplied historical head `f92eba96c15137aab4de5aadfe6bae45cf180968`
has merge-base `6886c3f18d97799c0634ca9ab961b284c5837f99`, not the frozen base. Its
base-to-head comparison includes hundreds of unrelated changes/deletions.

Only two commits are unique to X-03:

- `8ed2d53a`: draft spec/tasks plus a 10-case Phase-1 test.
- `f92eba96`: one HEX-X-03 ledger cell update.

Sound ideas reused: overlap symmetry, code/data references remaining
corroborating, authority-ladder negatives, adjacency, and input-order replay.
The old files are superseded because they explicitly excluded rebuild proof,
expected no production change, did not define an artifact, and did not cover
identity, partial producers, ToolRegistry, malformed producer outputs, symbolic
relocations, or faithful reparse consumption.

## Current contract audit

- `FunctionCandidate` correctly keeps start and extent independent.
- `reconcileOverlaps` correctly withdraws ambiguous extents but returns only the
  working view; raw alternative intervals still exist in evidence.
- `DiscoveryProducerRegistry` previously returned evidence and producer IDs but
  not producer versions or run completeness.
- `functionCandidates` is the public production boundary and already owns
  producer orchestration.
- ToolRegistry `search_functions` is the production user/model presentation path.
- Rebuild transaction v2 already binds `expectedOriginalState` into transaction
  identity and passes the full transaction to `loaderReparse`; no rebuild engine
  change is required.

## Decisions

- Keep conflicts as sets; never add a preferred member.
- Preserve raw claims alongside the conservative candidate view.
- Use content-derived collision IDs so permutation replay is exact.
- Treat relocation/vtable/jump-table targets as corroborating references, not
  exact starts.
- Require complete producer-run identity for publishable artifacts.
- Compare source collision/reference IDs during reparse; missing members fail.
- Reuse the current ToolRegistry result/projection path instead of creating a
  parallel UI model.
