# Function discovery E / B1a — downstream noreturn refinement design

Status: design complete; report-only. No production source or tests are changed by this lane.

Branch: design/function-discovery-noreturn-refinement  
Base: main at 011caf34c5680284b5d781e45ba8d04a9d417c43

## 1. Decision

B1 remains rejected. Bootstrap discovery must not consume the interprocedural summary that is built from discovery's own function/entity model:

    bootstrap discovery D0
      -> SymbolIndex/function ownership T0
      -> ProgramIndex + function entities E0
      -> local/interprocedural summaries S0
      -X-> D0

B1a is implementable without that back-edge as a stratified, one-wave, append-only topology refinement:

    D0 -> T0 -> E0 -> S0 -> proposal P0 -> topology commit T1
                                          |
                                          +-> no call back into D0

    T1 invalidates E0/S0 consumers.
    They rebuild on demand under T1.
    The B1a producer does not schedule a second automatic wave
    for the same discoveryKey.

Cluster B is not a proven binary-correctness bug. The investigation shows the ten reference boundaries are strictly inside an ELF STT_FUNC span, have no independent symbol/FDE/direct-branch authority, and IDA itself warns about the split. Therefore D0 remains the binary-faithful discovery result. B1a is a convention/reference refinement and must be explicitly enabled by product policy.

Two earlier B1a assumptions need correction after tracing current code.

1. Do not invalidate symbols.functionStartsComplete or functionDiscovery.complete. In demand-driven-runtime.js they describe whether the bootstrap discovery producer was truncated. With attempted:true and the same discoveryKey, ensureFunctions() returns without rerunning the producer; resetting attempted would rerun bootstrap discovery. Neither behavior is a topology invalidation mechanism.
2. Do not route B1a through js/rebuild/transaction-v2.js. That transaction is for byte rewrites: offsets, before/after bytes, source hashes, format/architecture checks, output materialization and independent byte validation. B1a changes analysis topology only and needs a small domain-specific transaction.

## 2. Existing contracts

| Contract | Current anchor | B1a consequence |
| --- | --- | --- |
| Bootstrap discovery identity | js/analysis/demand-driven-runtime.js | discoveryKey and complete keep their existing meaning |
| Symbol mutation generation | js/symbols.js addFunctions() | real start additions bump symbols.gen; duplicates are no-ops |
| ProgramIndex binding | js/program.js and shared-app-artifacts.js | `ProgramIndex.gen` currently aliases `symbols.gen`; B1a therefore must additionally bind the exact ProgramIndex/scan evidence it consumed, because generation alone is not an independent call-graph identity |
| Function analysis cache | js/analyze.js | future keys miss on symbols.gen; transaction also cancels old in-flight work |
| Investigation binding | js/analysis/investigation-service.js | symbol-generation change makes old bindings stale |
| AnalysisQuery snapshot | js/analysis/query/app-adapter.js + api.js | current identity lacks a function-topology revision and must gain one |
| Interprocedural noreturn | js/analysis/summary/interprocedural.js | only complete/current locally-defined summaries can authorize refinement |
| Scoped summary execution | js/analysis/query/semantic/summary-slice.js | B1a cannot depend on whichever summary a user happened to request first |

symbols.gen is necessary but not sufficient as the semantic snapshot identity. It changes for non-topology edits too, while AnalysisQuery snapshot currency currently compares binaryId, projectRevision, analysisEpoch and artifactVersions without symbol topology.

Add a separate monotone symbols.functionTopologyRevision. Increment it only when effective function ownership changes. createAppAnalysisQueryAdapter().currentIdentity() derives a reserved artifactVersions.functionTopology = { revision: symbols.functionTopologyRevision }; this internal value wins over caller-provided data. Old query/summary snapshots then become stale after T1 without bumping backend.gen.

backend.gen remains the byte/slice analysis epoch. B1a must not change it.

## 3. Producer

New logical producer: noreturn-continuation/v1.

The producer is read-only. It runs only after bootstrap discovery and a complete direct-call ProgramIndex exist, captures one immutable T0 binding, and returns one immutable proposal. It never mutates SymbolIndex and never calls ensureFunctions() after summary solving begins.

