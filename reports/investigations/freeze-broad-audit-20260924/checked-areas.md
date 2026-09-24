# Checked areas — freeze broad audit (2026-09-24)

Repo: `rhgrive3/hex-ida`. Reviewed tree: `main` @ `9f3f1d63e8e9c08b4f6200f444e9cb81e773ea36`.
This is the exact PR base commit for #9566; all conclusions below are bounded
to that pinned tree.

Audit-only: no production code was modified. Standard: every finding must show
entry point → exact code path → violated invariant → minimal counterexample →
user-visible impact → severity (Critical/Major only) → why existing tests miss it.
"Theoretically possible" candidates are discarded.

## Directly inspected (primary auditor)

| Area | Files read | Result |
| --- | --- | --- |
| CLI/test harness lifecycle | `scripts/run-quiet-command.mjs` (full), `scripts/run-one-check.mjs` (full), `scripts/run-check-parallel.mjs` (full) | No confirmed Critical/Major. See rejected candidates R1–R3. |
| Deploy / atomic publish | `scripts/deploy-production.mjs` (full), `scripts/write-deployment-identity.mjs` (full), `scripts/stable-repository-source.mjs` (full) | No confirmed Critical/Major. See R4–R5. |
| Fixture fetch/publish | `scripts/fetch-real-fixtures.mjs` (full) | Overlaps open issues #9520/#9523/#9524 — treated as duplicate, not re-reported. |
| Generated-output userscript lane | `scripts/sync-generated-userscript.mjs` (full) | No confirmed Critical/Major. |
| Rebuild transaction v2 | `js/rebuild/transaction-v2.js` (full, 1302 lines) | Fail-closed by construction (triggered-issuance WeakSets, identity re-derivation, byte-exact operation-region re-check). No confirmed finding. |
| Analysis cache | `js/cache/analysis-cache.js` (full) | No confirmed finding. See R6. |
| Project artifact index | `js/project/artifact-index.js` (full) | No confirmed finding. |
| Tool window control plane | `js/ai/control/tool-window.js` (full) | No confirmed finding. |
| Listener isolation / rejection handling | `js/adapters/index.js`, `js/debug/remote-protocol.js`, `js/analysis/query/lazy-app-adapter.js` (relevant regions) | Hardened for #5931; no confirmed finding. |

## Delegated lanes — attempted, did NOT produce output

Three lanes were launched with `opencode run --auto -m
proxlane/gemini-3.8-flash-high` (ai / userscript+rebuild+cache+project /
harness). All three terminated without writing any file; one hit
`Ripgrep JSON record exceeded 65536 bytes`, and none left a `subauth/*.md`.

**No delegated-lane result was used in this report.** Every conclusion below is
the primary auditor's own reading. Residual coverage gap: the unread remainder
of `js/userscript/**` and `js/ai/dev/**`.

## Explicitly excluded (per user scope)

FAST snapshot/digest/pass-manager perf; C++ RTTI/vtable/member projection;
goto/structuring; locals/types/globals/TU decls; Pinpoint/Jev; wall-clock
analysis budgets; OpenMW/OpenTTD accuracy; the 160-case benchmark; final freeze;
and everything on the HANDOFF known-issues list.

## Dedupe ledger

- Open issues (do not re-report): #9550, #9534, #9523.
- Open PR: #9556.
- HANDOFF known issues: #9528, #9547, real-game harness `value` bug, `js/rtti.js`
  `readVtable` fixed-slot over-read, #9533, #9530, root gate fix, OpenTTD
  `semantic:false`.
- Fixed already: #9520/#9524 fixture publication guards.

## Rejected candidates (no finding)

- **R1 — quiet wrapper throws on log-stream failure instead of returning a
  structured result.** `scripts/run-quiet-command.mjs` rethrows
  `firstInfrastructureError` when `firstInfrastructureKind === 'log'` after
  `log.end()`. Rejected: this is deliberate fail-closed behavior (a command whose
  diagnostics could not be captured must not report PASS); `main()` converts it
  to exit code 1, and the child tree was already terminated via
  `terminationController.request()` from `recordInfrastructureError`.
- **R2 — `waitForChild` resolves on the first of `error`/`close`.** Rejected:
  `settled` guard makes double-resolution impossible, and the spawn-error case is
  explicitly classified (`spawnFailure`) and surfaced, not swallowed.
- **R3 — parallel runner has its own shell parser, which could diverge from the
  serial `&&` chain.** Rejected as "theoretically possible" without a concrete
  divergent input; the parser fails closed (throws) rather than mis-executing,
  and the canonical `npm run check` remains the release authority.
- **R4 — deploy cleanup failure masking the primary error.** Rejected: cleanup
  errors are aggregated (`AggregateError` + `recordCleanup`) and separately
  warned when the deploy already committed, so the primary error is preserved.
- **R5 — `/proc/self/fd` handoff is Linux-only.** Rejected: platform-gated by
  design; not a defect on the supported deploy platform.
- **R6 — analysis cache `get(hash, {artifactId})` can return a record without
  re-checking the live binary hash.** Rejected: the artifact id is the canonical
  content identity, and `#isCorruptOrStale` still requires a non-empty stored
  `binaryHash`; no reproducible stale-hit path was constructed.
