# Hex AI Agent Core

## Purpose and trust boundary

Hex AI is an interface to Hex's analysis engines, not a second source of
reverse-engineering facts. The language model plans, selects tools, interprets
bounded observations, and explains results. Browser-side Hex code owns the
binary, executes tools, validates addresses and scopes, produces evidence, and
decides whether a claim is verified.

The raw binary never crosses the inference boundary. Only the user request,
bounded excerpts, compact tool observations, evidence references, and compact
conversation state may be projected to an inference provider. The Cloudflare
Worker holds API credentials for Worker-backed providers; the ChatGPT Web
provider uses the visible authenticated host UI through the userscript bridge
and does not read cookies or tokens.

```text
natural-language goal
        |
        v
browser AI turn router ---- chat (0-2 lightweight tools)
        |                 `-- agent (bounded plan/tool/verify loop)
        v
context broker (local context != model context)
        |
        v
deterministic tool registry --> Semantic IR / dataflow / xrefs / runtime / project
        |                              |
        v                              v
evidence + hypothesis stores <--- deterministic verifier
        |
        v
structured result + validated UI actions
        |
        v
AIProvider.nextTurn()
        |-- UserscriptAIProvider -> visible ChatGPT Web DOM bridge
        `-- WorkerAIProvider     -> same-origin POST /api/ai/turn -> provider inference
```

The execution contract follows the common typed tool-loop pattern: the model
emits typed requests, while the host validates and executes them. Hex
implements only the small provider-neutral subset it needs and does not depend
on an external agent framework.

## Core module layout

- `js/ai/runtime.js`, `js/ai/schema.js`, `js/ai/validation.js`, `js/ai/conversation-identity.js` — runtime orchestration, canonical schema, validation, and canonical conversation identity.
- `js/ai/control/` (`turn-executor.js`, `scope.js`, `snapshot.js`, `tool-window.js`, `runtime-support.js`) — turn execution, scope checks, snapshot binding, and tool-window controls.
- `js/ai/context/` (`broker.js`, `planner-target-hint.js`, `index.js`) — browser-local vs model-projected context separation and compaction.
- `js/ai/tools/` (`registry.js`, `registry-core.js`, `registry-base.js`, `registry-query-base.js`, `contracts.js`, `names.js`, `schemas.js`, `scoped-analysis.js`, `paging/cursor.js`, `projections/index.js`, `storage/observation-store.js`) — allowlisted deterministic tool registry, cursor paging, projections, and observation storage.
- `js/ai/capabilities/` (`catalog.js`, `executor.js`, `executor-base.js`, `parity.js`) — canonical human/agent capability inventory, execution, and parity checks.
- `js/ai/evidence.js`, `js/ai/hypothesis.js`, `js/ai/proposals.js`, `js/ai/session-core/` (`index.js`, `persisted-confirmed.js`), `js/ai/jobs/index.js` — evidence/hypothesis/proposal stores, persisted confirmed-finding authority, and resumable Agent jobs.
- `js/ai/investigation/` (`scoped-frontier.js`, `scoped-job-context.js`, `scoped-policy.js`) — scoped multi-turn investigation frontiers and policies.
- `js/ai/provider/` (`index.js`, `chatgpt-web.js`, `worker-transport.js`, `worker-protocol.js`, `worker-turn.js`, `worker-adapters.js`, `worker-legacy.js`), `js/ai/quota.js`, `js/ai/budget/wire.js` — provider adapters, Worker wire protocol, and quota/budget enforcement.
- `js/agent/` (`runtime.js`, `tools.js`, `tools-core.js`, `candidate-authority.js`) — deterministic agent runtime helpers and candidate authority.
- `js/ai/dev/` — Admin-only Dev Supervisor, protocol, context packet, policy, bootstrap, and Worker-pool orchestration (strictly isolated from Standard builds; fail-closed default `DenyAllAdminProvider` in `js/ai/dev/auth/admin-provider.js`).

## Chat and agent runtimes

