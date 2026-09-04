# Discovery Artifact Contract

1. The artifact is immutable and its ID validates its full content.
   Live consumer boundaries additionally require the module-private factory
   issuance brand; a caller-recomputed public checksum is not publication
   authority.
2. Original evidence and interval alternatives are canonical inputs, never
   reconstructed from a selected view. Candidate projections are reconstructed
   with the same shared fusion rules and must be an exact/subset-consistent view
   of that canonical evidence according to analysis completeness. For complete
   publication this exact comparison covers names, regions/ownership, start and
   extent states, evidence, conflicts, architecture, and global overlap
   reconciliation; the caller's candidate digest is ignored as authority.
3. A collision is an unresolved set. Array position, score, producer order, or
   name does not choose an exact member.
4. Function start authority remains the existing ladder: authoritative may be
   exact; two independent corroborators may be probable; heuristic/reference-only
   evidence is heuristic.
5. Producer ID and version remain attached to evidence and references.
   Authoritative evidence additionally requires a live canonical producer-run
   issuance brand; neither a public producer's kind nor a raw authority string
   can claim that brand.
6. Complete publication requires exact binary/source/snapshot/architecture
   binding, nonempty unique producer identities, exact evidence and supplied
   interval counts, compatible producer versions/architectures, complete
   producer runs, and at least one evidence or supplied interval claim.
7. A rebuild consumer receives the full collision/reference sets. Reparse must
   retain every source member or reject with `discovery-reparse-ambiguity-lost`.
   It must separately receive and match the materialized output hash; the
   rebuild binding's source hash is the original input identity and is not
   silently treated as the output identity.
8. Canonical ordering is numeric for addresses and lexical for typed identities.
   The typed identity is framed and JSON-safe, distinguishes bigint from string,
   negative zero from zero, and array holes from null, and covers every retained
   evidence field.
9. The immutable resource authority caps evidence, candidate views, producer
   runs, interval claims, references, and collision work before collision loops.
   Exported defaults are hard ceilings: callers may tighten but never widen any
   field. Primitive array cardinalities are checked before evidence traversal;
   bounded traversal uses data-property descriptors and never invokes raw
   evidence or budget accessors. Exhaustion yields no partial alternatives
   presented as complete.
10. A code extent which strictly contains another discovered start emits a
    `function-contained-start` collision even when that second candidate has no
    extent. Both candidates receive the collision ID.
11. The format-safe transaction factory creates the rebuild binding and the
    loader-reparse validator canonically parses the exact materialized output
    bytes and runs module-owned discovery before checking the transaction
    binary/architecture, output hash, and retained facts. Callback-authored
    artifacts are ignored as authority; unavailable/incomplete parsing fails
    closed.
12. Search presentation first strips all backend-authored discovery fields,
    then adds only a factory-issued artifact projection for matching rows.
13. A partial range is exact only as a range observation. It cannot yield an
    exact whole extent or complete artifact unless a canonical producer emits a
    separate complete-coverage marker for the range group.
14. Caller interval IDs are forbidden. Supplied and evidence-derived IDs are
    typed-payload digests in disjoint namespaces, globally unique, and sorted by
    the complete canonical payload.
15. Discovery reparse authority is the module-owned canonical parse/discovery
    result over an immutable copy of the exact materialized output bytes. It is
    derived inside validator execution after output hashing; callback artifacts,
    hashes, or attestations are insufficient.
16. Discovery-affecting operation domains require source binding. Explicit
    data-only metadata operations do not acquire this requirement solely from a
    file-layout move. Missing required source proof remains `unproven` and fails
    before an external loader callback.
17. Page envelopes, nested pagination/completeness records, result arrays,
    candidates, and search rows are descriptor snapshots. Accessors, structured
    scalar coercions, and backend discovery properties are never evaluated or
    copied into canonical presentation.
18. Canonical output discovery recursively inspects only own data descriptors
    for an explicit parser-status vocabulary. Any complete-false, partial-true,
    non-null partial reason, stopped budget, or equivalent nested indicator
    withholds the output artifact, even when the format-wide status says complete.
19. Publication passes a frozen byte sequence and an identity-only materialized
    view to the promoter. Successful publication additionally requires readable
    committed bytes whose independently computed hash equals the validated
    output; promoter-reported hashes alone are not proof.
20. Validation and publication have fixed non-widenable time/execution ceilings
    and propagate cancellation into canonical parsing/discovery and promoters.
    Authority is withheld when a stop is observed before or after an awaited step.
