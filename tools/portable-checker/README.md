# Portable replay and certificate transfer (experimental)

This entry point reuses `js/core/evidence/portable-replay.js`, `js/core/evidence/certificate-bundle.js`, and `js/core/evidence/arm64-integer-fragment.js`; it is not a second native decoder, range owner, solver, or general proof checker. Its transitive browser module imports stay confined to `js/core/`. It requires no external packages or network access and never loads a checker, callback, script, URL, or provider from a capsule or bundle.

## Current source and detached replay (`check.mjs`)

On an enabled native scoped-analysis host, invoke the read-only `portable_integer_checks` tool with `{ "functionId": "0x1000" }`, or call `AnalysisQueryAPI.portableIntegerChecks(snapshot, request, options)`. Save its `capsule` as ordinary JSON (do not pass a whole query-result wrapper).

```sh
timeout 10s node tools/portable-checker/check.mjs capsule.json
```

Exit codes:

- `0`: every nonempty listed derivation checked (`semanticProof: false`, `wholeQueryProof: false`, `sourceBinding: "detached-unverified"`).
- `2`: at least one listed derivation rejected.
- `3`: unknown or empty result.
- `1`: malformed, resource-limit, or I/O error.
- `64`: CLI usage error (`--help` exits `0`).

A browser host can import `replayPortableChecks` with a finite `ScopedAnalysisWork`. To rebind a saved capsule, invoke the same live native query with `{ functionId, capsule }`; full capsule equality against current proposals and source bytes is required. Current-source binding is still not a whole-function, reachability, memory, or exception proof, and rebinding never persists proof authority or mutates canonical facts.

Bounds: 262,144 encoded bytes, 16 checks, 4,096 total machine bytes, and at most 64 instructions per prefix. The CLI enforces a 5-second cooperative work deadline (`100,000` work units, `4 MiB` resident bytes); caller-side process timeouts additionally bound I/O lifetime.

## Loop capsules

`check.mjs` also accepts `scpa-portable-loop-check/v1` capsules emitted by `check_loop_invariant` (with an explicit invariant or `synthesize: true`). The existing scalar loop checker is reused under a stricter 32 KiB schema bound covering world, assumptions, snapshot, function, loop, revision, artifact, source references, model, candidate, and checker version.

```sh
timeout 10s node tools/portable-checker/check.mjs loop-capsule.json
```

Exit codes match integer replay. Unknown checker versions remain unknown, and exit `0` verifies only the listed model derivation. To rebind, repeat the live query with the original options plus `capsule` (full model/candidate/binding equality is required).

## Lossless certificate bundles (`bundle.mjs`)

`bundle.mjs` reuses the shared-DAG codec and certificate replayer. A pack input is a JSON object with `schema: "scpa-certificate-bundle/v1"`, exact exported `world` and `assumptions`, and a nonempty `certificates` array of issued certificate values. `pack` replaces `certificates` with `certificateTransfer`; `unpack` restores it without dropping contradictions or frontier nodes.

```sh
timeout 15s node tools/portable-checker/bundle.mjs pack raw-bundle.json
timeout 15s node tools/portable-checker/bundle.mjs unpack packed-bundle.json
timeout 15s node tools/portable-checker/bundle.mjs replay packed-bundle.json
```

Each command writes JSON to stdout only and never overwrites a file (redirect to a different path from the input). Exit codes: `0` for `pack`/`unpack` transport success; for `replay`, `2` if any certificate is rejected and `3` otherwise (no semantic-success exit `0` because detached semantics and current source remain unqualified); `1` on malformed/resource/I/O errors; `64` on usage errors (`--help` exits `0`).

Bounds: 12 MiB wire JSON, at most 32 certificates, 10-second cooperative work deadline (`1,000,000` work units, `100,000` nodes/edges, `128 MiB` resident bytes, `1,024` calls). Both CLIs share `tools/lib/bounded-json.mjs`, which rejects invalid UTF-8, non-regular files, and symlinks (`O_NOFOLLOW`), using nonblocking opens where supported so POSIX FIFOs never block. Transport digests verify integrity only, not trust or native-source equivalence.
