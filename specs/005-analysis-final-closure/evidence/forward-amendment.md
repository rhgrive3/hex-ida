# Forward shared-contract amendment — 2026-09-05

Status: PENDING verification. This document is not a green receipt.

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
