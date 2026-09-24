## Engineering process safety

For any master-phase, component-lane, living-integration, release/cutover, generated-output, ownership/governance, CI, moving-main reconciliation, Dev Supervisor, or iOS/browser automation work, read `docs/ENGINEERING_PROCESS_GUARDRAILS.md` before acting.

Its `MUST` / `MUST NOT` rules are merge-blocking. Do not replace an exact-head, candidate-merge-tree, generated-output, independent-verifier, active-runtime, or target-device requirement with a weaker proxy. A repeated process failure must gain a permanent automated regression where technically possible. A phase is not done until the applicable completion checklist in that document is satisfied.

## Low-token test execution

When an agent needs a broad test or release-gate run, suppress successful chatter instead of sending thousands of passing lines back into model context.

- Run heavy repository suites, real-game checks, and performance benchmarks on `rhgrive3/actions` GitHub Actions at the **exact pushed Hex commit SHA**. Dispatch independent checks as parallel Actions runs/jobs, with bounded fanout that respects runner limits (`docs/ENGINEERING_PROCESS_GUARDRAILS.md` EP-014). Keep focused local tests local when they are cheap.
- Use the existing `hex-suite-runner.yml` for broad suites and `hex-lane-{quality,realgames,perf}.yml` or the dedicated exact-SHA workflows for their respective evidence. Run the canonical full gate as one unchanged command, `node scripts/run-quiet-command.mjs --label check -- npm run check`; parallel supplemental commands never replace that gate or an independent verifier.
- Record the target SHA, workflow/run IDs, conclusions, and validated artifacts. A queued, failed, cancelled, stale-SHA, or missing-artifact run is not passing evidence. Do not run several heavy suites locally when Actions can run them in parallel.

- Full repository gate: `node scripts/run-quiet-command.mjs --label check -- npm run check`
- Full regression chain: `node scripts/run-quiet-command.mjs --label test -- npm test`
- Shared Phase 8–10 runners are quiet by default; use the whole-command wrapper for other broad suites.
- A successful quiet run prints only its bounded summary. A failed whole-command run prints a bounded failure tail and retains the complete local log path.
- For diagnosis, rerun the smallest failing command with `HEX_TEST_OUTPUT=verbose` to restore full output.
- Do not replace the canonical `npm run check`, verifier, denominator, exact-head, or release semantics. Quiet execution changes presentation only, never what is tested.

## Task management and reactive wakeup

- Do **not** poll or repeatedly call `manage_task` (such as looping on `status` or checking progress frequently) to wait for background commands or test completion.
- Rely strictly on reactive wakeup notifications from the messaging system. When a background task finishes, the system automatically sends a message to wake you up.
- Only invoke `manage_task` when explicit operational action is strictly necessary (e.g., cancelling an obsolete command with `kill` or sending required interactive stdin with `send_input`), never for polling or frequent status checking.

## Subagent delegation

These rules apply whenever any agent (Codex, Claude Code, Cursor, etc.) spawns subagents, delegates background research, or parallelizes execution.

- **MUST NOT** use default/ordinary builtin subagents (e.g. built-in Sonnet/Opus subagent spawns), whichever method below is in use.
- Waiting on subagents follows **Task management and reactive wakeup** above: no polling loops.

### Choosing the method (first matching rule wins)

1. **The user names a method → use that method.** If the user explicitly asks for Cline ("use Cline", "send it to Cline", "use `./cline-<N>`", "use Cline subagents") or Freebuff ("use Freebuff", "send it to Freebuff", "use `./freebuff-<N>`", "use 8 Freebuffs"), use exactly that method with its rules below, as far as possible. Do not substitute `opencode --auto` or another method.
2. **No method named → default `opencode --auto` with Gemini 3.8 Flash High** (`gemini-3.8-flash-high` / `proxlane/gemini-3.8-flash-high`), e.g. `opencode --auto "<task prompt>"`. Treat this quota as practically unlimited: parallelize aggressively for research, independent review, counterexample search, file edits, and test analysis.
3. **Default unavailable → Cline or Freebuff.** If the default route does not work (for example the provider returns `No available accounts`, authentication fails, or it gives no response), continue with Cline (`./cline-<N>`) or Freebuff (`./freebuff-<N>`) under their rules below instead of stopping the task. Return to the default when it works again, unless the user named a method.

Priority: **explicit user choice > Cline / Freebuff rules > `opencode --auto` default.**

### Cline (`./cline-<N>`)

- **Numbers:** use `1`–`8` first. `9` also exists, but it may share an account with another number, so it is **not** an independent extra free quota. Use `9` only when `1`–`8` do not give enough parallelism, when the other numbers' free quota is exhausted, or when the user explicitly allows or asks for `9`.
- **Model order** (each model has its own daily free quota; switching model continues the work):
  1. `DeepSeek v4.1 Flash` — reasoning `xhigh` (start here).
  2. `Muse Spark 1.3 Contributor` — reasoning `xhigh`, when DeepSeek's daily free quota is no longer usable.
  3. `MiMo 2.6 Flash`, when Muse is no longer usable either.
