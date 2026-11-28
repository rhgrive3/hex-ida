# Engineering Process Guardrails

Status: **normative**

This document defines the mandatory engineering-process guardrails for `rhgrive3/hex-ida`. A failure that happens once must become harder to repeat; a failure that happens twice must become a machine-enforced gate, not a reminder.

Normative keywords:

- **MUST / MUST NOT**: merge-blocking requirement.
- **SHOULD / SHOULD NOT**: required unless deviation is explicitly justified in release evidence.
- **MAY**: optional.

If this document conflicts with an ad-hoc prompt, temporary workflow, or branch convention, this document wins unless a reviewed change explicitly updates this contract.

## 1. Non-negotiable principles

1. **One semantic truth, many projections.** Never create a second semantic engine, scheduler, cache identity, release identity, or hidden fallback to turn a gate green.
2. **Unknown stays explicit.** Missing integration or missing evidence is `BLOCKING`, `NOT-INTEGRATED`, `partial`, `unknown`, or another explicit conservative state—never skip-green.
3. **Diagnose the first deterministic divergence.** Do not patch downstream symptoms before identifying the earliest deterministic root cause.
4. **Enforce invariants mechanically.** Repeated process rules MUST be converted into automated tests, ownership validation, or merge-blocking CI.
5. **Exact-head evidence only.** A green run from an old head, old merge tree, old runtime, old generated artifact, or old verifier does not prove the current product.
6. **Source merge is not runtime activation.** Any capability whose proof depends on deployed or in-memory code MUST prove the active commit/build/version, not only repository state.
7. **Target-platform truth beats desktop assumptions.** iOS/iPadOS Safari and WebKit behavior are first-class release constraints.
8. **Generated output is a transaction boundary.** Ownership, generation, synchronization, release identity, and zero-diff verification MUST be designed together.
9. **Moving `main` is normal.** Long-running work absorbs `main` through one defined reconciliation owner rather than creating chains of replacement PRs.
10. **Done means exact product proof.** Implementation, tests, integration, generated-output sync, exact-head verification, and required cutover are separate facts; work is done only when all required facts are true.

## 2. Permanent process rules (EP-001 – EP-031)