### Inputs and binding

Capture at prepare start:

- binary/slice identity;
- backend.gen;
- functionDiscovery.discoveryKey;
- symbols object identity;
- symbols.gen;
- symbols.functionTopologyRevision;
- digest of the current sorted function-start set;
- ProgramIndex object identity, generation and completeness;
- canonical digest of the exact direct-call/scan evidence consumed from that ProgramIndex;
- current AnalysisQuery snapshot identity.

### Candidate derivation

1. Enumerate ProgramIndex direct-call records in canonical (caller address, target address) order.
2. Keep only calls whose target exactly equals an existing locally-defined function start.
3. Reject imported/model-only/unresolved/ambiguous/indirect targets.
4. Build the direct-call closure needed for the candidate under the same T0 ProgramIndex and load canonical local summaries through a shared summary-loader owner. Do not depend on a prior user query.
5. Use fixed finite limits. Missing, stale, incomplete, truncated, cancelled or unconverged closure/summary results carry no authority.
6. The callee authorizes refinement only when its summary is identity-current, status.completeness is complete, and noreturn is exactly true.
7. Load the caller's current instruction/CFG projection. The continuation address is the decoded end of the exact call instruction, never a hard-coded +4.
8. Require the caller CFG/incoming-edge projection used for reachability to be identity-current and complete. A partial, truncated, capped, cancelled, stale or otherwise incomplete CFG cannot authorize a split from the absence of a predecessor. An implementation may alternatively use a narrower incoming-edge proof only if that proof explicitly establishes complete predecessor coverage for the continuation.
9. Require the continuation address to be executable and a decoded instruction boundary.
10. Substitute the proven noreturn behavior by removing only the call's ordinary fallthrough edge. If any other live intra-function CFG predecessor reaches the continuation, reject the candidate.
11. Require the continuation to lie strictly within the caller's current source/ownership span and not already be a function start.
12. Canonically sort and deduplicate all candidates.

The producer must finish the whole fixed-budget enumeration before publication. Global truncation means an incomplete proposal and zero topology mutation; never publish a query-order-dependent prefix.

Suggested immutable envelope:

    {
      schema: "function-topology-refinement-proposal/v1",
      producer: { id: "noreturn-continuation", version: "1.0.0" },
      binding: {
        binaryId, sliceId, analysisEpoch, discoveryKey,
        symbolsGeneration, functionTopologyRevision,
        startSetDigest, snapshotId, programGeneration,
        programEvidenceDigest
      },
      status: { completeness: "complete", stopReason: null },
      candidates: [{
        start, callerStart, callSite, calleeStart, calleeFunctionId,
        callInstructionEnd, summaryDigest, cfgDigest,
        provenance: {
          source: "noreturn-continuation-refinement",
          convention: "post-noreturn-split"
        }
      }]
    }

No benchmark case ID, function name, fixed address or section-name special case participates in the rule.

## 4. Consumer

New logical consumer: FunctionTopologyRefinementTransaction.

This is the only writer. It accepts only a complete proposal and performs one compare-and-swap commit against the captured T0 binding.

It owns:

- current-binding validation;
- atomic append-only function-start insertion;
- an effective split boundary for the predecessor owner;
- exactly one topology-revision bump for a non-empty topology change;
- invalidation/cancellation of derived consumers;
- a per-discoveryKey completed-wave marker.

It does not own binary bytes, loader reparsing, source hashes, or rebuild publication.

## 5. Transaction boundary

The transaction is split into an asynchronous prepare phase and a synchronous validate+commit phase.

### Prepare: read-only and cancellable

All summary/CFG work happens here. It may allocate an immutable proposal but does not alter app, symbols, program or discovery state.

### Validate+commit: synchronous CAS

Immediately before the first mutation, re-check all captured identity:

