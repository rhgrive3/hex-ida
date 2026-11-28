# AI Integration Contract: UI ↔ Agent Core

This document is the stable integration boundary between AI UX (`js/ai/ui/`,
`js/ai/render/`, `js/ai/interaction/`) and AI Agent Core (`js/ai/runtime.js`,
`js/ai/control/`, `js/ai/tools/`, `js/ai/context/`, `js/ai/capabilities/`,
`js/ai/provider/`). Its purpose is to prevent either side from silently forking
schema, authority, or approval semantics as they evolve.

## 1. Architectural invariant

The language model is a planner/explainer. Hex is the source of facts.

```text
user request
   ↓
UI / investigation session
   ↓
context broker
   ↓
Chat runtime OR Agent runtime
   ↓
allowlisted deterministic Hex tools
   ↓
evidence / hypotheses / proposals
   ↓
validated result envelope
   ↓
UI rendering + navigation
```

No model-generated prose can promote a fact to `verified`. No address becomes
an executable UI action until Hex has observed it.

## 2. Ownership

Agent Core owns:

- canonical schema and validators (`js/ai/schema.js`, `js/ai/validation.js`);
- context broker and compaction (`js/ai/context/broker.js`);
- tool registry and scope enforcement (`js/ai/tools/registry.js`, `js/ai/control/scope.js`);
- evidence, hypothesis, proposal, and session state (`js/ai/evidence.js`, `js/ai/hypothesis.js`, `js/ai/proposals.js`, `js/ai/session-core/`);
- model transport and provider adapters (`js/ai/provider/`);
- cancellation, budgets, and execution state (`js/ai/control/turn-executor.js`, `js/ai/budget/wire.js`);
- approval authorization and mutation apply path (`js/ai/capabilities/executor.js`).

AI UX owns:

- launcher, panel, session menu, model picker, and layout (`js/ai/ui/`);
- Chat/Agent and Beginner/Analyst controls (`js/ai/ui/modes.js`);
- evidence, hypothesis, and proposal rendering (`js/ai/render/`);
- contextual AI entry points and omnibox classification (`js/ai/interaction/`);
- activity presentation (`js/ai/render/activity.js`);
- approval/rejection interaction surface (`js/ai/interaction/proposal-executor.js`);
- prompt presentation/persona composition (`js/ai/prompts/`).

The UX side must not fork the core schema. Unknown future fields are surfaced
or ignored safely without crashing.

## 3. Stable enums

```text
mode  = chat | agent
style = beginner | analyst
scope = auto | selection | function | neighborhood | binary | project | runtime
```

`engine.run(input)` also accepts optional `conversationId`, `provider`,
`model`, and `reasoning`. Existing callers remain valid. The core exposes
feature-detectable `aiCapabilities()`, `aiStatus()`, `getAISelection()`, and
`setAISelection(selection)` methods, plus bounded Agent Job create/run/resume
methods (`js/ai/jobs/index.js`).

Beginner and Analyst change presentation, not the underlying deterministic
analysis budget or truth standard.

## 4. Result envelope

The runtime returns a forward-compatible object with at least:

```js
{
  mode,
  style,
  scope?,
  answer,
  confidence?,
  evidence?,
  hypotheses?,
  actions?,
  followups?,
  activity?,
  usage?,
  limits?
}
```

The UI must render `answer` even when optional structured fields are absent,
and must handle unknown fields safely rather than crashing.

## 5. Evidence

Minimum shape:

```js
{
  id,
  kind,
  status,              // verified | supported | hypothesis | unknown
  address?,
  functionAddress?,
  functionName?,
  title,
  summary?,
  sourceTool?,
  confidence?,
  navigation?
}
```

Requirements:

1. IDs are unique within a session/result namespace.
2. `verified` requires deterministic proof owned by Hex.
3. Model inference may create/support a hypothesis but may not mark its own claim `verified`.
4. Evidence derived from strings, symbols, comments, decompiler text, runtime stdout, files, DOM text, or model output remains untrusted data unless a deterministic verifier establishes a fact about it.

