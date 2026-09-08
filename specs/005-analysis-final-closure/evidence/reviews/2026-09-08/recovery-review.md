# T019 current recovery review

Date: 2026-09-08

This is a bounded independent implementation review of the recovered T011,
T012, T014, T015, T016, and T017 lanes requested at Stage A source
`8da22cd959241d1d0c61b7ca1f663f77b8e7e982`. The shared primary advanced during
the review to `1dab32bab503ad3ee0c8e82e5b41177966f9e68f`; its changes are outside
the six inspected production path sets (the inspected paths are unchanged from
`8da22cd...`). T013 cache/reference work is covered by the separate
current-cache-reference report. The primary worktree was clean and unchanged by
this review.

## Fresh probes

The external probe source, command record, and JSONL output are:

- [probe source](t019-recovery-probes.mjs.txt)
- [commands](t019-recovery-probes-commands.txt)
- [output](t019-recovery-probes-output.jsonl)
- [source-bound equivalence](t019-source-bound.txt)

Command:

```
/mnt/workspace/.local/hex-final-node22/bin/node t019-recovery-probes.mjs.txt
```

The final run completed 30/30 fresh cases: five adverse cases per lane, with no
failure and no lane stopped early. The first run stopped only because of an
external probe regex typo; it was corrected before the recorded final run. The
cases exercise the production boundaries below.

| Lane | Production boundary and source spans | Fresh cases | Result | Review finding |
| --- | --- | --- | --- | --- |
| T011 | `js/decompiler/passes/stack-return-recovery.js:1766-1870` checks semantic/load/RET proof, cancellation and bounded work, then snapshots, rewrites, and rolls back publication on failure. | `missing-physical-load`, `unknown-barrier-before-load`, `store-load-width-mismatch`, `pre-cancel-preserves-publication`, `printer-failure-rolls-back` | 5/5 | No concrete defect in these recovery and rollback boundaries. Missing/ambiguous physical proof stays unchanged. |
| T012 | `js/decompiler/phase8/analysis-identity.js:14-31,169-212,2182-2247` captures descriptor intrinsics, rejects accessors/incomplete semantic observations, and binds identity to the shape digest. `js/decompiler/phase8/valuenumber.js:971-997,1220-1238` rejects stale identities and publishes immutable GVN facts. | `accessor-is-not-executed`, `proxy-omitted-known-field-fails-closed`, `captured-descriptor-intrinsic-survives-poison`, `gvn-publication-is-read-only`, `semantic-mutation-changes-shape-digest` | 5/5 | No concrete identity/publication defect found. In-place semantic width mutation changes the shape digest. |
| T014 | `js/symbolic/solver/backend.js:87-104` authenticates exact backend instances/fingerprints. `js/symbolic/solver/session.js:88-106,164-178` validates query identity, handles pre-cancel, and rechecks identity before publish. `js/symbolic/verify/query.js:203-251` bounds and recomputes query hashes. | `unsupported-width-is-nonpublishable`, `bounded-variable-budget-is-nonpublishable`, `forged-exact-backend-is-rejected`, `pre-aborted-query-is-cancelled`, `tampered-query-hash-is-invalid` | 5/5 | Unsupported, resource-limited, forged, cancelled, and tampered cases all fail closed. |
| T015 | `js/binary/macho-core.js:14-17,145-180` keeps parser-issued image authority private. `js/apple/knowledge.js:159-223` bounds dyld header/mapping parsing; `:413-452` bounds signature structure; `:599-639` blocks signing-impact claims when structure is malformed. | `macho-authority-is-not-copyable`, `dyld-short-header-is-malformed`, `dyld-unknown-magic-is-unsupported`, `dyld-mapping-count-is-bounded`, `malformed-signature-blocks-signing-impact` | 5/5 | No parser authority, format-boundary, or signing-impact defect found. |
| T016 | `js/analysis/index.js:245-272` fuses producer evidence through the canonical registry. `js/analysis/discovery/canonical-value.js:9-17,138-156` enforces typed-value depth/node/text budgets. `js/analysis/discovery/artifact.js:756-774,812-854` issues bound rebuild authority and rejects identity/ambiguity loss. | `unknown-extent-survives-reparse`, `invented-exact-extent-is-rejected`, `sparse-width-is-budgeted`, `nested-identity-is-depth-bounded`, `cross-binary-reparse-is-rejected` | 5/5 | Unknown extent remains unknown; invented extent and cross-binary reparse are rejected; canonical-value budgets fire. |
| T017 | `js/semantics/effects/index.js:98-132` snapshots strict own data, `:348-357` validates bitvector bounds, `:565-595` validates undefined-result descriptors, and `:607-671` binds descriptor width to exactly one operation output. API names are exact in `js/blocks.js:1-11` and `js/blocks-base.js:96,120`. | `api-near-match-does-not-authorize`, `undefined-result-symbol-field-is-rejected`, `bitvector-width-and-value-are-strict`, `undefined-result-width-must-match-one-output`, `published-undefined-result-cannot-be-mutated` | 5/5 | No API overmatch, coercion/descriptor, width, or publication-mutation defect found. |

## Evidence scope and limits

The 30 cases are fresh local unit-level probes over bounded synthetic IR,
solver, Apple-format, discovery, and MachineEffects inputs. They are evidence
for the listed production boundaries only. They do not prove the combined
decompiler/Phase 8 pipeline, complete solver corpus, broad Apple/dyld corpus,
independent LLVM/readobj oracle, full rebuild transaction, external ISA/formal
coverage, browser/UI integration, performance thresholds, or device execution.
Physical-device evidence remains deferred under the repository guardrails.
The five-fresh-case requirement is satisfied for this bounded review, but T019
must not be marked complete or release-ready from these probes alone.

## Task-owned WebKit environment repair

During this review, the retained UI trace exposed a separate task-owned runtime
dependency failure (`No GSettings schemas are installed`). The repair and exact
package/env/preflight evidence are recorded in
[webkit-gsettings-repair.md](webkit-environment.md).
It changed only the task-owned browser dependency root and environment file;
the actual-page preflight and one UI browser viewport run passed with retained
WebKit stderr. This is environment evidence, not a product or release claim.
