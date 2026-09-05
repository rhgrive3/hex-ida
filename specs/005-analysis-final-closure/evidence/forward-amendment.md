# Forward shared-contract amendment — 2026-09-05

Status: code amendment VERIFIED; successor activation remains PENDING until
the separate evidence handoff and unique T058 DONE transition are verified.

The user limited this delivery to Recovery merge and post-merge verification,
before analysis-roadmap implementation, and explicitly waived physical-device
tests. Their status is `SKIPPED_USER_WAIVER`, never PASS. Browser/WebKit and
all non-device release gates remain required.

T046 remains DONE at its unique transition
`9aaa805f7c1026dd08471c6a5a71e7b92dcef9e4`, with immutable handoff
`148bb8a48d34507059b90a4202e3aa734f1fbc48`. No history rollback or replacement
integration PR is authorized. The living branch remains
`recovery/final-closure-v3-20260904`, PR #6611.

The first T051 checkpoint proposal was not accepted: runtime replay correctly
detected differing ephemeral bytes, but the acceptance contract incorrectly
required canonical randomized AES-GCM envelopes to be byte-identical across
two generator invocations. The producer deliberately uses fresh content keys,
IVs and signing keys. Making encryption deterministic would be an unsafe fix.

Under Guardrails EP-010/EP-011 and the explicit reviewed shared-contract-change
exception in §3.2, T058 instead authenticates each envelope, compares decoded
content plus unchanged noncryptographic output, preserves dependency hashes,
and seals the full second-build snapshot throughout later gate execution.
All affected prior receipts are invalidated. The diagnostic proposal is not
grandfathered, and no component may be admitted until the successor is DONE.

The amendment also repairs the stale Phase4 workflow-test assertion using the
existing canonical phase45 coverage/aggregation contract, and gives the
separate three-line scheduler production repair its own T059 owner and fixed
independent gate. It does not weaken parser, scheduler, semantic or browser
requirements or expand T056's fixture-only ownership.

The active Stage A component set is T011–T017, T051–T057, and T059; this
explicitly extends historical component enumerations, including T049's
defect-return rule, without rewriting its frozen original ownership row.
T058 is a governance successor, not a component. Dynamic Stage B tasks begin
at T060. One existing ownership omission is repaired: T014 may own exactly
`tools/validation/phase9/tiered-solver-metrics.mjs`, already required by the
immutable P-SYM01 source lock. Its full amended row is separately pinned; the
original T001–T057 snapshot and digest exclude only that approved addition.
No profile, report, threshold, or semantic authority is changed by this
ownership correction.

The exact T058 reassignment set and original owners are pinned in the verifier.
They are checked against both the immutable T046 transition inventory and the
T058 handoff inventory. Reassigning another path, omitting an amended path,
or moving the immutable T046 evidence into T058 fails closed.

Required evidence before activation: focused adversarial regressions; canonical
preflight suite; independent Luna Max actual-diff review; exact-head CI; code
and evidence commit identities. After activation, the first actual component
must pass canonical generation twice and complete runtime checkpoint replay.

## Exact code and independent evidence

- Code commit: `f850024c6ef6c3a99563770c76e593a98b5ac964`.
- Code tree: `4240836899a94c0491bc0d00846772e2cd165c38`.
- Base main: `7012c4cc4f0d5c0d8a7ca44c6c5c1edcb080aba1`.
- Local exact-head preflight: `PREFLIGHT_GREEN`, 59 tasks, 11 handoffs,
  37 changed paths; verifier SHA-256
  `4f7a062392387afe79ce6da706d61da458895f4242a8a6eb431fecc3db0ae8a2`.
- Focused amendment adversarial regression and Phase4 ownership regression
  passed (the latter 19/19); syntax and diff checks passed.
- Hosted canonical final-closure regression, production walking skeleton,
  exact-head and checkpoint verification all passed on the exact code commit:
  [Final closure preflight 33935598167](https://github.com/rhgrive3/hex-ida/actions/runs/33935598167).
  Completed 2026-09-05 01:18:19 UTC. A supplementary local canonical run was
  still running when this evidence was published; no local PASS is claimed.
- Independent Luna Max reviewed the actual code diff and explicitly verified
  the exact commit/tree above: no blocking finding.
- [CodeRabbit exact-code review](https://github.com/rhgrive3/hex-ida/pull/6611#issuecomment-5548394887)
  found no additional static defect in the amendment. This is an explicit
  review comment, not the automatic draft-skip status and not main approval.
- Initial gate digest: `63fb512b688c281f862740411f20df72`.
- Original foundation digest retained: `17c869290b57aef76a1ee1d68ea32338`.
- Approved successor ownership digest: `bfc9e2c97114e6f81f2107f07089b5eb`.

This verifies the amendment, not Recovery completion. Required product checks
still expose the registered T051 AI snapshot exports, T052 collaboration,
T057 CIL fixture, and other unaccepted component deltas. Those remain required;
none is waived as historical. Sequence remains zero with no admitted component.
Physical-device evidence remains `SKIPPED_USER_WAIVER`; Stage B remains unstarted.
