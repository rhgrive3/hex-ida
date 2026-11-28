## Done means done

Read `docs/HEX_COMPLETION_GOAL.md` and `docs/ENGINEERING_PROCESS_GUARDRAILS.md` before starting integration, release, or quality-gate work.

Not half done. Not done except for the part you decided to skip. And not a report about how it will be done.

Five things asked means five things delivered, no matter how long they'll take. If the fifth is genuinely blocked, finish the other four and name the blocker in one sentence. The specific blocker. Not "this needs more investigation."

For integration, release/cutover, generated-output, ownership/governance, CI, moving-main reconciliation, Dev Supervisor, or iOS/browser automation work, `docs/ENGINEERING_PROCESS_GUARDRAILS.md` defines what "done" means operationally. Its `MUST` / `MUST NOT` rules are merge-blocking, and its applicable completion checklist must be satisfied before claiming completion.

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
- Shared runners are quiet by default; use `scripts/run-quiet-command.mjs` for other broad suites.
- On failure, use the bounded failure tail first. Open the retained full log only when the tail is insufficient.
- Rerun only the smallest failing command with `HEX_TEST_OUTPUT=verbose` when full diagnostics are needed.
- Quiet mode changes output only. Never weaken, skip, replace, or shrink canonical tests, verifiers, denominators, exact-head checks, or release gates to save tokens.

## Graft — GitHub Codespaces only

Use Graft **only** when running inside GitHub Codespaces and a `graft/` index is available.

- **Inside GitHub Codespaces (when `graft/` exists):** follow the Graft workflow in `AGENTS.md`. If unavailable, continue with normal repository tools.
- **Outside GitHub Codespaces:** do **not** install, invoke, emulate, or require Graft. Use normal repository inspection/search tools instead.

## Speed and subagent delegation

Optimize for wall-clock speed. Finish tasks quickly. The full subagent rules are in `AGENTS.md` → "Subagent delegation"; this is the same policy.

- **No builtin subagents:** when spawning subagents, delegating background research, running verification, or parallelizing execution, DO NOT use standard built-in subagents (e.g. Sonnet/Opus subagent spawns).
- **Which method (first match wins):**
  1. **User names a method → use it.** "Use Cline" / `./cline-<N>` → Cline. "Use Freebuff" / `./freebuff-<N>` → Freebuff. Never swap in `opencode --auto` instead.
  2. **No method named → `opencode --auto "<task prompt>"`** with Gemini 3.8 Flash High (`gemini-3.8-flash-high` / `proxlane/gemini-3.8-flash-high`).
  3. **Gemini / opencode unavailable** → keep going with Cline or Freebuff; return to the default when it works again.
- **Cline (`./cline-<N>`):** numbers `1`–`8` first (`9` only when 1–8 are exhausted or explicitly allowed). Models in order: `DeepSeek v4.1 Flash` xhigh → `Muse Spark 1.3 Contributor` xhigh → `MiMo 2.6 Flash`.
- **Freebuff (`./freebuff-<N>`):** numbers `1`–`12`. `DeepSeek v4.1 Flash` high while the wallet has room; when about 10 remains (savings included) use `MiMo 2.6 Flash` — never spend the last ~10 on DeepSeek.
- **Parent owns the result:** never call work done on a subagent's claim alone; check `git diff`/`git status`, changed files, tests, CI, and benchmarks.
- **Stopped subagent → hand off, don't restart:** pass TASK / DONE / REMAINING / CHANGED FILES / TEST STATUS / IMPORTANT FINDINGS to the next agent, model, or number.
- **No polling:** wait for reactive wakeups; check a subagent only when it has not come back, has clearly stalled, or you need its result to proceed.
- **Codex / Claude Code parent supervision:** follow `AGENTS.md` → "Parent supervision — Codex and Claude Code only".
- Parallelize aggressively across non-overlapping file/scope boundaries without sacrificing rigor or verification.

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
