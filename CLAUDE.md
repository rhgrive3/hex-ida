## Done means done

Current Hex completion objective and resume state: read `docs/HEX_COMPLETION_GOAL.md` and `docs/CLAUDE_CODE_HANDOFF_20260925.md` before continuing the campaign.

Not half done. Not done except for the part you decided to skip. And not a report about how it will be done.

Five things asked means five things delivered, no matter how long they'll take. If the fifth is genuinely blocked, finish the other four and name the blocker in one sentence. The specific blocker. Not "this needs more investigation."

For master-phase, integration, release/cutover, generated-output, ownership/governance, CI, moving-main reconciliation, Dev Supervisor, or iOS/browser automation work, `docs/ENGINEERING_PROCESS_GUARDRAILS.md` defines what "done" means operationally. Read it before acting. Its `MUST` / `MUST NOT` rules are merge-blocking, and its applicable phase-completion checklist must be satisfied before claiming completion.

## Act. Don't ask.

Reversible and cheap? Do it, then tell me. Research, data pulls, analysis, drafts, refactors inside the scope I gave you, testing an API. A question costs me more than a re-run costs you.

Ask first only for: anything reaching an audience, anything we cannot undo, anything expensive.

Something is broken? Fix it. Reporting an issue you could have fixed turns your work into my to-do list.

## A question is a question

When I ask a question, answer it. Do not implement it.

"Should we use X?" is not "migrate everything to X." "What would it take to add Y?" is not "add Y."

When in doubt, assume it's a question. Answer first. Act when I say go.

## Low-token test execution

For broad tests, do not stream thousands of successful test lines into the model context.

- Run heavy suites, real-game checks, and performance benchmarks on `rhgrive3/actions` GitHub Actions for the exact pushed Hex SHA. Dispatch independent checks in parallel with bounded runner fanout; use `hex-suite-runner.yml`, `hex-lane-{quality,realgames,perf}.yml`, or a dedicated exact-SHA workflow. Record run IDs, conclusions, and validated artifacts. See `AGENTS.md` → "Low-token test execution" for the full rule.

- Full repository gate: `node scripts/run-quiet-command.mjs --label check -- npm run check`
- Full regression chain: `node scripts/run-quiet-command.mjs --label test -- npm test`
- Shared Phase 8–10 runners are quiet by default; use the whole-command wrapper for other broad suites.
- On failure, use the bounded failure tail first. Open the retained full log only when the tail is insufficient.
- Rerun only the smallest failing command with `HEX_TEST_OUTPUT=verbose` when full diagnostics are needed.
- Quiet mode changes output only. Never weaken, skip, replace, or shrink canonical tests, verifiers, denominators, exact-head checks, or release gates to save tokens.

## Graft — GitHub Codespaces only

Use Graft **only** when running inside GitHub Codespaces.

- **Inside GitHub Codespaces:** follow the Graft-first workflow in `AGENTS.md`. If Graft is unexpectedly unavailable, continue with the normal repository tools available in that Codespace rather than blocking the task.
- **Outside GitHub Codespaces:** do **not** install, invoke, emulate, or require Graft. Its absence is never a blocker. Use the repository inspection/search tools available in the current environment instead.

## Speed and subagent delegation

Optimize for wall-clock speed. Finish tasks quickly. The full subagent rules are in `AGENTS.md` → "Subagent delegation"; this is the same policy.

- **No builtin subagents:** when spawning subagents, delegating background research, running verification, or parallelizing execution, DO NOT use standard built-in subagents (e.g. Sonnet/Opus subagent spawns).
- **Which method (first match wins):**
  1. **User names a method → use it.** "Use Cline" / `./cline-<N>` → Cline. "Use Freebuff" / `./freebuff-<N>` → Freebuff. Never swap in `opencode --auto` instead.
  2. **No method named → `opencode --auto "<task prompt>"`** with Gemini 3.8 Flash High (`gemini-3.8-flash-high` / `proxlane/gemini-3.8-flash-high`). Treat its quota as practically unlimited; delegate repetitive searches, file edits, reviews, counterexample searches, and independent verification passes.
  3. **Gemini / opencode unavailable** (e.g. `No available accounts`, auth failure, no response) → keep going with Cline or Freebuff; return to the default when it works again.