- same binary/slice;
- same backend.gen;
- same symbols object identity;
- same symbols.gen;
- same functionTopologyRevision;
- same start-set digest;
- same discoveryKey;
- same ProgramIndex object identity;
- same ProgramIndex generation;
- same canonical ProgramIndex/scan evidence digest;
- AnalysisQuery snapshot still current;
- proposal status is complete;
- candidate batch still satisfies local/executable/nonduplicate legality;
- same producer version has not already completed a wave for this discoveryKey.

Any mismatch returns stale and performs zero mutation.

After validation, no await or potentially throwing analysis work is allowed. Validate the entire batch before the first write, then commit as one topology operation:

1. append all new starts and provenance;
2. install the corresponding effective ownership split boundaries;
3. bump symbols.gen once and functionTopologyRevision once;
4. record the completed wave marker;
5. clear app.program, but retain raw app.programScan and its reusable scan evidence;
6. call the existing clearAnalysisCache() to cancel old in-flight analyses and clear old settled analysis results;
7. publish the normal symbol/viewer change notification.

A zero-candidate or already-applied transaction is a no-op: no generation bump, no topology revision bump, no cache clear.

js/rebuild/transaction-v2.js must not be imported.

## 6. Exact span versus effective ownership

A plain addFunctions() insertion is insufficient for B1a.

Current SymbolIndex can retain an explicit exact end from the original seed. Example:

    STT_FUNC caller source extent = [0x1000, 0x1040)
    call local_fatal at          = 0x1010
    B1a continuation candidate   = 0x1014

If 0x1014 is only appended to the start set while caller's explicit end remains 0x1040, consumers can still describe the old caller as owning addresses after the new start. That creates overlapping entity ownership.

Do not overwrite the original exact source end and pretend it was disproven. Separate:

- declared/source extent evidence, e.g. [0x1000,0x1040);
- effective topology bound used by functionAt/functionStartAt/functionWindowBound/ProgramIndex range calculations, capped at 0x1014 after refinement.

The new start therefore changes effective ownership while preserving raw loader/symbol evidence for diagnostics and provenance.

## 7. Cache invalidation

A successful T1 commit invalidates or makes stale:

- SymbolIndex effective function topology and symbols.gen;
- ProgramIndex object bound to the old symbol generation: app.program is cleared;
- function analysis cache and in-flight analysis work via clearAnalysisCache();
- AnalysisQuery/scoped snapshots through artifactVersions.functionTopology;
- semantic summary/query sessions derived from the old topology;
- investigation bindings, which already reject changed symbols.gen;
- any in-flight shared Program producer captured against the old symbol generation, which must fail its existing generation check.

It deliberately retains:

- symbols.functionStartsComplete;
- symbols.functionStartsCapped;
- symbols.functionDiscovery.complete;
- symbols.functionDiscovery.attempted;
- symbols.functionDiscovery.discoveryKey;
- backend.gen;
- app.programScan/raw scan evidence;
- bytes, loader artifacts, strings and other byte-derived caches.

Rebinding ProgramIndex after T1 should reuse the retained programScan but build a fresh ProgramIndex against the new SymbolIndex generation.

## 8. Idempotence and epoch model

Start mutation is a canonical set-union. Duplicate starts are no-ops.

Use a stable transaction identity containing at least:

    binary/slice
    + backend epoch
    + discoveryKey
    + producer id/version
    + base topology revision
    + base start-set digest
    + ProgramIndex/scan evidence digest
    + proposal digest
    + summary snapshot/digests

Applying the same proposal twice returns already-applied on the second attempt without cache/generation effects.

For two concurrent prepares from the same base, only one can commit. The first changes symbols.gen/topology revision; the second fails the CAS or observes the wave marker.

Record one completed noreturn-continuation/v1 wave per bootstrap discoveryKey. Rebuilding E/S under T1 does not automatically schedule T2. This is the minimum architecture's explicit cycle breaker.

This one-wave rule can miss a second-order boundary that only becomes provable after the first split. That limitation is preferable to an implicit fixpoint cycle. Any future multi-wave design must separately define and test a finite monotone lattice/cap.

Transient failures do not mark the wave completed and can be retried explicitly against the still-current binding. Deterministic budget exhaustion reports incomplete and never commits a prefix.

## 9. Failure modes

