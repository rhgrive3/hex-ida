# PR7097 second workflow proof review

## Review identity and boundary

This bounded independent review compares the requested exact source heads:

- old baseline `main`: `65bc985e8c884602b0d492d669593b45f9359bf7`, tree
  `b0870eae389e4f3bfea70a026a6bf1447318bc22`;
- reviewed development candidate: `b194c2c1ce8aaf787d360faf2f22b66e48bd2a13`,
  tree `a70d3eef389866826127323e12c7d7f68fa674cc`;
- review time: `2026-09-08T02:44:52+08:00`.

The review covers the old-to-new GitHub workflow and process-policy wiring for
PR7097: final-closure preflight, invariant gates, generated-output ownership,
Stage 2 runtime proof, physical-device deferral, and the UI/Phase 12 workflow
disposition. The review explicitly excludes the reviewer's authored
`.circleci/config.yml` changes and does not assess CircleCI compilation or
ownership behavior.

This is a source and workflow-wiring review under the development-speed
amendment. No production, workflow, test, package, or generated file was
changed by this review. No broad repository suite was run, and this document
is not a release receipt, candidate-merge-tree proof, target-device proof, or
release approval.

## Evidence inspected

The review used the exact-head diff and source inspection of:

- `.github/workflows/final-closure-preflight.yml`;
- `.github/workflows/invariant-gates.yml`;
- `.github/workflows/generated-sync.yml`,
  `.github/workflows/generated-userscript-main-sync.yml`, and
  `.github/workflows/generated-userscript-autofix.yml`;
- `.github/workflows/stage2-nonphysical-closure.yml` and
  `.github/workflows/stage2-release-validation.yml`;
- `.github/workflows/ui-regression.yml`,
  `.github/workflows/phase12-release-validation.yml`, and
  `.github/workflows/phase11-release-validation.yml`;
- `tools/validation/generated-output-policy.mjs`,
  `tools/validation/stage2/verify.mjs`, `package.json`, and
  `docs/ENGINEERING_PROCESS_GUARDRAILS.md`.

The static checks found 18 top-level commands in `package.scripts.check`. The
review also queried the remote GitHub state read-only with
`gh api repos/rhgrive3/hex-ida/rulesets/22276485` and
`gh api repos/rhgrive3/hex-ida/branches/main/protection`.

## Old-to-new workflow mapping

| Area | `main` at `65bc985e8` | Candidate at `b194c2c1c` | Disposition |
| --- | --- | --- | --- |
| Final closure | No final-closure preflight workflow in the compared tree. | Adds a PR development path that checks the combined candidate with `npm run check:dev -- --base "$BASE_SHA"`, plus a manual `mode: release` path that runs the canonical `npm run check` on the exact dispatched SHA (`.github/workflows/final-closure-preflight.yml:3-5,27-45,47-71`). | The intended development/release split is wired. The manual release path is evidence only; its own comment correctly leaves generated, independent-verifier, runtime, and target proof as separate release requirements. |
| Invariant gates | Existing main-push/exact-SHA shard workflow. | The same workflow remains on `push: main` and exact-SHA dispatch, and its plan checks the package check layout (`.github/workflows/invariant-gates.yml:3-11,28-34,45-64`). | The workflow does not use `check:dev`, but its exact-coverage claim has a material omission described below. |
| UI regression / R2 UI concern | `push: branches: [main]` was already present. | The main push remains present and the candidate adds the AI UI/control and AI UI test paths (`.github/workflows/ui-regression.yml:3-25`). | The reported missing `push:main` condition is not reproduced between these exact heads; it was already satisfied at the old reference and is preserved. The added paths cover the reviewed UI changes. |
| Generated outputs | Existing generated sync, main-sync, and PR autofix workflows. | No old-to-new workflow diff was found for these files; the candidate retains the current generated-output policy and exact main-sync path. | The source wiring is coherent, but a source inspection is not a run of the exact candidate. |
| Phase 12 | Manual exact-SHA workflow only. | Still manual exact-SHA only; its `verify` job contains a pull-request condition but the workflow has no `pull_request` trigger (`.github/workflows/phase12-release-validation.yml:3-8,20-47`). | The manual release path exists. The apparent PR proof branch is unreachable and must not be counted as automatic PR evidence. |
| Stage 2 | Existing main/manual nonphysical and manual final workflow pair. | Same trigger shape: nonphysical proof on main/manual dispatch and release validation on manual dispatch. | Nonphysical exact proof is wired; final release admission remains manual and the `pr-proof` job is unreachable, as described below. |

