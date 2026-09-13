# Portable replay and certificate transfer (experimental)

This entry point reuses `js/core/evidence/arm64-integer-fragment.js`; it is not a second native decoder, range owner, solver or general proof checker. Its transitive browser module imports are confined to `js/core/`. It needs no packages or network and cannot load a checker, callback, script, URL or provider from the capsule.

## Current source and detached replay

On an already enabled native scoped-analysis host, invoke the read-only `portable_integer_checks` tool with `{ "functionId": "0x1000" }`, or call `AnalysisQueryAPI.portableIntegerChecks(snapshot, request, options)`. The service obtains proposals from the existing native range/IR owners and reads the actual source prefix. Save its `capsule` as ordinary JSON. The application/API may wrap the service value; do not treat a wrapper or whole answer as a capsule.

```sh
timeout 10s node tools/portable-checker/check.mjs capsule.json
```

Exit codes: `0` every nonempty listed derivation checked; `2` at least one rejected; `3` unknown or empty; `1` malformed/resource/I/O error; `64` usage. Even exit 0 has `semanticProof: false`, `wholeQueryProof: false` and `sourceBinding: "detached-unverified"`. A supplied file is not authenticated. The CLI rejects non-regular files, refuses symlinks on hosts with `O_NOFOLLOW`, and uses nonblocking open where supported so POSIX FIFOs cannot wait for a writer before type rejection.

A browser host can import `replayPortableChecks` and create a finite `ScopedAnalysisWork`. To rebind a saved capsule, invoke the same current native query with `{ functionId, capsule }`. It recomputes current proposals and rereads source bytes; full capsule equality is required. Current-source binding is still not a whole-function, reachability, memory or exception proof. Rebinding never persists proof authority or changes canonical facts.

Bounds: 262,144 encoded bytes, 16 checks, 4,096 total machine bytes, and at most 64 instructions per prefix. Only the existing versioned A64 integer rule and supported profiles are used. Unlisted values, unknown rules/opcodes and empty results remain unproved. The CLI uses a five-second cooperative work deadline; caller-side process timeout additionally bounds its I/O lifetime. Browser/WebKit/device operation, ISA conformance and independent qualification are not established by the Node tests.

## Loop capsules

The same `check.mjs` command also accepts `scpa-portable-loop-check/v1`. These capsules are emitted by the current `check_loop_invariant` query using a private source-model owner and an explicit invariant or `synthesize: true`. The existing scalar loop checker is reused; there is no new arithmetic engine or machine-to-loop extractor. The loop capsule has a stricter 32 KiB schema bound, including exact world/assumptions/snapshot/function/loop/revision/artifact/source references, model, candidate and checker version.

```sh
timeout 10s node tools/portable-checker/check.mjs loop-capsule.json
```

Exit codes have the same meanings as integer replay. Unknown checker versions remain unknown. Exit 0 is only a listed model derivation, never a current-machine or whole-function proof. To rebind, repeat the original live query (including invariant/synthesis/postcondition options) and add `capsule`. Full current model/candidate/binding equality is required, not just matching IDs. Browser and physical-device behavior remain unqualified.

## Lossless certificate bundles

`bundle.mjs` reuses the existing shared-DAG codec and original certificate replayer. A pack input is a JSON object with `schema: "scpa-certificate-bundle/v1"`, the exact exported `world` and `assumptions`, and a nonempty `certificates` array. Use real issued certificate values, not a whole query-result wrapper. Pack output replaces that array with `certificateTransfer`; unpack restores it without dropping contradictions or frontier nodes.

```sh
timeout 15s node tools/portable-checker/bundle.mjs pack raw-bundle.json
timeout 15s node tools/portable-checker/bundle.mjs unpack packed-bundle.json
timeout 15s node tools/portable-checker/bundle.mjs replay packed-bundle.json
```

Each command writes JSON to standard output only. It never overwrites a file. Shell redirection, if used, must target a different path from the input. `pack` and `unpack` return 0 for transport success; `replay` returns 2 if any certificate is rejected and otherwise 3 because detached semantics/current source remain unqualified. This replay CLI deliberately has no semantic-success exit 0. Malformed/resource/I/O errors return 1; usage errors return 64. Certificate indices and the full declared denominator are retained on replay.

Bounds: 12 MiB wire JSON, at most 32 certificates and the existing codec's expansion limits, ten-second cooperative work, bounded regular-file I/O and 128 MiB work accounting. Both CLIs share `tools/lib/bounded-json.mjs`, which rejects invalid UTF-8, non-regular files and supported-platform symlinks; nonblocking opens avoid FIFO waits where supported. The caller-side process timeout remains important. No network, child process, dynamic import, eval, user-selected checker/provider or authentication assertion is accepted from these inputs. A digest verifies transport integrity, not trust or native-source equivalence.