| Condition | Result |
| --- | --- |
| ProgramIndex direct-call graph incomplete/capped/unsupported | no proposal authority; no commit |
| local summary/closure exceeds fixed budget | incomplete; no partial commit |
| callee summary missing/stale/partial/truncated/cancelled/unconverged or noreturn != true | no candidate |
| target imported/model-only/indirect/ambiguous/not exact local start | no candidate |
| caller instruction/CFG unavailable, stale, partial, truncated, capped, cancelled or otherwise incomplete | no candidate; absence of a predecessor is not authoritative |
| continuation non-executable/not decoded boundary/already a start | reject or no-op |
| any live predecessor other than removed noreturn fallthrough reaches continuation | reject |
| continuation outside caller/source span | reject |
| binary/slice/backend.gen/symbols object/symbols.gen/topology rev/start digest/ProgramIndex object/program evidence digest/discoveryKey/snapshot changes | whole transaction stale; zero mutation |
| global candidate enumeration truncated | zero mutation; report incomplete reason |
| duplicate/concurrent transaction | exactly one effective commit |
| old query/session tries to publish after T1 | stale publication rejected |
| completed wave requested again | no automatic second wave |

All authority failures are fail-closed.

## 10. Synthetic counterexamples

### 10.1 Live predecessor false-green

    caller:
        cbnz    w0, .Lcontinuation
        bl      local_fatal      // complete local noreturn summary
    .Lcontinuation:
        add     w1, w1, #1
        ret

A naive "instruction after a local noreturn call is a new function" rule splits .Lcontinuation. That is false: .Lcontinuation is still reachable inside caller through cbnz. The producer removes only the now-impossible call fallthrough, sees the remaining live CFG predecessor, and emits no candidate.

### 10.2 Exact-span overlap false-green

    STT_FUNC caller = [0x1000, 0x1040)
    call local_fatal at 0x1010
    candidate = 0x1014

A valid convention refinement may add 0x1014, but effective ownership for the 0x1000 function must stop at 0x1014. Raw declared end 0x1040 remains source evidence. A consumer must not still return the 0x1000 function as the effective owner for 0x1020.

### 10.3 Partial-CFG predecessor omission false-green

Use the same control flow as 10.1, but force the caller CFG producer to truncate before publishing the `cbnz -> .Lcontinuation` edge while retaining the noreturn call and its ordinary fallthrough. A naive consumer removes the call fallthrough, observes no remaining predecessor and splits `.Lcontinuation`. That is invalid because predecessor absence was inferred from incomplete evidence. The proposal must carry no authority unless the CFG (or a narrower incoming-edge proof) establishes complete predecessor coverage for the continuation.

### 10.4 Same-generation ProgramIndex replacement false-green

Prepare P0 against ProgramIndex object A at `symbols.gen = 7`, with call evidence digest `DA`. Before commit, replace `app.program` with a different ProgramIndex object B constructed under the same `symbols.gen = 7`, with digest `DB != DA`. `ProgramIndex.gen` remains 7 for both, so a generation-only CAS would accept stale call-graph evidence. The transaction must compare the captured ProgramIndex object identity and canonical evidence digest, detect the replacement, and perform zero mutation.

## 11. Concrete implementation files for a future production lane

No production files are changed by this report.

| File | Future change |
| --- | --- |
| new js/analysis/discovery/noreturn-refinement.js | read-only deterministic producer; local direct-call enumeration, complete-CFG/incoming-edge authority gate, summary gates, immutable proposal with ProgramIndex evidence digest |
| new js/analysis/discovery/topology-refinement-transaction.js | CAS validate+commit, wave marker and invalidation; no rebuild-v2 dependency |
| js/symbols.js | functionTopologyRevision, declared-vs-effective boundary separation, atomic batch topology mutator |
| js/analysis/shared-app-artifacts.js | explicit ensureNoreturnFunctionRefinement() after stable ProgramIndex; capture/re-check exact ProgramIndex object and canonical scan/call evidence identity; single-flight wave; retain programScan |
| js/analysis/query/app-adapter.js | reserved artifactVersions.functionTopology in current snapshot identity |
| js/analysis/query/scoped-service.js + new shared summary-loader helper | factor canonical local-summary loading so B1a and query summary slices share one owner |
| js/analysis/summary/interprocedural.js | no transfer-function change expected; reuse existing noreturn lattice/session solver |
| js/analyze.js | no semantic change expected; reuse clearAnalysisCache() |
| js/rebuild/transaction-v2.js | no change and no dependency |

