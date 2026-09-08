# P5/P6 reconstructed current-batch evidence

The retained P5/P6 run was executed with Node 22.20.0 and LLVM 18.1.3 from
clean source commit `8747bddc38f2fa128eafacab9174fd2ff32a577`, tree
`ee659720f71d36b6c32c7142b91cdf0a9ef845e4`, at
`/mnt/workspace/.dev-state/hex-development-batch/p56-current-8747bddc`.
Source was stable and clean at both ends of the run. This is fresh evidence for
that exact pre-parser head, not an exact-`ea5d05b24` rerun.

The capture builders returned `READY` and both oracle test processes exited 0.
The original TAP marker parser reported `LEDGER-UNAVAILABLE` for both lanes
because the large JSON markers were wrapped/escaped (`Unterminated string in
JSON` at the retained parser positions). The retained oracle output was
reconstructed and measured with the integrated parser correction
`2740c1f53b4fa00c42b728b5a6f5f42a16c4e21e`.

| Lane | Metric | Tuples | Candidate passes | Reference passes | Status | Comparison |
| --- | --- | ---: | ---: | ---: | --- | --- |
| P5 | `machine-effects-x86_64-coverage` | 144 | 144 | 144 | `MEASURED` | `TIE` |
| P6 | `machine-effects-riscv64-coverage` | 264 | 264 | 264 | `MEASURED` | `TIE` |

P5 capture digest is `21026a42dccfe825189afbb252680bca` with artifact digest
`dcfd13eac29f66c2dbf4002a9392676d`; P6 capture digest is
`33061ba322ab54c87ac41cde5ac5f7bd` with artifact digest
`354d2be58e6ff73fa2a36a5b8a055038`. Both reconstructed measurements bind to
the exact `8747bddc` producer identity and LLVM 18.1.3 independent oracle.

Raw producer and reconstruction evidence is retained outside the repository:

- Run metadata and raw logs: `/mnt/workspace/.dev-state/hex-development-batch/p56-current-8747bddc/run-metadata.json` and `/mnt/workspace/.dev-state/hex-development-batch/p56-current-8747bddc/run.log`
- Reconstructed P5 ledger/measurement: `p5-tap-reconstructed-ledger.json` and `p5-tap-reconstructed-measurement.json` in that directory
- Reconstructed P6 ledger/measurement: `p6-tap-reconstructed-ledger.json` and `p6-tap-reconstructed-measurement.json` in that directory
- Driver: `/mnt/workspace/.dev-state/hex-development-batch/p56-current-8747bddc/run-p56-current.mjs` (SHA-256 `4f71b1d9ace3e3ca7cd0996eff18f97711b598e862ecf26593f2606963d61ce8`); per-lane commands are in `run-metadata.json`

The reconstructed ledger SHA-256 values are P5
`c39b4aa9b0648f957f63c3bbd0af65a091b761f4e087db8f3e88f612b8cb6eb2` and P6
`af60491b11a5d7a623f7563107faaf08342ac9993b2936655481d4b65129afa1`.
The reconstructed measurement SHA-256 values are P5
`c63560437ddea57f43c84df30d9774f8d56abc916a68c5b711efe979a02c0d34` and P6
`87e7f9d3e137aa313dd63dc5e5dcf157d7e13c0abc5869947cf4e659490d2f60`.

This closes the previously missing P5/P6 reconstructed measurement packet,
but does not close T026. The producer identity predates the exact current
generated head, three external game binaries still lack source/compiler/debug
identity, and the complete P-COMPETITIVE performance denominator and release
threshold acceptance remain outstanding. No checkbox or release status is
changed by this packet.