## Findings

### 1. `invariant-gates` does not currently execute every command it counts

The plan builds `coverageCommands` from all 18 top-level `npm run check`
commands and asserts each appears exactly once in the scheduled coverage list
(`.github/workflows/invariant-gates.yml:75-121`). However, the
`analysis-proof` lane lists `npm run invariants:test` only in
`coverageCommands`; it omits that command from `runCommands` and instead runs
the two separate invariant-baseline scripts (`.github/workflows/invariant-gates.yml:93-99,191-199`).

At the reviewed head, `npm run invariants:test` is
`node tools/validation/invariant-gates.mjs`, which executes the repository's
15 invariant gates. The two baseline scripts are different programs and do not
execute that gate list. Therefore the plan's exact 18-command assertion is a
coverage-accounting assertion, not proof that all 18 commands ran.

This is a **blocking workflow correctness finding** for any claim that
`invariant-gates` is equivalent to the canonical full check. It is not a
`check:dev` substitution: the problem is that one canonical full-check command
is counted but omitted from execution. The release path in
`final-closure-preflight.yml:66-71` does invoke `npm run check`, and the
separate manual/full workflows retain canonical full-check invocations, but
the main push invariant gate must repair this omission before it can be used as
the complete main admission proof.

### 2. There is no `check:dev` substitution for a main full-check path

The exact-head source search found `check:dev` only at
`.github/workflows/final-closure-preflight.yml:45`, inside the explicitly
filtered development PR job. The candidate's manual release branch invokes
`node scripts/run-quiet-command.mjs --label release-check -- npm run check`
(`:66-68`). `invariant-gates` is also configured for `push: main` and exact-SHA
dispatch (`:3-11`).

The development-speed policy correctly treats `check:dev` as changed-test
feedback and separates it from release checks (`docs/ENGINEERING_PROCESS_GUARDRAILS.md:16-57`).
The omission in Finding 1 must therefore be repaired as a full-check scheduling
bug; it should not be papered over by treating `check:dev` as sufficient.

### 3. Stage 2 and Phase 12 PR proof jobs are unreachable from their workflow files

`stage2-release-validation.yml` defines a `pr-proof` job with
`if: github.event_name == 'pull_request'`, but the workflow's only trigger is
`workflow_dispatch` (`.github/workflows/stage2-release-validation.yml:3-5,46-50`).
The job therefore cannot run from this workflow. The manual
`final-exact-product` path does check the exact SHA and, when `final: true`,
passes physical evidence, profile evidence, current-main SHA, and the audited
issue count to the Stage 2 verifier (`:157-187`).

The same trigger/condition mismatch exists in Phase 12: its workflow is
dispatch-only while the job contains a pull-request exclusion condition
(`.github/workflows/phase12-release-validation.yml:3-8,20-29`). This is an
unchanged workflow wiring gap between the compared heads, not evidence that
the manual exact-SHA proof is invalid. It does mean neither job supplies
automatic PR proof and neither should be listed as a required PR check until a
trigger or an explicit replacement path is provided.

### 4. Generated-output wiring is conservative but still requires an exact run

The generated-output policy has two canonical committed paths,
`userscript/hex.user.template.js` and `userscript/release-version.json`, and
separates `enforce` from `ephemeral` ownership
(`tools/validation/generated-output-policy.mjs:8-20,28-31,74-93`). The main
sync workflow rebuilds the outputs on a main push, restores the deployment-only
identity, rejects side effects outside the allowlist, and requires zero diff
for the canonical files (`.github/workflows/generated-userscript-main-sync.yml:21-57`).
The manual sync workflow has the same enforce/ephemeral distinction, and the
PR autofix is restricted to same-repository release or integration branches and
refuses a stale PR head before pushing (`.github/workflows/generated-sync.yml:24-59`,
`.github/workflows/generated-userscript-autofix.yml:27-108`).

