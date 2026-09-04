# Implementation Plan: HEX-SYM-01

## Technical context

The repository already owns an immutable Bool/BV DAG, exact evaluator, strict solver statuses, exact-proof authority, lifecycle-safe sessions, model validation, verification consumers, AI tool wiring, and module-Worker transport. The deployment extends only the solver provider layer.

## Design

1. Preserve `ExhaustiveBvBackend` as the <=8-bit oracle and cancellation-safe fallback.
2. Add `BitBlastBvBackend`: validate the existing DAG, compile every supported node into a Tseitin CNF, then run bounded deterministic watched-literal DPLL.
3. Add `TieredBvBackend`: classify by maximum expression width and exhaustive-domain size, select exact providers only, validate provider identity, and independently validate every SAT model.
4. Make the production registry select the tiered backend directly in non-browser hosts and its dedicated module-Worker transport in browsers.
5. Bind route policy and nested capability fingerprints into the production capability fingerprint.
6. Add deterministic structural evidence and observational startup/solve/memory measurement. Wall time and host-memory deltas never authorize proofs.

## Soundness argument

Each gate is encoded with a bidirectional Tseitin equivalence. Fixed-width arithmetic circuits discard carry above the declared width. Unsigned division uses restoring division with explicit zero-divisor overrides; signed division applies two's-complement absolute values/sign restoration plus the specified zero and overflow boundaries. The DPLL search returns UNSAT only after exhausting both assignments for every unresolved decision. Search interruption returns a non-proof status. SAT assignments are reconstructed by canonical symbol ID and checked against the original DAG by the independent evaluator.

## Scope

Expected production files are limited to `js/symbolic/solver/**`. Direct AI code already consumes `defaultSolverRegistry`, so no AI production edit is required. Tests remain in `tests/phase9/**`; measurement/verifier changes remain in `tools/validation/phase9/**`; this is the only new spec directory.

Forbidden areas remain untouched: `js/decompiler/**`, `js/semantics/**`, architecture truth, workflows, ownership manifests, existing threshold/denominator/assertion reductions, generated userscript, and dependencies.

## Risks and mitigations

- DPLL without clause learning may hit budgets on difficult formulas. This is a performance limitation, not a soundness exception: the outcome is `resource-limit`.
- Bit-blasting div/rem creates large CNF. Variable/clause ceilings and worker termination bound the deployment.
- Main-thread fallback cannot preempt synchronous compilation via a timer callback, so compilation checks its own deadline at every allocation/clause boundary; worker termination is authoritative in browsers.
- Desktop WebKit emulation does not prove iPad memory pressure or scheduling. Physical-device evidence remains open.

## Verification order

Focused solver tests; complete Phase 9 tests; measurement harness; browser worker tests where installed; repository lint/check; exact diff inventory; exact-head local commit. No release-ready claim until external physical-iPad evidence is attached.