`chat` prioritizes latency. It can answer a general reverse-engineering
question with no file or current function and permits at most two lightweight
tool/model turns by default. Its context starts with a selection or active
function only when relevant.

`agent` runs a bounded investigation. Deterministic first-stage planning uses
cheap lexical/string indexes to create a shortlist, call-graph expansion adds
candidates, Semantic IR analyzes only that shortlist, and deterministic
verifiers rank the strongest candidates. The model can then choose additional
allowlisted tools or submit a final structured result.

Beginner and analyst styles use the same analysis; only the final presentation
differs.

## Scope

The public scopes are `auto`, `selection`, `function`, `neighborhood`,
`binary`, `project`, and `runtime`. Tool definitions state their supported
scopes. The registry rejects an incompatible explicit scope before execution
and can delegate address-boundary checks to `scopeContainsAddress` in the local
context.

`auto` may expand from selection to function, neighborhood, binary, project, or
runtime. Every expansion emits a `scope-expand` activity event. Activity
contains deterministic lifecycle facts, never hidden chain-of-thought.

## Context broker and budgets

`ContextBroker` keeps the browser-only local context separate from the model
projection. Local context may contain the binary object, indexes, runtime
session, registry, stores, and project. The model projection contains only:

1. The current request and mode/style/scope.
2. Relevant verified and pinned evidence.
3. Active hypotheses.
4. Recent bounded observations.
5. A bounded selection/function excerpt.
6. A compact history summary and a few recent messages.

Old raw tool output is retained locally in `EvidenceStore` /
`ObservationStore`, not replayed on every model turn. The default context limit
is 64 KiB for chat and 128 KiB for agent. Large functions are truncated before
older high-priority evidence is removed.

All tool-derived text is tagged `untrusted-data`. Provider instructions
explicitly treat strings, symbols, comments, assembly, decompiler output, DOM
text, and other observed content as data even when they contain prompt-like or
tool-call-like text.

## Tools and deterministic planning

`createHexToolRegistry` adapts existing Hex APIs instead of duplicating
analysis algorithms. Every tool has a name, description, JSON input schema,
cost, scope support, mutability classification, approval requirement, and
executor. Arguments, addresses, scope, cancellation, output size, and optional
output schemas are checked at the registry boundary.

The registry provides function/string search; current/selected/function
context; xrefs/callers/callees; Semantic IR facts and decompilation; CFG;
field/global reads and writes; value slicing; thresholds and field-update
verification; related functions; knowledge/signature lookup; function
comparison; project search; and conditional runtime/diff tools. Search output
is bounded and expensive analysis is never started across every function in a
large binary.

Candidate ranking exposes `lexicalScore`, `semanticScore`, `graphScore`,
`evidenceScore`, `runtimeScore`, `totalScore`, and reasons. No opaque model
score determines ordering.

## Evidence and hypotheses

Evidence records are created from deterministic tool results. Generic searches
and semantic observations are `supported`; designated verifier results may be
`verified`. Model output cannot insert a verified evidence record.

A hypothesis references known support and contradiction evidence IDs.
`HypothesisStore` downgrades a model-requested `verified` status unless every
supporting record is deterministically verified. Unknown evidence IDs are
removed. Rejected hypotheses remain part of the investigation session.

The final consistency check removes missing evidence IDs and invented UI
actions. Address actions are accepted only when the address exists in stored
evidence and the local address validator does not reject it.

## Mutations and approval

Mutations are not model-callable tools. `ProposalStore` creates a pending
proposal for rename, comment, type, struct field, patch, or project annotation.
A proposal requires evidence. The UI (or another human-facing owner) approves
it and receives an opaque approval token. Apply requires the token and verifies
that the target's current state still matches the proposal's `before`
fingerprint. Rejected or stale proposals fail without mutation, and every
transition creates an audit event.

