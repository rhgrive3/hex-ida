# T045 implementation evidence — 2026-09-08

Implementation commits: `ce991646e`, `a52830237`.

The canonical collector/schema/verifier reads the frozen final-platform lock.
It requires all fourteen H9 rows, both runtime classes, exact fixture identities
and repetitions, finite raw numeric samples, recomputed summaries and digests,
unchanged numeric targets, and physical peak-footprint Instruments trace identity.
The physical evidence attachment retains the complete source numeric packet.

The existing Stage2 verifier is a production consumer. In final mode it requires
both the identity-resolved physical scenario and the locked numeric packet;
binary/build/runtime/device/fixture/scenario/source evidence identities must agree.
A numeric-only packet cannot replace the scenario, and a legacy boolean-only
packet cannot replace measured numeric evidence. Root review caught this bypass
in the first wiring revision; `a52830237` repairs it and adds regressions.

Root verification: `node scripts/run-quiet-command.mjs --label h9-stage2-reviewed
-- node tests/final-platform/run.mjs` PASS (0.9 seconds). The tests cover positive,
negative, boundary, replay, per-row mutation and existing physical evidence
contracts. Test packets are synthetic contract fixtures, not physical evidence.

T045 is implementation complete. The owner deferred actual device execution until
all development is finished; no real-device result is claimed. T040 retains
applicable browser/platform execution and the separate device deferral record.
