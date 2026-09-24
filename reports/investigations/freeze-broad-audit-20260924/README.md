# Freeze broad audit — 2026-09-24

Pre-freeze audit of **`rhgrive3/hex-ida`** for **non-algorithmic production
risk**. Base revision: `main` @ `a5fd5618e`
(`perf(elf): prefetch dynamic metadata ranges … (#9551)`).

**Result: 0 confirmed Critical, 0 confirmed Major, 0 freeze blockers.**
"A finding" here requires a concrete, reproducible execution path — not a
theoretical concern. Following the instruction "0 findings is acceptable; do
not manufacture issues," the honest outcome of this pass is negative.

Audit-only: **no production code was modified.** The only files written are
under this report directory.

---

## 1. Scope investigated

Categories requested and worked: CLI lifecycle; worker lifecycle,
termination and cancellation; IPC/message ordering; stale state reuse; cache
invalidation and cache-key collision; file replacement / atomic publish; temp
files; cleanup and rollback; concurrent request isolation; abort/timeout
propagation; Promise-rejection handling; resource cleanup (FD/process/timer
leaks); malformed-input boundary; API validation; product/session lifecycle;
snapshot/session identity; path handling; serialization boundary; partial
failure; race conditions; retry idempotency; and test/deploy harness
correctness.

### Files read in full or in the relevant regions (primary auditor)

| Area | Files |
| --- | --- |
| CLI / test harness | `scripts/run-quiet-command.mjs`, `scripts/run-one-check.mjs`, `scripts/run-check-parallel.mjs` |
| Deploy / atomic publish | `scripts/deploy-production.mjs`, `scripts/write-deployment-identity.mjs`, `scripts/stable-repository-source.mjs` |
| Fixtures | `scripts/fetch-real-fixtures.mjs` |
| Generated output | `scripts/sync-generated-userscript.mjs` |
| Rebuild transaction | `js/rebuild/transaction-v2.js` (1302 lines) |
| Cache / project identity | `js/cache/analysis-cache.js`, `js/project/artifact-index.js`, `js/core/artifacts/backends.js` |
| AI control / transport / jobs | `js/ai/control/tool-window.js`, `js/ai/transport.js`, `js/ai/jobs/index.js` |
| Listener isolation / rejection handling | `js/adapters/index.js`, `js/debug/remote-protocol.js`, `js/analysis/query/lazy-app-adapter.js` |
| Misc silent-catch review | `js/backend.js` (disasm cancellation region), `js/names.js` (legacy migration region) |

Method: for each candidate, establish entry point → exact code path →
violated invariant → minimal counterexample → user-visible impact → severity →
why existing tests miss it. Candidates failing the "concrete counterexample"
bar were rejected.

### Delegated independent pass — did not complete

Three parallel audit lanes (`js/ai/**`; `js/userscript/**` + `js/rebuild/**` +
`js/cache/**` + `js/project/**`; `scripts/**` + `tools/validation/**`) were
launched via `opencode run --auto -m proxlane/gemini-3.8-flash-high` per
`AGENTS.md`. All three processes terminated without writing output (one lane hit
`Ripgrep JSON record exceeded 65536 bytes`; all three left no artifact). Their
absence is recorded here rather than papered over: **no delegated-lane result
was used.** Every conclusion below rests on the primary auditor's own reading of
the source. The unread remainder of `js/userscript/**` and `js/ai/dev/**` is the
main residual coverage gap.

## 2. Excluded handoff scope

Per the user's scope decision, this audit did **not** cover: FAST
snapshot/digest/pass-manager performance; C++ RTTI/vtable/member projection;
goto/structuring; locals/types/globals/TU decls; Pinpoint/Jev; wall-clock
analysis budgets; OpenMW/OpenTTD accuracy; the 160-case benchmark; final freeze
mechanics; HANDOFF-known issues; and the user's own open issues (#9550, #9534,
#9523). HANDOFF in-progress lanes A–J were treated as owned elsewhere.

## 3. Confirmed Critical

**None.**

## 4. Confirmed Major

**None.**

## 5. Rejected false positives

Full detail in `checked-areas.md`. Summary:

- **R1 (harness, fail-closed, not a bug):** `run-quiet-command.mjs` rethrows the
  log-stream error when `firstInfrastructureKind === 'log'`. Deliberate — a run
  whose diagnostics cannot be captured must not report PASS; the child process
  tree was already terminated by `recordInfrastructureError`.
- **R2 (harness):** `waitForChild` resolves on first of `error`/`close` — the
  `settled` guard prevents double resolution and spawn errors are surfaced, not
  swallowed.
- **R3 (harness):** `run-check-parallel.mjs` carries its own shell parser that
  could in principle diverge from the serial `&&` chain — no divergent input
  demonstrated; the parser fails closed (throws), and `npm run check` remains the
  release authority.
- **R4 (deploy):** cleanup failures do not mask the primary error — cleanup
  errors are aggregated (`AggregateError`) and separately warned when the deploy
  already committed.
- **R5 (deploy):** `/proc/self/fd` handoff is Linux-only — platform-gated by
  design, not a defect on the supported deploy platform.
- **R6 (cache):** `AnalysisCache.get(hash, {artifactId})` looks like it can
  return a record without re-checking a live binary hash — rejected: the
  canonical artifact id is the content identity, and `#isCorruptOrStale` still
  requires a non-empty stored `binaryHash`. No reproducible stale-hit path.

Additional candidates inspected and rejected by construction: rebuild
`transaction-v2.js` (triggered-issuance `WeakSet`s, re-derived identities,
byte-exact operation-region re-check — fail-closed), `js/ai/jobs/index.js`
(interrupted `running` checkpoints recover to `checkpointed` via
`recoverPersistedRunningCheckpoint`; the swallowed `save` in the slice-error
catch still rethrows the original error and the durable `running` state is
recovered, not stuck), `js/ai/transport.js` (bounded streaming read, external
abort listener attached and removed in `finally`), and the listener-isolation
helpers (already hardened for #5931).

## 6. Duplicates

| Item | Disposition |
| --- | --- |
| #9550 stable-directory close failure suppresses retry | Open, user-owned — not re-reported |
| #9534 userscript rollback / re-substituted backup leaf | Open, user-owned — not re-reported |
| #9523 fixtures cleanup masks primary download error | Open, user-owned — not re-reported |
| #9520 / #9524 fixture publication guards | Already fixed — not re-reported |
| PR #9556 phase7 SSA digest reuse | Perf lane — outside scope |

No candidate in this pass duplicated a HANDOFF known-issue.

## 7. Freeze-blocker presence

**None detected.** No Critical or Major non-algorithmic production defect was
confirmed with a reproducible execution path. Given the residual coverage gap
noted in §1, this statement is bounded by what was actually read; it is not a
claim of exhaustive coverage of `js/userscript/**` or `js/ai/dev/**`.

## Artifacts

- `findings.json` — machine-readable result (empty `findings` array + schema).
- `checked-areas.md` — coverage table, dedupe ledger, rejected candidates.
- `reproductions/` — intentionally empty (see its README).