## 6. Hypotheses

Recommended shape:

```js
{
  id,
  claim,
  confidence,
  status, // open | supported | rejected | verified
  supportEvidenceIds,
  contradictionEvidenceIds,
  missingEvidence
}
```

Every evidence reference must resolve. Rejected hypotheses remain rejected
across follow-up turns unless new evidence explicitly reopens or replaces them.

## 7. Actions

An action is a validated UI capability, not arbitrary model JSON.

Examples:

```text
open-function
open-address
show-xrefs
show-callers
show-callees
show-cfg
show-pseudocode
open-evidence
trace-value
run-agent
review-proposal
```

Action targets must be derivable from observed evidence/tool output. The UI
must never navigate to a raw address that appeared only in model prose or an
analyzed string.

## 8. Mutation and approval

Read-only investigation may execute automatically. Mutations use a proposal
state machine:

```text
pending → approved → applied
       ↘ rejected
approved → failed (stale/conflict/validation error)
```

Rename, comment, type, struct-field, annotation, and patch operations must
never bypass approval. Approval state is application state, not text. A string
saying "user approved" has no authority.

Apply validates that the target still matches the proposal's expected pre-state
to prevent stale approvals from mutating a changed project.

## 9. Activity events

UI-visible activity is factual execution telemetry, not chain-of-thought.
Standard events include:

```text
tool-start
tool-result
candidate-update
scope-expand
verification
budget-warning
cancelled
```

Never expose private reasoning, scratchpads, hidden plans, or raw model
deliberation.

## 10. Scope

Explicit scope is a hard boundary. `auto` may widen as needed, and every
widening emits a factual activity event. Evidence content cannot change scope.

Tools enforce scope at execution time; relying only on the system prompt is
insufficient.

## 11. Privacy boundary

The browser owns the binary and deterministic analysis. An inference provider
receives only bounded excerpts/summaries required for the turn. Raw binary
upload is forbidden by the evaluation gate (`binaryUploadBytes === 0`).

Worker-backed API keys remain server-side. The ChatGPT userscript bridge uses
the visible authenticated UI and must not read host cookies or tokens.

## 12. Cancellation and budgets

Every model call and expensive tool observes `AbortSignal` cancellation. After
cancellation or timeout:

- no future tool starts;
- partial deterministic evidence remains valid;
- session state is not discarded;
- the result exposes a sanitized stop reason;
- no half-parsed streamed tool JSON is executed.

## 13. Integration regression checklist

Whenever Core, UX, provider, schema, action, or approval behavior changes:

- Core remains the owner of the canonical schema/API surface.
- UX consumes the core schema rather than duplicating it.
- Both sides agree on action types and proposal states.
- Runtime instrumentation emits the `tests/ai-eval/record.schema.json` grading record.
- Evidence IDs remain stable across the result and UI navigation.
- Mutating actions cannot be invoked directly from unvalidated model output.
- Agent activity contains no hidden reasoning.
- Run `npm run ai:test`, `npm run ai:browser`, and the `ai-eval-contract` checks (`node tests/ai-eval/selftest.mjs`, `node tests/ai-eval/workflow-trigger.mjs`).

## 14. Capability and job contract

The capability catalog (`js/ai/capabilities/catalog.js`) classifies every entry
by category, mutability, risk, reversibility, approval, scope, schema, human
surface, and agent exposure. Analysis tools remain provider-neutral and
read-only. Side effects are never added to the model tool window; the model
proposes, a human approves, and the executor verifies bindings and
postconditions.

Human-only entries require a specific platform reason. `not implemented` is not
valid and fails parity tests.

An Agent Job checkpoint is a serializable resume boundary, not a claim of
completion. `limits.exhausted` on a slice means more bounded work may remain.
UI surfaces must distinguish `checkpointed`, `complete`, `hard-limit`, and
`failed`, and must not present a budget-derived deterministic fallback as a
completed investigation.