| ID | Failure class | Permanent rule |
|---|---|---|
| EP-001 | Late, concentrated integration | Keep a living integration path and permanent exact-SHA verifier from foundation onward. |
| EP-002 | Cross-scope file contamination | Validate actual changed-file inventories against lane allowlists; PR prose is not scope evidence. |
| EP-003 | Generated userscript sync blocking components | Non-owning lanes build/test generated outputs ephemerally without committing them; the integration/release lane owns canonical committed outputs. |
| EP-004 | Contradictory ownership manifests | Self-test ownership manifests with synthetic negative cases and the expected component union; prefer narrow path owners over blanket exemptions. |
| EP-005 | Canonical runner missing nested lane tests | Prove that canonical test runners discover every owned test subtree; direct lane commands are supplemental only. |
| EP-006 | Late verifier release wiring | Wire the permanent exact-SHA verifier invocation path at foundation time. |
| EP-007 | Shared generated outputs triggering old lanes | Separate workflow trigger policy from lane ownership policy and cover both with regressions. |
| EP-008 | Governance fixes regressing | Every governance repair MUST add a permanent regression that fails on the old behavior. |
| EP-009 | Missing post-merge generated sync | After each protected-runtime integration merge, rebuild/commit canonical generated outputs, verify zero diff, and run rolling gates before accepting the next merge. |
| EP-010 | Ad-hoc moving-main churn | One living integration owner reconciles moving `main` before component merge and release cutover. |
| EP-011 | Late verifier maturation | Exercise the independent verifier continuously; any acceptance-semantics change invalidates prior evidence. Synthetic fixtures cannot replace required real-corpus/real-browser proof. |
| EP-012 | Throwaway validation PRs | Provide permanent `workflow_dispatch` / exact-SHA verification workflows for recurring CI proofs. |
| EP-013 | Replacement-PR chains on stale branches | Maintain one authoritative repair branch, reconcile to `main` in place when safe, and close superseded branches promptly. |
| EP-014 | Unbounded CI job fanout | Respect runner concurrency and CPU/RAM limits; prefer local worker parallelism and deduplication before multiplying GitHub jobs. |
| EP-015 | Invalid or partial CI artifacts | Write artifacts atomically to temp paths, validate schema/content before publishing, never publish on failure, and fail closed on empty/partial downloads. |
| EP-016 | Masking hot-path bottlenecks with CI sharding | Profile representative slow fixtures and fix algorithmic hot paths before adding CI fragmentation. |
| EP-017 | Stale release identity | Derive release identity deterministically from deployable build inputs so content changes always advance identity. |
| EP-018 | Dirty tree attested as clean commit | Exact commit attestation requires a clean source tree or immutable CI identity; fail closed to unknown/null otherwise. |
| EP-019 | Truthiness treated as proof | Compare exact typed identities and versions at security, release, and proof boundaries. |
| EP-020 | Implicit privileged bootstrap | Privileged, diagnostic, migration, bootstrap, and destructive modes require explicit opt-in independent of capability detection. |
| EP-021 | Desktop-simplified browser fixtures | Security, bootstrap, and browser tests MUST model production origin, opaque sandbox (`about:srcdoc`), realm, and iframe semantics. |
| EP-022 | Desktop tab assumptions on iOS | Prove browser/platform primitives on iOS/iPadOS first; Dev Workers use single-tab, same-origin iframes (no background tabs/popups). |
| EP-023 | Broad DOM selectors & hydration races | Use exact, scoped selectors/test IDs and hydration-aware conversation identity; add production-faithful regressions for every real-device DOM failure. |
| EP-024 | Generic RPC timeouts on full model turns | Scope timeouts by operation class; short control RPCs stay bounded while model turns are event-driven and cancellable. |
| EP-025 | Async Worker lease/cleanup races | Reserve async resources synchronously before `await`, propagate cancellation end-to-end, release deterministically, and quarantine on uncertain cleanup. |
| EP-026 | Recoverable Dev tool errors aborting runs | Return sanitized structured errors to the Supervisor loop for bounded replanning; keep cancellation and integrity failures terminal. |
| EP-027 | Source merge mistaken for active self-update | Block post-update capability proof until reload proves the active commit, build ID, and userscript version match. |
| EP-028 | Safety budgets punishing progress | Measure no-progress windows and invalid decisions rather than capping verified forward progress. |
| EP-029 | Proxy wrappers breaking frozen interfaces | Wrap frozen/trusted bridges with narrow delegating facades rather than Proxy traps that violate property descriptors. |
| EP-030 | Non-resumable autonomous campaigns | Persist durable checkpoints (completed stages, exact evidence, active runtime identity, blockers) at externally visible transitions. |
| EP-031 | PRs failing their own added tests under red baseline | Every PR MUST pass its own added/changed tests in isolation; shared baseline failures never exempt new tests. |

## 3. Workflow requirements

### 3.1 Preflight & component lanes
- Define machine-checkable exit criteria, frozen contracts, and explicit file ownership before parallel fanout.
- Component lanes edit only owned paths, avoid importing sibling private internals, build generated outputs ephemerally (committing only if owned), and record exact SHA, changed-file inventory, and test results.

### 3.2 Candidate merge-tree & integration checkpoint
- Before merging a component, test the **candidate merge tree** (reconciled with current `main` as needed), not only the isolated component branch.
- After merging a protected-runtime component, lock integration until shared contracts, canonical generated outputs (zero rebuild diff), rolling gates, and independent verification pass on the exact head.

### 3.3 Verifier maturity & production cutover
- Run independent verifiers continuously on real required corpora/toolchains/browsers.
- Before cutover: reconcile with `main`, freeze exact candidate SHA, prove zero generated-output diff, pass all blocking exact-SHA workflows (`node scripts/run-quiet-command.mjs --label check -- npm run check`), verify capability claims match measured evidence, merge with expected-head protection, and confirm live `main` (and active runtime identity if applicable).

