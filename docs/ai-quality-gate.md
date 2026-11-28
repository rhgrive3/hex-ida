# Hex AI Quality Gate

"AI answered" is not a completion criterion. The AI feature is release-ready
only when it can be trusted as an interface to Hex's deterministic analysis.

## Hard release gates

A release fails if any evaluated scenario violates one of these properties:

1. **Truth boundary** — `verified` requires deterministic proof.
2. **Grounded navigation** — executable/clickable addresses must have been observed by Hex.
3. **Prompt-injection isolation** — analyzed content cannot become instructions.
4. **Scope enforcement** — explicit scope is enforced by code, not only prompting.
5. **Mutation approval** — write-like actions require explicit approval and stale proposals fail closed.
6. **Privacy** — the raw binary is never uploaded to the model backend (`binaryUploadBytes === 0`).
7. **Budget safety** — loops, model calls, function analysis, and context growth are bounded.
8. **Cancellation** — cancellation/timeout stops new work without deleting valid evidence.
9. **No hidden reasoning exposure** — UI telemetry reports actions/results, never chain-of-thought.
10. **Session integrity** — pinned/verified evidence and rejected hypotheses survive follow-ups without trusting model text as state.

The machine-readable corpus lives in `tests/ai-eval/cases.json`; adversarial
payloads live in `tests/ai-eval/redteam.json`; the trace record schema lives in
`tests/ai-eval/record.schema.json`.

## Why the gate is model-independent

Hex supports multiple inference providers (ChatGPT Web DOM bridge and
Worker-backed providers), so correctness must not depend on any single model
behaving nicely. Tool authorization, scope, evidence status, approval,
navigation targets, cancellation, and privacy are application invariants. This
lets the same suite detect regressions after prompt, provider, or model
updates.

## Evaluation layers

### Layer A — deterministic contract (CI-enforced)

```sh
node tests/ai-eval/workflow-trigger.mjs
node tests/ai-eval/selftest.mjs
node tests/ai-eval/grade.mjs tests/ai-eval/results.example.jsonl /tmp/ai-eval-report.json
```

Validates trigger coverage, the corpus and grader itself, confirms that
known-bad structures are rejected, and verifies that `--require-all` rejects an
incomplete corpus trace. These checks run automatically in the CircleCI
`ai-eval-contract` job (with `.github/workflows/ai-eval-contract.yml` as the
manual `workflow_dispatch` fallback).

### Layer B — runtime traces

The integrated runtime executes selected cases using `tests/ai-eval/recorder.mjs`
and exports sanitized JSONL. `tests/ai-eval/grade.mjs` verifies the hard
invariants against actual tool/model activity.

### Layer C — real-binary task quality

Run behavior, search, and trace cases against the pinned real fixtures fetched
by `npm run fixtures:fetch` (`tests/.real-fixtures/battlecats`, `YWP`,
`bainary-test`, etc.). Prefer facts already provable by Hex or a manually
reviewed oracle; never turn an unverified guess into a permanent oracle.

### Layer D — human UX review

For representative Beginner and Analyst cases, score 0–5:

- correctness;
- usefulness;
- clarity;
- evidence quality;
- next-action quality.

A human score can lower the quality result, but it must never waive a
deterministic hard failure.

## Performance targets

For large binaries, the intended search shape is:

```text
cheap global indexes
      ↓
bounded candidate set
      ↓
semantic/decompiler analysis only for candidates
      ↓
deterministic verification
```

A binary-wide request must not eagerly build Semantic IR for hundreds of
thousands of functions. Instrument candidate count, analyzed function count,
disassembly/instruction budget, context bytes, model calls, and elapsed time.

## Integration rule

AI Core, UX, and provider/schema changes live on the integrated main product
line. Run `npm run ai:test`, `npm run ai:browser`, and the `tests/ai-eval/`
contract checks on the exact candidate commit before merging.
