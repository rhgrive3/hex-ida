# Hex completion checkpoint — 2026-09-24

Source: `handoff/codex-20260924` at `8ebdc35b6`; initial product base `a5fd5618e`.
The original A–J acceptance contract is in `reports/handoff-codex-20260924/ORIGINAL_REQUEST.md` on the handoff branch.

Status: **IN PROGRESS**. This living integration branch accepts one verified change at a time. Each acceptance records its changed-file inventory, exact candidate merge tree, focused and broad results, and updated product head. Generated output and real runtime proof are required where affected.

Active lanes: source metadata determinism, FAST tail performance, C++ projection, output recompilation, and final Pinpoint/Jev decision. Open issues #9523, #9534, and #9550 are owned by the user and remain external blockers until closed. Existing FAST PRs #9552–#9554 are reviewed separately as main moves.

Current evidence: `rhgrive3/actions` run `35899282597` succeeded for OpenMW and OpenTTD on `a5fd5618e`, and ran the 32-case FAST screen. It is a baseline, not final product proof. Its OpenMW totals are 1,845 vtables / 2,564 typeinfos; OpenTTD totals are 200 / 354.

Exit requires: the A–J acceptance list; 160-case ARM64 benchmark; final real-game reruns; repeated FAST p50/p95/p99; focused and full regression gates; zero unexplained blocking failures; final report with exact source, verifier, corpus, toolchain and runtime identities; current-main reconciliation, expected-head merge, and refetched main proof. No DONE or freeze claim before these results exist.
