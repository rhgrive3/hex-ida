# Current native paired Phase 8 quality evidence

Date: 2026-09-08. This bounded quality collection ran from a clean detached
snapshot of exact current head `ea5d05b244a0a611d7acddc94064e6857642d21d`,
tree `48423ce83c8c4914288ec57b672e0fdc2b525ffd`. It reused the retained real
LLVM 18.1.3 capture and did not regenerate debug artifacts, run the 405-sample
performance path, or run P5/P6.

The run used Node `/mnt/workspace/.local/hex-final-node22/bin/node` (`v22.20.0`)
and the capture
`/mnt/workspace/.dev-state/competitive-measurement-captures/p8-1813-capture.json`.
The capture digest is `466a54ad875adfc8d2933eda748e7c53`; the artifact
denominator is nine and the repository-owned Phase 8 corpus has 135 function
IDs. The native adapter produced 135/135 observations with zero failures,
including 45 rows marked `validated-native-arm64-capture`. The observation ID
digest is `8af0a58440b84e595450beea6f9d5fda`.

| Metric | Status | Candidate | Native paired reference | Comparison |
| --- | --- | ---: | ---: | --- |
| `decompiler-quality-gotos` | `MEASURED` | 148 | 148 | `TIE` |
| `decompiler-quality-assembly-fallbacks` | `MEASURED` | 1038 | 1090 | `WIN` |

Both envelopes passed `validateCompetitiveMeasurement` with reference mode
`native-arm64-paired-historical` and the preserved capture identity. These are
current identity-bound observations. They do not establish a release
threshold, host-concurrent timing result, complete P-COMPETITIVE denominator,
or full-gate PASS.

The canonical repository collector also constructs P5/P6 before Phase 8; this
bounded run intentionally called the Phase 8 collection functions directly.
Its narrowed P5/P6 records are therefore out of scope and must not be read as
P5/P6 failure or completion evidence. The separate reconstructed P5/P6 packet
is [p5-p6-current-proof.md](p5-p6-current-proof.md).

Raw evidence and source identity:

- Command: `/mnt/workspace/.dev-state/hex-development-batch/native-paired-quality-current/command.txt`
- Run log: `/mnt/workspace/.dev-state/hex-development-batch/native-paired-quality-current/run.log`
- Full envelope and observations: `/mnt/workspace/.dev-state/hex-development-batch/native-paired-quality-current/native-phase8-quality-envelope.json`
- Probe source: `/mnt/workspace/.dev-state/hex-development-batch/native-paired-quality-current.mjs`
- Clean source snapshot: `/mnt/workspace/.dev-state/hex-development-batch/native-paired-quality-current/source-ea5d05`

The envelope SHA-256 is
`e22669e3824ed9212b1c46e5fb4df38247b009bc57660fa0baa9702a996f9777`.
The command, run log, and probe source SHA-256 values are respectively
`09a05c6066209774dab373118d65e64a0c1d3e0d55e9962dfeb26781d0ef4317`,
`9c9cb3e8618a6e6531160b985e348b7aee8512d49c1259301c4c45db3c2276e9`, and
`2ecc739794516b80962e1165e66f1a66db2a23d5ad8e7ddccdac222d3d21102f`.