Required orchestration is downstream and explicit:

    ensureProgram(T0)
      -> ensureNoreturnFunctionRefinement(T0)
      -> ensureProgram(T1/rebind)

ensureFunctions() must not invoke B1a. The B1a producer must not invoke ensureFunctions() after capturing T0.

## 12. Focused tests for the implementation lane

Suggested new location: tests/phase7/function-discovery/.

1. Positive local noreturn: complete local callee, exact direct call, no other CFG predecessor -> one start and one effective split boundary; declared STT_FUNC end preserved.
2. Live-predecessor counterexample above -> zero starts.
3. Partial-CFG predecessor omission: truncate/remove the alternate incoming edge from the published CFG while keeping the noreturn call/fallthrough visible -> zero starts because incomplete CFG cannot prove predecessor absence.
4. Same-generation ProgramIndex replacement: prepare against object A, replace with object B under identical `symbols.gen`/`ProgramIndex.gen` but different canonical call evidence -> transaction stale, zero mutation.
5. Local-only authority: imported/model-only/indirect noreturn -> zero starts.
6. Summary fail-closed: unknown/partial/truncated/cancelled/stale/unconverged -> zero starts.
7. Transaction stale fence: mutate each of backend.gen, symbols.gen, topology revision, ProgramIndex object/evidence digest, discoveryKey or AnalysisQuery artifact version between prepare/commit -> zero mutation.
8. Idempotence: same proposal twice -> second added=0 and no generation/revision/cache effect.
9. Concurrent CAS: two same-base prepares -> exactly one commit.
10. Cache invalidation: pre-T1 ProgramIndex/query snapshot/summary cannot publish after T1; raw programScan is reused by a fresh ProgramIndex.
11. Completeness semantics: functionStartsComplete, functionDiscovery.complete, discoveryKey and backend.gen are unchanged by T1.
12. Cycle guard: instrument backend.guessFunctions; one B1a wave triggers neither another bootstrap discovery nor an automatic second B1a wave.
13. Exact-span overlap: effective ownership becomes non-overlapping while original declared source end remains available.
14. Determinism: shuffled raw direct-call records produce the same proposal and transaction digest.
15. Budget all-or-nothing: forced enumeration/summary closure truncation commits no prefix.
16. Dependency guard: refinement modules do not import rebuild/transaction-v2.js and materialized binary bytes/source hash stay unchanged.

Existing focused contracts used while producing this report:

    node --test       tests/phase7/issue-4243-region-cache-slice-identity.test.mjs       tests/phase7/issue-4487-shared-app-artifacts-symbol-generation.test.mjs       tests/phase7/issue-5267-discovery-producer-retention.test.mjs       tests/phase7/summary/issue-4061-noreturn-control-lattice.test.mjs       tests/phase7/integration/analysis-query-app-wiring.test.mjs       tests/issue-4116-symbols-structured-address.mjs

Report-lane result: 14/14 pass with a 30-second external timeout.

## 13. Final architecture verdict

The minimum cycle-free B1a architecture is:

    one-wave downstream read-only proposal
      + synchronous function-topology CAS commit
      + separate function-topology snapshot revision
      + explicit effective-boundary overlay

It deliberately does not reset bootstrap discovery completeness, does not bump the byte-analysis epoch, does not invoke rebuild/transaction-v2.js, and does not run an implicit fixpoint.

Product policy still decides whether the convention is enabled at all.

Invariant:

> Bootstrap discovery never consumes semantic summaries; semantic noreturn evidence may only add convention-qualified topology starts in a later, separately versioned wave, and every pre-wave entity/summary consumer becomes stale before the new topology is observable.
