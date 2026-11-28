# ADR-0009: Solver Backend Architecture and Provider Selection

- **Status**: Accepted (live production implementation)
- **Last Updated**: 2026-11-28
- **Scope**: `js/symbolic/solver/` — Local-first exact QF_BV solver backend architecture

## 1. Context and Constraints

Hex performs targeted formal verification (conditional edge feasibility, global reachability, bounded equivalence, and patch verification) over Semantic IR v2 under strict platform constraints:

1. **Browser & iPad-first (No COOP/COEP dependency)**: Must run reliably in Safari/WebKit on iPadOS, desktop browsers, userscript/CSP contexts, and Node/CI without requiring cross-origin isolation (`SharedArrayBuffer`).
2. **Offline-first & Privacy**: Binary structures, addresses, and derived constraints must stay local; remote solver egress is prohibited by default.
3. **Bounded & Cancellable Execution**: Solver runs must enforce explicit expression, clause, decision, assignment, and wall-time budgets, and support cancellation and worker teardown.
4. **Deterministic Exact Proof Authority**: Production defaults must only permit exact decision procedures (`PROOF_AUTHORITY.EXACT`) verified by `isExactProofBackend()`.

## 2. Decision

Hex adopts a **pure-JS local-first exact QF_BV tiered solver architecture** with optional WebWorker isolation, rather than bundling Z3/cvc5/Bitwuzla WASM as the default production provider:

| Backend | ID / Version | Proof Authority | Role |
| :--- | :--- | :--- | :--- |
| `ExhaustiveBvBackend` | `hex-exhaustive-bv` `1.0.0` | `exact` | Deterministic finite-domain complete enumeration oracle for narrow (`<= 8`-bit) Bool/BV queries. |
| `BitBlastBvBackend` | `hex-bitblast-qfbv` `1.0.0` | `exact` | Exact bit-blasting QF_BV decision procedure supporting up to 64-bit bitvectors with explicit SAT/clause/decision/propagation budgets. |
| `TieredBvBackend` | `hex-tiered-qfbv` `1.0.0` | `exact` | Production QF_BV router combining `ExhaustiveBvBackend` (narrow oracle tier) and `BitBlastBvBackend` (wide tier up to 64-bit). |
| `WorkerSolverBackend` / `TieredWorkerSolverBackend` | `hex-exhaustive-bv-worker` / `hex-tiered-qfbv-worker` `1.0.0` | `exact` | Browser WebWorker isolation transports (`worker-entry.js`, `tiered-worker-entry.js`, `worker-protocol.js`) enabling responsive UI and hard worker termination. |
| `HeuristicSolverBackend` | (non-exact) | `heuristic` | Non-proof heuristic backend; ineligible as production default. |
| `FakeSolverBackend` | `test-fake-solver` `1.0.0` | `test-only` | Deterministic test double (`createTestSolverRegistry()` only). |

### Production Registry Selection (`js/symbolic/solver/registry.js`)

`defaultSolverRegistry = createProductionSolverRegistry()` enforces `allowNonExactDefault: false`:

- **Browser targets (`typeof globalThis.Worker === 'function'`)**: Selects `WorkerSolverBackend({ maxBvWidth: 64 })`.
- **Node / CI targets**: Selects `TieredBvBackend` directly.
- Any query outside supported sorts (`bool`, `bv`) or configured limits fails closed with `UNSUPPORTED` or `RESOURCE_LIMIT` under the strict 9-status `SOLVER_STATUS` taxonomy (`sat`, `unsat`, `unknown`, `timeout`, `resource-limit`, `unsupported`, `cancelled`, `provider-failure`, `invalid-query`).

## 3. Rationale Against External WASM / Remote Defaults

- **Z3 / cvc5 / Bitwuzla WASM**: Standard browser builds (e.g., `z3-solver`) require COOP/COEP (`SharedArrayBuffer`), large multi-megabyte WASM bundles, and Emscripten heap lifecycle handling incompatible with iPad/userscript CSP constraints. External WASM adapters remain optional future extensions behind explicit capability verification.
- **Remote SMT Gateways**: Violate Hex's offline-first and binary-privacy invariants; strictly prohibited as default or silent fallback.

## 4. Consequences

- Zero external WASM or network runtime dependencies for exact Bool/QF_BV verification up to 64-bit.
- Uniform deterministic behavior across browsers and Node/CI, with explicit `measured-only` memory reporting rather than unenforceable hard memory cap claims.
- Clear fail-closed boundary (`RESOURCE_LIMIT` / `UNSUPPORTED`) when queries exceed finite QF_BV budgets or unsupported theories.
