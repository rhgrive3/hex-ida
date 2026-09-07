# PR7097 second workflow proof review

## Identity and scope

This bounded independent review compares old `main` `65bc985e8c884602b0d492d669593b45f9359bf7` (tree `b0870eae389e4f3bfea70a026a6bf1447318bc22`) with candidate `b194c2c1ce8aaf787d360faf2f22b66e48bd2a13` (tree `a70d3eef389866826127323e12c7d7f68fa674cc`), at `2026-09-08T02:44:52+08:00`.

It reviews final-closure preflight, invariant gates, generated outputs, Stage 2 runtime, physical deferral, and the UI/Phase 12 R2 disposition. The review excludes the reviewer's `.circleci/config.yml` work and does not assess CircleCI. No source, workflow, test, package, or generated file was changed; no broad suite was run. This is not release approval or a release receipt.

## Exact-head findings

- **Final closure:** `final-closure-preflight.yml` is new. Its filtered PR development job runs `npm run check:dev -- --base "$BASE_SHA"`; its manual `mode: release` job checks the exact dispatched SHA with canonical `npm run check` (`:3-5,27-71`). This correctly separates development feedback from release evidence.
- **Invariant gates:** the apparent coverage omission is false. The plan's `coverageCommands` includes `npm run invariants:test`, while `runCommands` omits it because the adjacent `node tools/validation/invariant-pr-baseline.mjs` step is the wrapper. That wrapper's `runRawInvariants()` directly runs `npm run invariants:test` (`tools/validation/invariant-pr-baseline.mjs:102-108`), then performs the baseline classification; the fixture classifier is separately exercised at `invariant-gates.yml:191-199`. The 18-command coverage plan is therefore wired as intended. The semantic required-regression gate separately schedules heavy `invariants:test` work (`tests/semantic-v2/integration-required-regression-gates.test.mjs:127-151`); that host-delegated lane is a separate concern.
- **No `check:dev` substitution:** exact source search found `check:dev` only in the filtered development PR job. Main/full paths retain canonical `npm run check`; `check:dev` remains development feedback under the speed amendment (`docs/ENGINEERING_PROCESS_GUARDRAILS.md:16-58`).
- **UI/R2:** `ui-regression.yml` already had `push: branches: [main]` at both exact refs; the candidate adds AI UI/control and AI UI test paths. The reported missing main trigger is not reproduced in this old-to-new range and is preserved correctly.
- **Generated outputs:** the existing policy keeps canonical `userscript/hex.user.template.js` and `userscript/release-version.json`, distinguishes enforce/ephemeral ownership, restores deployment-only identity, rejects side effects, and requires zero diff (`tools/validation/generated-output-policy.mjs:8-20,28-31,74-93`; generated main-sync/manual/autofix workflows). This is sound wiring, not an exact-candidate run receipt.
- **Stage 2:** nonphysical main/manual workflow checks exact SHA/tree, generated output, profile evidence, and `verify.mjs --full`, recording `BLOCKED_ONLY_ON_PHYSICAL_IPAD_EVIDENCE` with `S2-IPAD-PHYSICAL` remaining (`stage2-nonphysical-closure.yml:124-255`). Final mode fail-closes on physical/profile/current-main/full-check/issue-count requirements (`tools/validation/stage2/verify.mjs:663-715`).
- **Physical device:** the owner-authorized guardrail and post-development record explicitly mark iPad/device execution `DEFERRED`, never passing (`docs/ENGINEERING_PROCESS_GUARDRAILS.md:5-14`; `post-development-device-checks.md:3-15`). No physical or release claim is made.

## R2 and workflow-trigger disposition

The Phase 12 and Stage 2 release files contain pull-request-conditioned jobs but are dispatch-only at the top level (`phase12-release-validation.yml:3-29`; `stage2-release-validation.yml:3-50`). Under the owner’s speed amendment, broad PR-heavy release triggers are retired development remnants; these unreachable branches are not proof and are not a request to restore heavy PR checks. Manual exact-SHA paths remain the applicable release mechanism.

The remote state was queried read-only at review time. Active `main` ruleset `22276485` has deletion, non-fast-forward, and pull-request rules but no `required_status_checks`; the branch-protection endpoint returns `404 Branch not protected`. Thus no remote required-check binding is evidenced for invariant, generated-output, UI, Stage 2, or final-closure jobs. No ruleset was changed.

## Result

The compared candidate preserves the UI main trigger, correctly separates `check:dev` from canonical full checks, retains generated-output and Stage 2 fail-closed contracts, and records physical deferral honestly. The review found no invariant coverage defect. Remaining status is **implementation/workflow wiring reviewed, release admission unproven**: exact candidate workflow runs, applicable generated and independent evidence, and remote required-check configuration still require separate release evidence.