## 4. Merge-blocking process gates

Any of the following blocks advancement:
- changed files exceed lane ownership or ownership manifests contradict themselves;
- canonical test runner misses an owned test subtree;
- generated outputs are stale for an owning lane or forced onto a non-owning component lane;
- candidate merge tree is untested or head moved after review without re-verification;
- required verifier, real corpus, or required toolchain is missing, modified without invalidating old evidence, or replaced by synthetic proxies;
- any required artifact is empty, malformed, partial, or from a failed producer;
- unexplained red workflow on the exact release head;
- dirty tree attested as clean commit, or active runtime identity mismatched;
- capability promoted beyond measured maturity;
- repeated process defect lacks an automated regression where feasible.

## 5. Evidence validity and invalidation

Valid evidence binds together: exact commit/tree SHA, base/integration relationship, verifier version, corpus/fixture digests, toolchain identity, generated build/release identity, target browser/runtime identity, and exact-head workflow status.

Discard and re-run evidence whenever verifier rules, corpus provenance, required compiler families, semantic schemas, generated protected runtimes, or verified browser/runtime boundaries change.

## 6. Generated-output transaction contract

- **Component**: source + tests only unless explicitly owning generated output.
- **Component CI**: ephemeral canonical build/test allowed and encouraged.
- **Integration/Release**: owns committed generated outputs (`wasm/hex_engine.wasm`, `js/core/hex-engine-wasm.js`, `userscript/hex.user.template.js`, `userscript/release-version.json`); canonical rebuild MUST produce zero diff.
- **Release identity**: deterministically derived from deployable content.

## 7. Moving-main contract

- One integration owner reconciles `main`; components stay on their frozen base unless shared contracts change.
- Resolve conflicts by semantic ownership; regenerate generated artifacts from reconciled source rather than hand-merging.
- Re-run exact-head review and CI after reconciliation.

## 8. iOS/iPadOS and browser truth contract

- Prove platform-dependent primitives on WebKit/iOS before promoting designs.
- Parallel Dev Workers run in single-tab, same-origin iframes.
- Browser tests MUST model temporal hydration, DOM virtualization, current-realm constructors, opaque `about:srcdoc` sandboxes, and scoped exact selectors.
- Chromium-only passes cannot close WebKit/iOS-specific blockers.

## 9. Required engineering habits

1. Check plans against applicable `EP-XXX` entries before starting large work.
2. Convert any second occurrence of a process failure into automated enforcement.
3. Diagnose the first deterministic divergence before patching downstream symptoms.
4. Ship process fix + regression test as one unit.
5. Verify candidate merge trees, keep verifiers continuous, and fail closed on incomplete artifacts or mismatched runtime identities.

## 10. Phase completion checklist

Work may be reported **DONE** only when all applicable boxes are true:

- [ ] Foundation and ownership contracts validated before fanout;
- [ ] Every component passed actual-inventory ownership and candidate-merge-tree verification;
- [ ] Generated outputs rebuilt canonically with zero diff on the exact product SHA;
- [ ] Moving `main` reconciled through the integration owner;
- [ ] Independent verifier continuously exercised with recorded verifier/corpus/toolchain identities;
- [ ] Required real corpus/compiler/binary/browser/device evidence present with zero unexplained blocking failures;
- [ ] Capability/maturity claims match measured evidence (`js/platform/capability-maturity.js` & `docs/SUPPORT_MATRIX.md`);
- [ ] Canonical integration merged with expected-head protection and verified on refetched `main`;
- [ ] Deployed/in-memory runtime identity separately proven where completion depends on it.

## 11. Updating this document

When a new repeatable process failure occurs, add an `EP-XXX` entry stating the failure class, process cause, permanent rule, and automated regression/gate that blocks recurrence. Do not delete active rules merely because a specific incident was fixed.