- **Cline (`./cline-<N>`):** numbers `1`–`8` first; `9` may share an account with another number, so use it only when 1–8 are not enough, their free quota is gone, or the user allows it. Models in order: `DeepSeek v4.1 Flash` xhigh → `Muse Spark 1.3 Contributor` xhigh → `MiMo 2.6 Flash`. One model's daily quota running out is not a reason to stop: switch model or number. Cline can stop silently; if it may have stopped, check its artifacts, `git diff`, and logs, then hand off.
- **Freebuff (`./freebuff-<N>`):** numbers `1`–`9`. `DeepSeek v4.1 Flash` high while the wallet has room; when about 10 remains (savings included) use `MiMo 2.6 Flash` — never spend the last ~10 on DeepSeek.
- **Parent owns the result:** never call work done on a subagent's claim alone; check `git diff`/`git status`, changed files, tests, CI, and benchmarks. Give each subagent the goal, scope, allowed/forbidden actions, required tests, and completion criteria.
- **Stopped subagent → hand off, don't restart:** pass TASK / DONE / REMAINING / CHANGED FILES / TEST STATUS / IMPORTANT FINDINGS to the next agent, model, or number. Quota exhaustion never stops the whole job if another option fits the user's instruction.
- **No polling:** wait for reactive wakeups; check a subagent only when it has not come back, has clearly stalled, or you need its result to proceed.
- **Codex / Claude Code parent supervision:** follow `AGENTS.md` → "Parent supervision — Codex and Claude Code only". On resume, read the durable session and lane roster, launch each authorized unfinished lane once, confirm its runner, and attach a completion/exit wakeup. A detached launch alone does not count as monitoring. When one lane ends or stalls, verify its result and take one combined snapshot of all other active lanes so silently stopped work is handed off promptly. Keep the roster and evidence current. This parent duty does not apply to OpenCode, Cline, or Freebuff subagents.
- Parallelize aggressively. Independent tasks run at the same time, never one after another — batch tool calls, spawn subagents concurrently.
- Keep working in the main thread while subagents run — don't sit idle waiting on them.
- Don't over-deliberate. Enough info to act = act. No long option surveys for decisions with an obvious default.
- Speed never trades away quality: same rigor, same verification, same "done means done". If parallelizing risks a worse result, slow down.
- No conflicts from parallelism: never let two subagents touch the same files or overlapping scope. Split work by non-overlapping boundaries; merge and reconcile results in the main thread. Intentional duplication for independent verification is allowed; pointless duplication that burns free quota is not.

### Dev Supervisor overlap exception

The no-overlap rule above remains the default. For the Admin Dev subsystem only, an explicit Dev Supervisor decision may intentionally assign overlapping Worker ownership when the Supervisor determines that overlap improves the result. Do not infer this exception without that explicit Dev Supervisor decision.

### Dev Supervisor iOS tab model

Dev Supervisor Worker automation must use one ChatGPT browser tab on iOS/iPadOS. Do not require, provision, or depend on background Safari Worker tabs, `?hex-worker=1`, popups, or BroadcastChannel-based Worker execution.

Parallel Workers run as same-origin ChatGPT **iframes** inside that one tab (ChatGPT sends `x-frame-options: SAMEORIGIN`). The parent page drives each Worker document directly; nothing is opened in another tab or window.

Single-tab lane (no pool): Workers are logical ChatGPT conversations that run sequentially in the Supervisor tab. A Worker turn must finish, its result must be captured, and the Supervisor conversation must be restored before the next Supervisor turn.

## Short responses

It's been a long day and my brain is fried, talk to me like I'm 5.

Small words, short sentences, short paragraphs. If you have to use a big word, explain it right after. Only return what's actually necessary.

Just tell me what you did, did it work, what do I do now.

If I have to decide something: 2 options max, the context I need to pick fast, and which one you'd go with.

Keep paths and commands exact.

Always use ASD-STE100 Simplified Technical Japanese when you talk to me
