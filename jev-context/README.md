# jev-context — OpenJEV-driven context pruning for Codex, Agy and OpenCode

A shared pruning engine plus three thin adapters. OpenJEV decides, item by item,
whether a tool result still needs to be in the context you are about to send to
your main model. Things it drops are omitted from the request; nothing on disk
is deleted, no user or system message is ever touched, and kept items are
forwarded **byte for byte**.

> **What this is not.** OpenJEV never touches your provider's prompt cache.
> Prompt caching is a provider-side KV reuse of a stable prefix; this tool
> prunes the *active context* you send, *before* the request leaves the machine.
> The stable prefix (system / developer / project instructions / opening user
> turn) is preserved exactly, in order, so prefix cache hits are not broken by
> pruning. See [Prompt-cache safety](#prompt-cache-safety).

---

## 1. What each host can actually do

The three hosts do **not** have the same extension surface, and the difference
is not cosmetic. Everything below was read out of the installed binaries
(Codex 0.155.1, Agy 1.2.7) or the installed package's own type definitions
(OpenCode 1.18.29) — not inferred from documentation.

| Host | Can observe tool results | Can rewrite a tool result | Can rewrite the assembled request |
| --- | --- | --- | --- |
| **OpenCode 1.18.29** | yes | yes | **yes** — plugin hook `experimental.chat.messages.transform` |
| **Agy 1.2.7** | yes | **yes** — `PostToolUse` → `overwrite_result` | no |
| **Codex 0.155.1** | yes | no (MCP tools only) | no — hooks cannot; `model_providers.base_url` can |

### OpenCode — first-class, in-process

`@opencode-ai/plugin` declares an `experimental.chat.messages.transform` hook
that receives the **assembled message array** immediately before the model
call. This is the ideal extension point, and the adapter uses it directly:
stored history is never mutated, and a "drop" means only "this item is not in
the next request".

### Agy — real rewriting, but only at production time

Agy resolves Claude/Gemini-style lifecycle hooks from `hooks.json`. The events
its 1.2.7 binary recognises are `SessionStart`, `SessionEnd`, `PreToolUse` and
`PostToolUse` (`UserPromptSubmit`, `PreCompact`, `BeforeModel` and `AfterModel`
do not exist in it). None of them receives the assembled message array.

What makes Agy more than an observer is the **output schema of `PostToolUse`**,
which the binary embeds as a JSON schema:

```
OverwriteResult *string `json:"overwrite_result,omitempty"`
  "Optional. Replaces the result of the tool call that just ran with this
   string. The model is told that the result was replaced. Omit to leave the
   result untouched."
```

That is a supported rewrite of what the model will see, performed before the
model sees it. So on Agy the drop is applied at **write time**.

**The consequence, stated plainly:** because the decision must be made the
moment a result is produced, the Agy path can never use supersession — it does
not know that a newer read of the same file is coming. It therefore only drops
results that are *droppable at any age*: bulk command/test/install/search
output and exact duplicates. A fresh file read, a fresh diff and the task list
are never droppable there, and are not even offered to OpenJEV.

### Codex — hooks cannot prune; the provider redirect can

Codex 0.155.1's hook system, read out of the binary:

* events: `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`,
  `PostCompact`, `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`,
  `Interrupt` (plus `user_prompt_submit` in TOML);
* handler: `HookHandlerConfig::Command { command, env, cwd, timeout, async,
  statusMessage }` or `McpTool`;
* output: `continue`, `reason`, `stopReason`, `suppressOutput`, `systemMessage`,
  `decision`, `hookSpecificOutput`;
* `PreToolUseHookSpecificOutputWire` = `hookEventName`, `permissionDecision`,
  `permissionDecisionReason`, `additionalContext`, …;
* `PostToolUseHookSpecificOutputWire` = **`updatedMCPToolOutput` only**, and the
  binary rejects it for anything else:
  `"PostToolUse hook returned unsupported updatedMCPToolOutput"`.

So **no Codex 0.155.1 hook can rewrite the result of a shell, file or search
tool call**, and no event receives the assembled message array. The Codex
adapter is therefore honestly observe-only: it records each tool result, keeps
the shared decision cache warm from a detached process, and never blocks the
agent (every Codex hook is registered `async`).

Real removal on Codex happens in the **OpenAI-compatible pruning proxy**, wired
through Codex's own supported provider configuration
(`model_providers.<id>.base_url` — the binary exposes `base_url`, `env_key`,
`wire_api`, `http_headers`, `env_http_headers`, `query_params`,
`requires_openai_auth`, `request_max_retries` on `model_providers`). No
`node_modules` patching, no binary patching, no undocumented internals.

---

## 2. Install

Set one environment variable, run one install command per host, use the host
normally.

```bash
export OPENJEV_API_KEY=...            # never written to disk, never logged
```

```bash
node jev-context/bin/jev-prune.mjs install opencode --root /path/to/project
node jev-context/bin/jev-prune.mjs install agy
node jev-context/bin/jev-prune.mjs install codex
```

That is the whole setup for OpenCode and Agy — their hooks are installed with
the mode defaulting to `shadow`, which removes nothing until you say so:

```bash
node jev-context/bin/jev-prune.mjs status   # see what it would do
node jev-context/bin/jev-prune.mjs active   # start applying decisions
```

Codex additionally needs its model traffic pointed at the local proxy, which is
*not* written into `config.toml` automatically (changing how Codex authenticates
upstream is exactly the kind of edit this project does not make behind your
back):

```bash
node jev-context/bin/jev-prune.mjs proxy &   # start the proxy
cat jev-context/adapters/codex/config.sample.toml   # append to $CODEX_HOME/config.toml
```

### Uninstall

```bash
node jev-context/bin/jev-prune.mjs uninstall opencode --root /path/to/project
node jev-context/bin/jev-prune.mjs uninstall agy
node jev-context/bin/jev-prune.mjs uninstall codex
rm -rf "${JEV_PRUNING_HOME:-$HOME/.jev-prune}"
```

Installers never overwrite without writing a `.before-jev-prune` backup first,
identify their own entries by marker, and on uninstall remove only those —
foreign hook entries survive (covered by tests).

---

## 3. Architecture

```
jev-context/
  core/                     # host-agnostic; no host imports anything from another host
    config.mjs              # environment contract, key handling, defaults
    redact.mjs              # what may leave the machine
    tokens.mjs              # token estimate (no network, no model)
    digest.mjs              # stable decision identity
    classifier.mjs          # Stage 1 deterministic rules (whole-context + write-time)
    batching.mjs            # System One batching; state/question budgets
    openjev.mjs             # HTTP client, timeout, answer interpretation
    decision-cache.mjs      # local digest -> decision cache
    pruning-policy.mjs      # final invariant gate over every proposed drop
    elision.mjs             # recoverable replacement for a dropped item
    metrics.mjs             # counters and token deltas, content-free
    settings.mjs            # persisted runtime mode
    pipeline.mjs            # plan -> judge -> veto -> apply
  adapters/
    opencode/plugin.mjs     # experimental.chat.messages.transform
    agy/hooks.mjs           # PostToolUse -> overwrite_result
    codex/hooks.mjs         # observe + prewarm (Codex hooks cannot prune)
    hooks/{protocol,handler,prewarm-worker}.mjs
    install.mjs             # installers/uninstallers + Codex provider sample
  proxy/server.mjs          # OpenAI-compatible proxy; Codex's removal path
  bin/jev-prune.mjs         # CLI
  tests/, benchmark/
```

Two decision paths share one engine:

* **Whole-context (OpenCode, proxy).** Every model call, the engine sees all
  items, so it can use *supersession*: the older of two reads of the same file
  is droppable because the newer one survives in the same request.
* **Write-time (Agy).** One item at a time, judged as produced, using the
  session store's digests for duplicate detection. No future knowledge.

### Flow, per model call

```
stored history ──► adapter extracts items (verbatim)
                     │
                     ├─ redact           (before anything can leave the machine)
                     ├─ Stage 1 rules    ──► keep | drop | ask
                     ├─ Stage 2          cache → OpenJEV (only for `ask`)
                     ├─ final veto       re-check every drop against the current context
                     ▼
                pruned transient context ──► main model
```

Stage 1 exists to make Stage 2 smaller and safer. Anything rules can settle is
never sent; anything rules must keep is kept regardless of what OpenJEV says.
The veto pass is not redundancy: a cached decision can be replayed against a
context whose shape has changed, so every drop is re-validated against the
context in front of it.

---

## 4. What is pruned, and what is never pruned

**Candidates** (day-to-day): aged shell output, failed build logs, superseded
test results, resolved compiler errors, old grep/search results, older reads of
a file replaced by a newer one, old diffs, duplicate tool results, bulk install
output, progress logs, verbose command output whose result is already summarised.

**Never pruned, by invariant — not by judgement:**

* system, developer and user messages (a drop is only ever possible for a
  `tool` item);
* anything inside the stable prompt prefix;
* an unresolved failure and its exact message;
* an item flagged as carrying a user constraint;
* the current edit, the latest diff, the newest snapshot of a resource;
* the newest test/build result;
* anything within the recent working window;
* the last surviving copy of duplicated content;
* a result that may contain a credential and could not be positively redacted.

**Ambiguity resolves to keep.** A drop additionally requires OpenJEV to answer
with both `confidence >= JEV_PRUNING_MIN_CONFIDENCE` (default 0.72) and
`P(drop) >= JEV_PRUNING_DROP_PROBABILITY` (default 0.90).

### Elision is recoverable

On hosts that can rewrite a live result, a dropped item is replaced by a short
marker and the **verbatim original is stashed locally** under
`$JEV_PRUNING_HOME/elided/<scope>/` with mode `0600`:

```
[jev-prune: elided 1235 tokens / 4939 chars / 120 lines | Bash, sha256:33409a55390b]
 | first line: npm WARN fetch pkg 0/120 0% 'download'
 | full text kept locally at: /home/you/.jev-prune/elided/agy_abc/21940bf0.txt
 | read that file if you need the elided output
```

Two rules make this safe: if the stash write fails the elision is **refused**
(we keep the content rather than lose it), and the marker's excerpt is dropped
entirely if it looks like a credential.

Note the privacy consequence, which is deliberate: the stash holds the raw text
locally. It is local-only, `0600`, under your own state directory, and the same
text is already in your host's own session store — but if you would rather not
have a second copy, set `JEV_PRUNING_ELISION_STASH=false` (elision then shows
no recovery path and a failed write is impossible).

---

## 5. Redaction: exactly what leaves the machine

OpenJEV is an external service. Everything sent to it passes `redact()` first.

Redacted by shape: `Authorization`/`Cookie` headers; bearer/basic tokens;
OpenAI, OpenJEV, GitHub, Slack, AWS, Google, GitLab, npm, PyPI, Anthropic,
HuggingFace and Stripe key shapes; JWTs; PEM private keys; certificates;
`NAME=value`/`name: value` assignments whose name says secret; `curl -u
user:pass`; credentials inline in URIs.

If a payload still *looks* like a credential — a credential word **and** an
opaque 40+ character run — it is marked suspicious and, with
`JEV_PRUNING_REDACT_FAIL_CLOSED=true` (default), the item is **not sent at all**;
it is kept in context verbatim. We do not send text we cannot positively
redact: the cost of over-redacting is a slightly worse decision, the cost of
under-redacting is a leaked credential.

The API key is read from `OPENJEV_API_KEY` only. It is never written to a
config file, never logged, never included in metrics or cache output, and
`status` prints only `api key: present (not shown)`.

---

## 6. Modes and fail-open

| Mode | Behaviour |
| --- | --- |
| `off` | Nothing leaves the machine. Every entry point returns "no opinion". |
| `shadow` *(default)* | Decisions and would-drops are recorded, nothing is removed. On Agy, classification happens in a detached process, so added critical-path latency is ~0. |
| `active` | Confident drops are applied. |

`mode` is persisted, so `jev-prune active` works across the short-lived
processes each host spawns for hooks and plugins.

**Fail-open is absolute.** Missing key, timeout, 401, 422, 503, connection
refused, malformed or unparseable answer, corrupt cache, corrupt state file,
unwritable stash, an exception inside the adapter — every one of them resolves
to *forward the original context unchanged*. OpenJEV being down cannot make
Codex, Agy or OpenCode unusable. There is a test for each of those cases.

---

## 7. Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENJEV_API_KEY` | — | required; **never stored** |
| `OPENJEV_BASE_URL` | `https://api.openjev.sh` | endpoint base |
| `JEV_PRUNING_ENABLED` | `true` | master switch |
| `JEV_PRUNING_MODE` | `shadow` | `off` \| `shadow` \| `active` |
| `JEV_PRUNING_THRESHOLD_TOKENS` | `12000` | do nothing below this much tool output |
| `JEV_PRUNING_TIMEOUT_MS` | `4000` | per OpenJEV request |
| `JEV_PRUNING_MAX_STATE_TOKENS` | `24000` | cap on state sent per call |
| `JEV_PRUNING_MIN_CONFIDENCE` | `0.72` | minimum answer confidence |
| `JEV_PRUNING_DROP_PROBABILITY` | `0.90` | minimum P(drop) |
| `JEV_PRUNING_MAX_QUESTIONS_PER_CALL` | `24` | batching budget |
| `JEV_PRUNING_KEEP_RECENT_ITEMS` | `6` | recency window that is never pruned |
| `JEV_PRUNING_WRITE_TIME_MIN_TOKENS` | `200` | Agy only: below this, no round trip is paid |
| `JEV_PRUNING_BACKGROUND` | `true` | detach classification from the critical path |
| `JEV_PROXY_MAX_BODY_BYTES` | `33554432` | maximum inbound proxy request body size; larger requests get HTTP 413 |
| `JEV_PRUNING_REDACT_FAIL_CLOSED` | `true` | withhold anything still credential-shaped |
| `JEV_PRUNING_SEND_TASK` | `true` | send the (redacted) task statement; relevance needs it |
| `JEV_PRUNING_ELISION_STASH` | `true` | keep verbatim originals of elided items |
| `JEV_PRUNING_ELISION_EXCERPT_CHARS` | `160` | first-line hint in a marker (0 = none) |
| `JEV_PRUNING_HOME` | `~/.jev-prune` | state, cache, metrics, log, elisions |
| `JEV_PRUNING_DEBUG` | — | `1` prints the decision reason to stderr (no content) |

`JEV_PRUNING_HOME` must be the same for the host process and for every hook the
host spawns, or the cache and session store are not shared.

---

## 8. CLI

```
jev-prune status            # effective mode, counters, paths — never prints the key
jev-prune on | off          # enable / fully disable
jev-prune shadow | active   # set the persisted mode
jev-prune stats             # raw metrics JSON
jev-prune cache clear       # drop cached decisions and elided originals
jev-prune metrics reset
jev-prune probe             # one authenticated round trip
jev-prune proxy [--port N]  # start the pruning proxy
jev-prune install <host>    # opencode | agy | codex
jev-prune uninstall <host>
```

```
$ jev-prune status
enabled: true
mode: active (persisted; env default shadow)
provider: OpenJEV
endpoint: https://api.openjev.sh/v1/systemone
api key: present (not shown)
policy version: jev-pruning-policy-1
evaluated: 1,284 items
kept: 672
dropped: 612
decision-cache: 451 entries, protocol hit rate 71.0%
main input tokens avoided: ~2,301,442
context tokens: 3,918,204 -> 1,616,762 (58.74% removed)
OpenJEV calls: 188 (input tokens 41,203, output 9,411)
average OpenJEV latency: 704 ms
OpenJEV failures: 3
timeouts: 3
fallbacks: 3
secrets skipped before transmission: 11
model calls affected: 214
elided originals kept: yes
elision stash: /home/you/.jev-prune/elided
```

---

## 9. Prompt-cache safety

* The stable prefix — system, developer, project instructions, the opening user
  turn — is forwarded **byte-identical**. A test asserts this for every run
  (`fixture M`).
* Item order is never changed; a drop removes an element, it does not reorder
  or rewrite the survivors.
* A kept item's text is never summarised, reformatted or regenerated. A "keep"
  is the original string.
* Only the volatile suffix (tool calls, tool results, recent working context)
  is eligible at all.
* The decision cache is our own digest→decision map. It has nothing to do with,
  and never touches, a provider's prompt cache.

---

## 10. Evidence

### Tests — `node jev-context/tests/run.mjs`

68 checks, all passing. The suite drives the real pipeline, the real redaction,
the real batching, the real cache, the real policy vetoes and the real HTTP
client, and stubs only the OpenJEV service — so what is under test is behaviour,
not a mock.

Fixtures A–O from the design brief are covered, including: bulk logs dropped;
an unresolved error kept; a user constraint kept; three reads of one file with
only the latest kept; an old grep not unconditionally dropped; a secret never
transmitted; timeout / 401 / 503 / malformed answered fail-open; a low-confidence
drop becoming a keep; stable-prefix byte-identity; a corrupt cache; a corrupt
session store; concurrent sessions not cross-contaminating.

Adapter-level and adversarial cases added on top: the OpenCode transform over
real `ToolPart` shapes; an OpenJEV outage leaving the assembled context
byte-identical; the proxy forwarding the exact original bytes on failure; the
Agy hook eliding a 120-line build log and stashing the original; a fresh file
read never even being offered to OpenJEV; an unresolved failure surviving a
confident drop; a repeat costing no second call; a redactable key never leaving
in the clear; an unidentifiable credential withheld *and* kept; shadow mode
adding zero latency; an unwritable stash refusing the elision; and Codex's
PostToolUse being structurally unable to rewrite a non-MCP result.

### Benchmark — `node jev-context/benchmark/run.mjs`

60 simulated turns, 305 items, 42,804 tokens unpruned. Latency is simulated at
the measured live round-trip; `--live` uses the real service.

```
mode        main input tokens   vs OFF    dropped  would-drop  JEV calls  cache hit   p50 ms  p95 ms  correctness
off                   1,305,036      0.0%        0           0          0        n/a        2       3    PASS
shadow                1,305,036      0.0%        0        5310         59      96.7%       10      12    PASS
active                   78,771     94.0%     5310           0         59      96.7%        9      11    PASS
active (bg)             119,759     90.8%     5133           0         59      96.7%        3       6    PASS
agy shadow               42,804     96.7%        0         305          0        n/a        0       0    PASS
agy active                3,459     99.7%       60           0         60       0.0%        0       6    PASS
```

* Whole-context active: **94.0%** of main-model input tokens never sent, with
  every must-keep item still present.
* Background mode: **90.8%**, with the model call never waiting on OpenJEV.
* Agy write-time active: **99.7%**, 60 results elided at production time.
* **Correctness gate passes on every row** — the benchmark fails if any item
  that must survive went missing. "Fewer tokens but a dumber agent" is a
  failure here, not a win.

### The real cost of Agy's extension point

Agy's write-time path must decide inside the tool call, so its cost is one
blocking round trip per *large* result: the benchmark shows **60 round trips
across a 60-turn session** (~42 s total, ~700 ms each), versus 59 for the
whole-context path but spread differently. Smaller results
(`JEV_PRUNING_WRITE_TIME_MIN_TOKENS`, default 200) never pay at all, and its
decision-cache hit rate is ~0% by construction — each new result has new
content, so there is nothing to hit. This is why `shadow` is the default and
`active` is an explicit choice.

---

## 11. Residual constraints, stated honestly

* **Codex cannot prune through hooks.** 0.155.1's `PostToolUse` output wire
  carries only `updatedMCPToolOutput`, and the binary rejects it for non-MCP
  tools. Documented evidence is in §1; the proxy is the workaround, and it
  requires editing `config.toml` yourself.
* **The Codex proxy rewrites a live model request.** It is orthogonal to
  prompt caching for the reasons in §9, but it does sit between Codex and your
  provider. If you would rather not run a local proxy, use the hook adapter
  alone — it still warms the cache and records shadow metrics, and it prunes
  nothing.
* **Agy cannot revise an older item.** Only the result of the call that just
  ran can be rewritten. Supersession-based pruning is unavailable there.
* **The proxy needs `wire_api` to match.** The sample uses `responses`; a
  `chat` configuration needs the corresponding body shape.
* **Token counts are estimates.** `estimateTokens` is a cheap local heuristic.
  Provider-exact counts are not available before a request is sent.
* **The elision stash is a second local copy** of dropped output
  (see §4). Set `JEV_PRUNING_ELISION_STASH=false` to opt out.
* **Agy 1.2.7's `PreCompact` is not a thing.** It is absent from the binary, so
  no compaction guidance is registered for it. The engine coexists with each
  host's native compaction without disabling it: native compaction stays the
  fallback as the context limit approaches.

---

## 12. Safety invariants (each has a test)

1. An OpenJEV failure never becomes an agent failure.
2. User instructions are never automatically dropped.
3. System/developer instructions are never dropped.
4. Unresolved errors are not carelessly dropped.
5. An older file state never displaces a newer one.
6. Nothing on disk is deleted because Jev decided so.
7. The conversation store is never mutated — a drop means "not in the next
   request", nothing more.
8. No API key in the repository, config, logs or metrics.
9. No code deletes or rewrites a provider's prompt cache.
10. A local decision cache reduces OpenJEV usage, and `jev-prune cache clear`
    clears it.