- Running out of one model's free quota is **not** a reason to end Cline work. If another model can continue, switch and continue.
- Cline may stop (quota exhausted, Cline-side stop) **without** returning a clear failure to the parent. When a Cline subagent may have stopped, check its state, produced artifacts, `git diff`, and logs, then hand the remaining work to the next model or another number. Check status only when the task has not come back, has clearly stalled, or you need the result to proceed; never with short-interval `manage_task status` loops.

### Freebuff (`./freebuff-<N>`)

- **Numbers:** `1`–`9`. Independent tasks may run on several numbers in parallel. Do not put several agents on the same file or the same fix area without a plan.
- **Model by wallet balance:**
  - Comfortable balance → `DeepSeek v4.1 Flash` — `high`.
  - Balance including savings down to about 10 → `MiMo 2.6 Flash`. DeepSeek v4.1 Flash costs about 10 even off-peak, so never spend the last ~10 on DeepSeek.

### Common rules for every method

- **The parent agent keeps final responsibility.** Never mark work done on a subagent's claim alone; verify with `git diff`, `git status`, the changed files, test results, CI results, and benchmark results as needed.
- **Task brief:** include, as far as possible, the goal, the scope, what is allowed, what is forbidden, the required tests, and the completion criteria.
- **Split work into independent pieces** (implementation, adversarial review, counterexample search, testing, benchmark analysis, a separate issue, …). Do not hand the same problem to several agents for no reason and waste free quota; intentional duplication for independent verification is allowed.
- **Stopped subagent → hand off, do not restart.** Whether Cline, Freebuff, or OpenCode, collect what exists (completed work, remaining work, changed files, git diff, test status, important findings) and pass it to the next agent, for example:

  ```
  TASK
  DONE
  REMAINING
  CHANGED FILES
  TEST STATUS
  IMPORTANT FINDINGS
  ```
- **Quota or model exhaustion does not stop the whole job.** Continue with another model, another number, or another method, as long as it does not contradict the user's explicit choice.

### Parent supervision — Codex and Claude Code only

This subsection applies **only when Codex or Claude Code is the parent coordinating subagents**. OpenCode, Cline, and Freebuff subagents should follow their own task brief; they do not inherit the parent's duty to supervise other lanes.

- **Resume from durable state.** Read the latest session, checkpoint, lane prompts, runner scripts, logs, and worktree state before launching anything. Keep a persistent roster of the authorized lanes, each lane's runner or task ID, worktree, evidence path, completion marker, and current owner. Do not create extra lanes when the user has limited the set.
- **Actually launch and watch.** Start each authorized unfinished lane once, using the method selected above. Confirm that the runner started. Attach a completion or exit wakeup (the tool's reactive task notification, a wait on the child process, or an event-driven watcher for a detached runner's terminal marker). A detached launch without a wakeup is not supervision. Never clear a lease or restart a lane until its prior process is confirmed dead.
- **No frequent polling.** While lanes run, do useful parent work. Do not repeatedly query `manage_task status`, process lists, logs, or pool leases. A specific dependency, a credible stall, or a completion/exit notification may justify a check. If a runner cannot send a notification, use a watcher that wakes on completion or a meaningful stall threshold, not a short-interval status loop.
- **One batch on each wakeup.** When any lane finishes, exits, or stalls, inspect its result and take **one combined status snapshot of every other active lane**: runner alive, terminal marker, recent progress, artifacts, and lease/account state where relevant. This catches silently stopped Cline/Freebuff/OpenCode work without separate repeated checks. Hand off unfinished work with the common handoff fields above, then relaunch an authorized replacement and watch it.
- **Parent verifies and integrates.** Check changed files, tests, CI, and evidence before accepting a lane. Update the persistent roster and integrate verified results; keep the remaining lanes watched until they finish or have an explicit blocker.


<!-- graft:start -->
## Graft — repo context graph

### Environment gate — VS Code only

The Graft workflow in this section applies **only** when the task is running inside VS Code.

- **Inside VS Code:** use Graft first for repository context as described below. If Graft is unexpectedly unavailable, continue with the normal repository tools available in that VS Code environment rather than blocking the task.
- **Outside VS Code:** do **not** install, invoke, emulate, or require Graft. Do not treat Graft's absence as a blocker. Use the repository inspection/search tools available in the current environment instead.

This repo is indexed in `graft/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

When running inside VS Code, for ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `graft map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `graft grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `graft skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `graft callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `graft ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `graft build` (deterministic,
no API key, $0).
<!-- graft:end -->
