# Stage A / combined development PR evidence

PR: https://github.com/rhgrive3/hex-ida/pull/7097 (Draft).
Read-only API observation: 2026-09-08. Observed remote head:
`a07ff5bb5d4adaa349c6db3c8d699b94706955e6`.

| Check | Observed result | Disposition |
| --- | --- | --- |
| CircleCI phase7-ownership | SUCCESS | Aggregate branch validates the complete phase manifest subset; component whole-diff rejection remains. |
| CircleCI phase8-ownership | SUCCESS | Aggregate routing and forbidden-path negatives pass; no ownership manifest weakening. |
| CodeRabbit | SUCCESS | Draft was skipped. This is not a code-review approval. |
| CircleCI agent-loop-resilience | SUCCESS | Passing at the observed remote head only. |
| CircleCI ai-eval-contract | SUCCESS | Passing at the observed remote head only. |
| CircleCI issue-2528-canonical-claims | SUCCESS | Passing at the observed remote head only. |
| CircleCI migration-guardrails | SUCCESS | Passing at the observed remote head only. |

## Review/comment classification

There are no inline review comments at this observation. Review5134400936 is
GitHub state COMMENTED, with an automated CHANGES_REQUESTED verdict in its body.
Its findings remain actionable until the corresponding fix and verification exist.

| Source / finding | Classification | Current disposition |
| --- | --- | --- |
| Review5134400936: removed main UI trigger | Actionable, fixed | 9765d3b75 restores push-main while preserving AI paths; focused workflow test passes. Published source includes the fix; exact final release proof remains separate. |
| Review5134400936: manual check:dev/release path cannot replace main proof | Actionable, partly resolved | Existing main invariant/Stage2 proof retained; explicit separation test added. Server-required status checks are absent in ruleset22276485 and remain unresolved. |
| Review5134400936: fresh-main candidate and proof mapping | Actionable, pending final boundary | Main65bc985e8 merged as51f28ab05. Later main movement is not yet candidate-tree evidence. Mapping: ../../../evidence/pr7097-workflow-review.md. |
| Comment5574022164: CodeRabbit draft skipped | Informational | No CodeRabbit review or approval exists; do not infer one from SUCCESS. |
| Comment5574041205: aggregate scope is intentional, retain final proof and independent reviews | Applicable review request | Draft retained; no protected-main promotion. Current local corrections and bounded independent mapping review do not certify final admission. |
| Device execution requested as part of final proof | Deferred by explicit owner instruction | Actual device confirmation happens after development. Contracts remain; no device PASS is claimed. |

T022 is still pending: this record classifies the current comments and CI, but
there are unresolved actionable items and no approved exact-final-head release.
No remote ruleset, required-check policy, or PR draft state was changed.

The earlier43381ba38 pipeline failed configuration compilation because its
literal heredoc tags were not escaped for CircleCI. Commit a4a651d93 repairs
the syntax and adds a persistent routing regression. All six jobs passed on
the observed head above. Both workflow mapping reviews are recorded in
`../../../evidence/pr7097-workflow-review.md` and
`../../../evidence/pr7097-second-workflow-review.md`. The second review
confirms that the invariant baseline wrapper already executes invariants:test;
no additional broad PR gate is required for that retired finding.
