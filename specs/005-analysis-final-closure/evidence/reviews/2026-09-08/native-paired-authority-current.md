# Native paired authority review — bounded evidence

Date: 2026-09-08. This is an independent boundary review of the native paired
reference path. The 11-case probe ran against the clean detached snapshot
`0d4088c48feb77b1c830e08046b095d7e0afc5d8`, where the native authority change
from `8747bddc38f2fa128eafacab9174fd2ff32a577` was present. It is retained as
review evidence for the implementation boundary; it is not relabeled as a
current-head product measurement. Current exact-head quality is recorded in
[native-paired-quality-current.md](native-paired-quality-current.md).

The clean snapshot is `/mnt/workspace/.dev-state/hex-development-batch/native-paired-authority-review/source-0d4088`. The probe reused the retained real LLVM 18.1.3 capture
`/mnt/workspace/.dev-state/competitive-measurement-captures/p8-1813-capture.json`.
Its capture identity is digest `466a54ad875adfc8d2933eda748e7c53`, nine
artifacts, compiler identity `d7630d99c43cd42e71f9aed7a8a11c63`, and 45 native
ARM64 corpus rows. Node was `/mnt/workspace/.local/hex-final-node22/bin/node`
(`v22.20.0`).

All 11 cases passed. They covered an identity-bound positive envelope, one real
ARM64 adapter row, stale baseline and corpus digests, native/legacy mode
mixing, changed capture and adapter identity, missing native method coverage,
the lower-level collector default, and invalid CLI mode input. Stale or mixed
authority was returned as `UNMEASURED`; no concrete acceptance, identity, or
measurement-truth defect was found.

The lower-level `collectCompetitiveMeasurements` API retains its frozen-legacy
default. The repository collector and CLI select native paired mode, and the
probe confirmed that callers of the lower-level API must pass native mode
explicitly. This is a documented layering limitation, not a release result.

Reproducible raw evidence is retained outside the repository:

- Report: `/mnt/workspace/.dev-state/hex-development-batch/native-paired-authority-review.md`
- Probe source: `/mnt/workspace/.dev-state/hex-development-batch/native-paired-authority-review.mjs`
- Exact-head command: `/mnt/workspace/.dev-state/hex-development-batch/native-paired-authority-review/command.txt`
- Exact-head output: `/mnt/workspace/.dev-state/hex-development-batch/native-paired-authority-review/probe-0d4088.json`

The exact-head output SHA-256 is
`12f8dcbc5024cc673b6661194710a926b964e10865ea5e7cdeafd422eff515cb`.
The report and source SHA-256 values are respectively
`5ef9ecf58f2c5315d63199a73e45f950406c71873470f04f8bc6209c0e7d1273` and
`29940eaab4d7c3027ac62b07af38132f2b966e85fd68ce084086b34e6ce44202f`.