This supports the implementation of the generated-output transaction boundary.
It does not constitute generated-output evidence for `b194c2c1c`; the exact
candidate still needs the applicable workflow run and zero-diff artifact.

### 5. Stage 2 runtime proof preserves physical deferral and does not false-green

The main/nonphysical workflow checks the exact candidate SHA/tree, resolves the
generated-output policy, rebuilds canonical output, collects profile evidence,
and runs the Stage 2 verifier with `--full`
(`.github/workflows/stage2-nonphysical-closure.yml:124-225`). Its recorded
nonphysical candidate verdict is explicitly
`BLOCKED_ONLY_ON_PHYSICAL_IPAD_EVIDENCE` with remaining blocker
`S2-IPAD-PHYSICAL` (`:244-255`).

The verifier requires exact identity and a clean worktree, and final mode
preflights physical evidence, profile evidence, current-main candidate-tree
proof, full-check execution, and a zero release-blocking issue count before it
can emit `COMPLETE` (`tools/validation/stage2/verify.mjs:663-715`). This is the
correct fail-closed shape.

The owner-authorized policy explicitly records physical iPad/device execution as
`DEFERRED`, never measured or passing, during development
(`docs/ENGINEERING_PROCESS_GUARDRAILS.md:5-14`). The post-development record
keeps the actual device workload and trace collection unchecked and states that
desktop WebKit is not iPad evidence
(`specs/005-analysis-final-closure/evidence/post-development-device-checks.md:3-15`).
This review preserves that classification and makes no physical or release
claim.

## R2 disposition and admission status

The second-reviewer disposition for the externally reported R2 items is:

| R2 item | Exact-head result | Disposition |
| --- | --- | --- |
| UI workflow must run on `main` | `ui-regression.yml` contains `push: branches: [main]` at both `65bc985e8` and `b194c2c1c`; the candidate adds the AI-specific paths. | **Resolved/preserved.** The reported removal is not present in this exact old-to-new comparison. |
| Final candidate must have a full-check path | The new final-closure workflow has an exact-SHA manual `release` mode that invokes `npm run check`; other manual/full workflows retain canonical full-check paths. | **Manual path present; automatic admission open.** The workflow comment itself says it is not final signoff, and Finding 1 prevents treating the invariant shard as complete until repaired. |
| Generated outputs must be synchronized | Main push sync and manual/PR generated policies enforce canonical paths, side-effect allowlists, and zero diff. | **Implementation wiring present; exact-candidate artifact run still required.** |
| Stage 2/Phase 12 proof must be merge-visible | The exact-SHA manual jobs exist, but the PR proof jobs have no corresponding `pull_request` workflow trigger. | **Open wiring gap.** Do not count the unreachable jobs as automatic PR evidence. |

The remote state was also checked read-only at review time. The active `main`
ruleset (`22276485`) contained deletion, non-fast-forward, and pull-request
rules only; it contained no `required_status_checks` rule or required check
names. The branch-protection endpoint returned `404 Branch not protected`.
Accordingly, this checkout has no evidence that `invariant-gates`, generated
sync, UI regression, Stage 2, or final-closure jobs are currently required by
the remote admission policy. No ruleset or branch-protection setting was
changed by this review.

## Review result

The candidate has a coherent development/release separation, preserves the
UI main trigger, retains conservative generated-output and Stage 2 contracts,
and records physical verification honestly as deferred. It does **not** have a
clean workflow-proof disposition yet: `invariant-gates` counts but does not
execute `npm run invariants:test`, the Stage 2 and Phase 12 PR proof jobs are
unreachable from their declared triggers, and the observed remote main ruleset
does not require workflow status checks. These are workflow/admission findings,
not a release approval.
