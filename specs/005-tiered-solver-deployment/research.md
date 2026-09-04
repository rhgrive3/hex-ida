# Research: HEX-SYM-01

## Existing substrate

- `solver/backend.js` already defines exact proof authority and capability fingerprints.
- `solver/exhaustive-backend.js` is a genuine finite-domain decision procedure, but defaults to width 8.
- `solver/session.js` already invalidates timeout/cancel/stale/disposed results before publication.
- `verify/validate-model.js` independently evaluates SAT witnesses.
- `solver/worker-backend.js` and `worker-entry.js` already provide local module-Worker isolation.
- `ai/tools/registry-base.js` already obtains `defaultSolverRegistry.getDefaultBackend()`, so changing the production registry activates the tier without a parallel tool path.

## Alternatives considered

| Alternative | Decision | Reason |
| --- | --- | --- |
| External/native solver process | Rejected | Breaks offline browser/iPad deployment and introduces runtime/provenance dependencies. |
| New npm/WASM SMT package | Rejected | No solver package is already vendored; adding a dependency without established provenance/licensing is out of scope. |
| Heuristic algebraic solver | Rejected | Cannot prove UNSAT and must never be proof authority. |
| Extend exhaustive enumeration to 64 bits | Rejected | Sound but not production-capable. |
| In-repo bit blasting + complete DPLL | Selected | Dependency-free, browser-safe, exact when it terminates, and naturally fail-closed under budgets. |

## Evidence limits

The Playwright WebKit run uses a desktop engine with an iPad viewport/user agent. It exercises module loading, structured clone, Worker transport, BigInt, 64-bit solve, and lifecycle wiring, but it is not evidence about a physical iPad's memory-pressure termination, background scheduling, or Safari build. That evidence cannot be generated in this environment.
