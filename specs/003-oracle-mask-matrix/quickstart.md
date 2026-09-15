# Validate the ME-01 transport matrix

Use the integration checkout's existing Node dependencies. No download is needed.

```sh
node --test tests/machine-effects/ordering-undefined-matrix.test.mjs
node scripts/run-quiet-command.mjs --label me01 -- node tests/machine-effects/run.mjs
```

Expected: ten fixed cases traverse real stages; negative mutations block; all
five litmus references match validated existing source artifacts. Existing ARM64
checks remain. In the integration workspace, use the existing persistent gate
wrapper to inherit temporary-storage settings and retain full logs and exact-head
receipts. Do not prepend per-command exports. This does not measure hardware behavior,
architecture-wide undefined masks, independent review or main/release admission.
