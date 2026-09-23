# Hex completion campaign — handoff to Codex (2026-09-24)

Original task: the user's "finish and freeze Hex" request (items A–J, acceptance list).
The full request text is in `ORIGINAL_REQUEST.md` next to this file.
Read `CLAUDE.md` and `docs/ENGINEERING_PROCESS_GUARDRAILS.md` in the repo first.

## Durable locations (these survive a restart; `/tmp` does not)

| What | Where |
|---|---|
| This handoff | `/mnt/workspace/hex-handoff-20260924/` (also on the GitHub branch `handoff/codex-20260924`) |
| Helper scripts | `scripts/` (see "Tools" below) |
| Subagent prompts / logs | `prompts/`, `logs/` |
| Measurements (real-game, tail profiles, A/B) | `measurements/` |
| OpenMW / OpenTTD ARM64 .deb (+ SHA256SUMS) | `binaries/` — extract with `dpkg-deb -x <deb> root` |
| Real-game CI workflows + harness | GitHub repo `rhgrive3/actions` (`scripts/hex-realgame-holdout.mjs`, `.github/workflows/hex-realgame-dispatch.yml`, `.github/workflows/hex-realgame-tail-parallel.yml`) |

Old prompts and logs mention `/tmp/claude-0/.../scratchpad/...`. Map it like this:
`scratchpad/<x>.mjs` → `scripts/<x>.mjs`, `scratchpad/openmw/root/usr/games/openmw` → extract `binaries/openmw_*.deb`,
`scratchpad/openttd/root/usr/games/openttd` → extract `binaries/openttd_*.deb`, `scratchpad/actions` → clone `rhgrive3/actions`.

## Status by item

Snapshot: main `a5fd5618e` (2026-09-24 02:10 CST). Open PRs: 0. Open issues: #9550, #9534, #9523. The user is fixing these.

| Item | State | Evidence / PRs |
|---|---|---|
| A OpenMW | **Done.** The job succeeds and writes result.json (run 35890975968). | #9528, #9547 (deterministic symbols), #9551 (prefetch: 21 → 4 parser passes, 76 s → 39 s locally). Not yet re-run on CI after #9547/#9551. |
| B FAST tail | **Partial.** | #9533 (test_composite_types 71 s → 37 s A/B, identical output), plus remote #9526 #9529 #9531 #9539 #9543 #9544. The new tail measurement has not been read yet: rhgrive3/actions runs 35899005700 and 35896399816 ("FAST known-tail focused benchmark", success; started by the remote) and 35899282597 (queued). |
| C #9520 | **Done.** | #9524, #9549 (flaky inode-reuse test fixed). #9521 is done too: #9532. |
| Timeout semantics | **Done.** | #9530, docs/FUNCTION_TIMEOUT_SEMANTICS.md |
| Red root issue gate | **Done.** | #9536–#9538, #9540, #9541, #9548 (auth suite 63/63), #9549. On main 19fc24a01, the only failure was 9520, which #9549 fixed. Run `npm run root-issue-regressions:test` again to confirm. |
| D C++ projection | **Not done.** The subagent was stopped with no output. | Prompt: `prompts/cxx-4.txt`. Facts: see Key findings 3, 4 and 8. Remote #9527 already projects member types. |
| E Pinpoint/Jev | **Not done.** The subagent was stopped with no output. | Prompt: `prompts/jev-3.txt`. OPENJEV_API_KEY is in the environment. |
| F Output / weakness re-measure | **Measured only** (no fix yet). | Branch `wip/output-recompilation-measure-20260924` (8 cases gcc_O1_g on e54c993e2): 131/530 functions with goto (747 gotos), 21 with unknown instructions, 147 unstructured, raw recompilation fails 8/8 with first family undeclared-local, TU unresolved: 74 prototypes, 25 globals, 4 pseudo-intrinsics. Fix prompt: `prompts/decl.txt`. |
| G–J | Not started. | — |

## Key findings (evidence-backed, do not re-investigate)