`CapabilityCatalog` is the canonical inventory for analysis-relevant human and
agent operations. Read operations delegate to the deterministic tool registry.
Navigation, annotation, patch, runtime, and project operations use
`CapabilityExecutor`; approval is authorization state, never model text. Patch
execution verifies address/range/alignment, expected original bytes,
postconditions, and revert metadata. Runtime operations additionally require
the exact binary and runtime session identities. Parity checks require every
human capability to have an agent adapter or one of the narrow concrete
human-only reasons (trusted file-picker gesture, unavailable external OS
facility, or inherently visual setting).

## Sessions and persistence

An investigation session stores the binary ID, mode/style/scope, goal, compact
messages and summary, pinned evidence, hypotheses, confirmed findings, rejected
hypotheses, proposals, and timestamps. Secret-looking keys are stripped before
persistence. `.hexproj` findings accept `investigationSessions` while remaining
backward compatible with version 1 projects; binaries remain external and are
never embedded.

UI `conversationId` values map independently to AIRuntime session IDs. Provider
requests also carry `conversationId`, `provider`, `model`, and `reasoning`;
older callers may omit them. `AgentJobManager` extends a large investigation as
a sequence of bounded turns. Each checkpoint retains the goal, effective scope,
AIRuntime session, evidence/hypothesis IDs, completed tools,
continuation/detail references, unresolved work, and cumulative budget. A slice
budget creates a resumable `checkpointed` state; only the explicit job-wide
slice/elapsed limits produce `hard-limit`.

## Provider boundary

`AIProvider.nextTurn(request, options)` is the runtime dependency on inference.
Provider selection is host-dependent:

- `UserscriptAIProvider` is used when the parent userscript exposes
  `__HEX_CHATGPT_BRIDGE__`; it drives the visible ChatGPT Web model/reasoning
  UI through the browser-local bridge.
- `WorkerAIProvider` is used when no ChatGPT bridge is active; it calls
  same-origin `POST /api/ai/turn` and keeps API credentials in the Worker
  environment.

Both providers return the same typed turn protocol and neither executes Hex
analysis itself. Model/provider names stay out of deterministic analysis code.

The Worker-backed path validates request size, mode/style/scope, bounded
context, tool names, and tool schemas. Tool names must be in Hex's static
allowlist. It rejects binary-shaped payloads, applies rate/resource limits via
the `AI_QUOTA` Durable Object, holds the provider key, disables provider
storage where supported, applies a timeout, and requires a complete typed
response. Browser tools are never executed by the Worker.

Agent function calls are executed only after the complete JSON response
validates. `AbortSignal` propagates through provider fetch/bridge work and tool
execution; cancelling preserves the session and evidence already collected.
Legacy `/api/gemini` paths remain compatibility surfaces only.

## Errors and observability

Errors use stable categories: model timeout, provider error, invalid model
output/tool call, tool failure, scope violation, budget exhaustion,
cancellation, context too large, and approval required. A failed turn returns
retained deterministic findings when possible rather than deleting session
state.

Results include model/tool call counts, latency, maximum context bytes,
candidate/analyzed function counts, disassembly count, and tool cost. Activity
events expose tool and candidate lifecycle without model reasoning. Raw
confidential tool output is not dumped to the console.

## Extension guide

To add a read tool:

1. Add its stable name to `AI_TOOL_NAMES` (`js/ai/tools/names.js`).
2. Register a definition in `createHexToolRegistry` with a narrow JSON schema,
   bounded output, cost, and exact scope support.
3. Reuse an existing Hex public API. Add a backward-compatible analysis API
   only if none exists.
4. Decide whether the result is merely supported evidence or comes from a
   deterministic verifier. Do not mark a discovery/search tool as a verifier.
5. Add validation, scope, truncation, cancellation, injection, and evidence
   tests under `tests/` and wire them into `npm run ai:test`.

Do not register mutating tools. Add a proposal kind and human-reviewed apply
adapter instead. Provider adapters must return the shared `{type:"tool"}` or
`{type:"final"}` protocol and must not execute analysis themselves.
