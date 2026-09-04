# Quickstart

Run the focused matrix:

```sh
node --test tests/phase7/discovery/ambiguity-matrix.test.mjs
```

Run the production format-safe rebuild entrypoint regression:

```sh
node tests/stage2/rebuild-transaction.test.mjs
```
Run exact-head X-03 verification after committing the candidate:

```sh
node tools/validation/discovery/x03-verify.mjs
```

Expected terminal marker:

```text
X03_VERDICT=READY
```

Run the canonical Phase 7 gate:

```sh
node scripts/run-quiet-command.mjs --label phase7 -- node tests/phase7/run.mjs
```