1. **OpenMW P0 (fixed, #9528).** The ELF open fell back to "Raw binary", which gave `ARM64_SLICE_UNAVAILABLE`. `findAarch64StructuralPltResolver` scanned all of .text and exceeded the 16 MiB source metadata budget. Above 1 MiB of executable bytes, PLT0 is now anchored by the lazy GOT initial values. The OpenMW CI job now succeeds.
2. **Nondeterministic RTTI (PR #9547).** The dynamic symbol and relocation budgets had wall-clock defaults (2000 ms / 1500 ms). On a slow host, OpenMW symbols were cut from 38388 to about 12000, and the class, vtable and typeinfo counts changed between runs. Also, the DT_NEEDED scan budget charged 1 MiB per name. PR #9547 fixes both.
3. **Real-game harness bug (fixed in rhgrive3/actions).** `product.query.decompile()` returns `value` as an object `{semantic, signature, pseudocode, lines}`, not as a string. The old "0 indirect calls / 0 members / 0 classes" numbers were a measurement artifact.
4. **vtable over-read.** `js/rtti.js readVtable` reads a fixed slot count and has no end-of-vtable detection. Sampled "virtual targets" included data (the values 2 and 0x200000000, and typeinfo addresses), and these decompiled as `unsupported`. The C++ lane is fixing this.
5. **FAST tail #1 hotspot (fixed, #9533).** `canonicalAnalysisIdentity` re-encoded shared objects (841k encodes for 101k objects). test_composite_types went from 71 s to 37 s, with identical output. The remote agent also merged #9526, #9529, #9531, #9539, #9543 and #9544 (FAST indexes and digest reuse).
6. **Timeout semantics (#9530).** It is now a hard process watchdog, and "timeout is never PASS" is enforced. The rule is documented in `docs/FUNCTION_TIMEOUT_SEMANTICS.md`.
7. **The root issue gate was red on main (22 files).** It was fixed by #9536, #9537, #9538, #9540 and #9541. `tests/issue-6133` needs Playwright WebKit system libraries on the host.
8. **OpenTTD sampled functions render with `value.semantic === false`** (legacy path, raw `__asm("cbz ...")` branches). The cause is not yet known. The C++ lane was told to check it first.

## Tools

- `scripts/dec.mjs <root> <binary> <addr|first:N|all> [out.json]` decompiles one or more functions with FAST. It prints ms and the sha of the output, so you can check that a change keeps the output identical.
- `scripts/incl.cjs <cpuprofile> [N]` shows inclusive time per function. `scripts/callers.cjs <cpuprofile> <fnPrefix> [depth]` shows the caller chains.
- `scripts/rtti-count.mjs <root> <binary>` runs openProduct and prints the findCxxClasses counts and the setup profile.
- `scripts/oc2.sh <name> <worktree> <promptfile> [rounds]` runs an opencode subagent and keeps continuing the same session until it prints ALL-DONE. Gemini often stops after writing a todo list.
- Real-game CI: `gh workflow run hex-realgame-dispatch.yml -R rhgrive3/actions -f target_sha=<sha> -f games=openmw,openttd`. It writes `result.json` and `stages.json`.
- Tail CI: edit `TARGET_SHA` in `rhgrive3/actions/.github/workflows/hex-realgame-tail-parallel.yml` and push. This runs the 32-case screen, then the top-12 profiles, then `tail-final`.

## Remaining work (in order)

1. **Determinism (high).** `audit/wall-clock-budgets.md` found more result-changing wall-clock defaults: `js/binary/elf-budget.js` (wallClockMs 5000), `macho-budget.js` (5000), `pe-loader-core.js` (5000) and `js/worker-budget.js` (3000 ms, truncates ObjC stub names **silently**). Apply the #9547 pattern: default Infinity, explicit opt-in, a regression that uses an injected clock. Then re-run real-game OpenMW/OpenTTD twice and confirm identical RTTI counts. The OpenMW oracle is 1847 vtables / 2564 typeinfos.
2. Read the FAST tail CI results (see B). Profile the new top hotspots with `scripts/incl.cjs` and fix them with equivalence checks.
3. D C++: vtable end detection in `js/rtti.js readVtable`; the root cause of `semantic:false` on OpenTTD methods; `this` typed from vtable membership; rendering of vptr stores and virtual calls; a debug-reference holdout (Ubuntu arm64 `-dbgsym` from ddebs.ubuntu.com, or a clang `--target=aarch64-linux-gnu` + ld.lld build).
4. F: fix the declarations (locals, fixed-width types, globals/prototypes, pseudo-intrinsic prototypes), then re-measure. Also check gotos/unstructured in the soft-float helpers with general CFG fixes only.
5. E Jev: shortlist ≤255 → retention → freeze → new binary-disjoint holdout → prospective evaluation → decide canonical or advisory. Do this only once.
6. Open issues #9523, #9534, #9550: the user is fixing these. Codex should not touch them.
7. G 160-case benchmark, H final real-game acceptance, I p50/p95/p99 over multiple runs, J freeze.

## Coordination

A separate remote agent also opens and merges PRs in `rhgrive3/hex-ida`, mostly FAST perf and C++ projection. Run `gh pr list` and `git log origin/main` before you start anything, so you do not duplicate its work.
