import { loadConfig, POLICY_VERSION } from "./config.mjs";
import { estimateTokens, sumTokens } from "./tokens.mjs";
import { redact, mustNotTransmit } from "./redact.mjs";
import { decisionDigest, questionId } from "./digest.mjs";
import { classifyAll, classifyWriteTimeItem, protectedPrefixEnd, containsFailure } from "./classifier.mjs";
import { buildBatches } from "./batching.mjs";
import { createOpenJevClient, interpretAnswer } from "./openjev.mjs";
import { createDecisionCache } from "./decision-cache.mjs";
import { createMetrics } from "./metrics.mjs";
import { createSettingsStore } from "./settings.mjs";
import { resolveDecisions, buildVetContext } from "./pruning-policy.mjs";

export { POLICY_VERSION };

/**
 * The pruning pipeline.
 *
 * Flow, per model call:
 *
 *   stored history  ──►  items (adapter-extracted, verbatim)
 *                          │
 *                          ├─ redact (before anything can leave the machine)
 *                          ├─ Stage 1 rules ──► keep | drop | ask
 *                          ├─ Stage 2: cache → OpenJEV (only for `ask`)
 *                          ├─ invariant veto
 *                          ▼
 *                     pruned transient context  ──►  LLM
 *
 * Nothing here writes to a conversation store. A "drop" means exactly one
 * thing: this item is omitted from the context assembled for the next model
 * request. The stored history is untouched.
 */

/** Normalises adapter output into the internal item shape, computing digests and tokens. */
export function makeItem(input, { scope, policyVersion, index = 0 }) {
  const text = typeof input.text === "string" ? input.text : String(input.text ?? "");
  const item = {
    id: String(input.id),
    role: input.role || "tool",
    tool: input.tool || null,
    text,
    tokens: estimateTokens(text),
    // Position must reflect the item's slot in the assembled context: the
    // stable-prefix guard in the pruning policy compares against it, and a
    // default of 0 would make every item look like it sits inside the prefix.
    position: Number.isInteger(input.position) ? input.position : index,
    meta: input.meta || {},
    flags: input.flags || {},
  };
  item.digest = decisionDigest({ content: text, tool: item.tool, scope, policyVersion });
  return item;
}

export function createPipeline(overrides = {}) {
  const config = overrides.config || loadConfig(overrides.env || process.env);
  // A persisted runtime mode (from `jev-prune active|shadow|off`) overrides the
  // environment default, because hook/plugin processes are short-lived and
  // cannot carry a shell variable forward.
  const settings = overrides.settings || createSettingsStore({ path: config.statePath });
  const persisted = overrides.ignorePersistedMode ? {} : settings.load();
  if (persisted.mode) config.mode = persisted.mode;
  config.usable = config.enabled && config.mode !== "off" && config.apiKey.length > 0;
  const cache =
    overrides.cache ||
    createDecisionCache({ path: config.cachePath, policyVersion: config.policyVersion });
  const metrics = overrides.metrics || createMetrics({ path: config.metricsPath });
  const client = overrides.client || createOpenJevClient(config, overrides.deps || {});
  const logger = overrides.logger || (() => {});

  // Read the cache once up front: this detects a corrupt file even on a pass
  // that never needs a lookup, so `jev-prune status` can report it truthfully.
  cache.load();

  let lastPlan = null;

  /** Redacts the task statement and honours JEV_PRUNING_SEND_TASK. */
  function safeTaskText(text) {
    if (!config.sendTask) return "";
    const raw = String(text || "");
    if (!raw) return "";
    return redact(raw).text;
  }

  /**
   * Plans a pruning pass without applying it.
   *
   * @param {Array} rawItems   adapter-extracted items
   * @param {object} options   { taskText, scope, allowBlockingRequests, signal }
   * @returns {Promise<object>} plan with decisions and stats
   */
  async function plan(rawItems, options = {}) {
    const scope = options.scope || "default";
    const mode = options.mode || config.mode;
    const allowBlocking = options.allowBlockingRequests !== false;

    const items = rawItems.map((raw, index) =>
      makeItem(raw, { scope, policyVersion: config.policyVersion, index }),
    );

    const tokensBefore = sumTokens(items);
    const stats = {
      mode,
      tokensBefore,
      tokensAfter: tokensBefore,
      evaluated: 0,
      kept: items.length,
      dropped: 0,
      wouldDrop: 0,
      cacheHits: 0,
      cacheMisses: 0,
      openjevCalls: 0,
      openjevInputTokens: 0,
      openjevOutputTokens: 0,
      openjevLatencyTotalMs: 0,
      openjevLatencySamples: 0,
      timeouts: 0,
      apiFailures: 0,
      fallbacks: 0,
      redactions: 0,
      skippedUnsafe: 0,
      shadow: mode !== "active",
      modelCallsAffected: 0,
      estimatedMainTokensAvoided: 0,
      engaged: false,
      reason: "disabled",
      failures: [],
    };

    const plan = { items, decisions: [], stats, tokensBefore, tokensAfter: tokensBefore };

    if (!config.enabled || mode === "off") {
      plan.stats.reason = "disabled";
      plan.decisions = items.map((item) => keepDecision(item, "processing disabled"));
      lastPlan = plan;
      return plan;
    }

    // Write-time passes judge a single freshly produced result, so the
    // "is the context big enough to bother" staging does not apply: there is no
    // later call at which the judgement could be applied instead.
    const writeTime = options.writeTime === true;

    // Token-budget staging: do nothing at all while the context is small. This
    // is what keeps per-call overhead at zero for short sessions.
    const toolTokens = sumTokens(items.filter((item) => item.role === "tool"));
    if (!writeTime && toolTokens < config.thresholdTokens) {
      plan.stats.reason = "below-threshold";
      plan.stats.toolTokens = toolTokens;
      plan.decisions = items.map((item) => keepDecision(item, "context below pruning threshold"));
      lastPlan = plan;
      return plan;
    }
    plan.stats.engaged = true;
    plan.stats.reason = "engaged";
    plan.stats.toolTokens = toolTokens;

    let verdicts;
    if (writeTime) {
      // Duplicate detection needs the digests already in the session, because
      // the item under judgement is the only one in this pass.
      const priorDigests = options.priorDigests instanceof Map ? options.priorDigests : new Map();
      const countsByDigest = new Map(priorDigests);
      for (const item of items) countsByDigest.set(item.digest, (countsByDigest.get(item.digest) || 0) + 1);
      verdicts = items.map((item) => classifyWriteTimeItem(item, { countsByDigest }));
    } else {
      verdicts = classifyAll(items, { keepRecentItems: config.keepRecentItems }).verdicts;
    }
    stats.evaluated = verdicts.filter((verdict) => verdict.action === "ask").length;

    // ---- Stage 2 preparation -------------------------------------------------
    const cached = new Map();
    const questionByItem = new Map();
    const candidates = [];

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const verdict = verdicts[index];
      if (verdict.action !== "ask") continue;

      const cachedEntry = cache.get(item.digest);
      if (cachedEntry) {
        cached.set(item.digest, cachedEntry);
        stats.cacheHits += 1;
        continue;
      }
      stats.cacheMisses += 1;

      // Secrets leave the machine only through an explicitly clean redaction.
      const redaction = redact(item.text);
      stats.redactions += redaction.count;
      if (mustNotTransmit(redaction, { failClosed: config.redactFailClosed })) {
        item.flags.secretFailClosed = true;
        stats.skippedUnsafe += 1;
        verdicts[index] = {
          ...verdict,
          action: "keep",
          reason: "not transmitted: possible credential",
          flags: { ...verdict.flags, secretFailClosed: true },
        };
        continue;
      }

      const qid = questionId("item", index);
      questionByItem.set(item.id, qid);
      candidates.push({
        item,
        questionId: qid,
        redactedText: redaction.text,
        tokens: item.tokens,
        note: item.meta && item.meta.command ? `command=${String(item.meta.command).slice(0, 120)}` : "",
      });
    }

    // ---- Stage 2 execution ---------------------------------------------------
    const judgements = new Map();

    if (candidates.length > 0) {
      if (!config.usable && !config.partialPruning) {
        stats.fallbacks += 1;
        stats.failures.push("missing-api-key");
      } else if (!allowBlocking) {
        // Background mode: never make the host agent wait for OpenJEV.
        stats.fallbacks += 1;
        stats.failures.push("deferred-to-background");
      } else {
        // The task statement is user-authored, so it goes through the same
        // redaction gate as everything else before it can leave the machine.
        const batches = buildBatches(candidates, { taskText: safeTaskText(options.taskText), config });
        for (const batch of batches) {
          const started = Date.now();
          const result = await client.classify({ state: batch.state, questions: batch.questions, signal: options.signal });
          stats.openjevCalls += 1;
          stats.openjevLatencySamples += 1;
          stats.openjevLatencyTotalMs += result.latencyMs || Date.now() - started;

          if (!result.ok) {
            // Fail-open: no pruning from this batch, and the caller's context is
            // forwarded exactly as it was.
            stats.apiFailures += 1;
            stats.fallbacks += 1;
            if (result.reason === "timeout") stats.timeouts += 1;
            stats.failures.push(result.reason);
            logger("openjev-failure", { reason: result.reason, latencyMs: result.latencyMs });
            continue;
          }

          if (result.usage) {
            stats.openjevInputTokens += Number(result.usage.input_tokens) || 0;
            stats.openjevOutputTokens += Number(result.usage.output_tokens) || 0;
          }

          for (const entry of batch.items) {
            const answer = result.answers[entry.questionId];
            if (!answer) continue;
            const judgement = interpretAnswer(answer, config);
            judgements.set(entry.questionId, judgement);
            // Only a confident judgement is cached; a keep-by-uncertainty is
            // cheap to recompute later when the context has moved on.
            if (judgement.action === "drop") {
              cache.set(entry.item.digest, judgement);
            }
          }
        }
      }
    }

    // ---- Combine + veto ------------------------------------------------------
    const prefixEnd = protectedPrefixEnd(items);
    const vetContext = buildVetContext(items, {
      prefixEnd,
      keepRecentItems: config.keepRecentItems,
      writeTime,
      priorDigests: options.priorDigests,
    });
    const decisions = resolveDecisions({ items, verdicts, cached, judgements, questionByItem, vetContext });

    let tokensAfter = 0;
    let dropped = 0;
    let wouldDrop = 0;
    for (const decision of decisions) {
      if (decision.action === "drop") {
        // In shadow mode the decision is recorded but never applied.
        if (mode === "active") {
          dropped += 1;
          continue;
        }
        wouldDrop += 1;
      }
      tokensAfter += decision.tokens;
    }

    stats.dropped = dropped;
    stats.wouldDrop = wouldDrop;
    stats.kept = items.length - dropped;
    stats.tokensAfter = tokensAfter;
    stats.modelCallsAffected = dropped > 0 || wouldDrop > 0 ? 1 : 0;

    // Only a pass that actually omitted content counts as token savings.
    if (mode === "active") {
      stats.estimatedMainTokensAvoided = Math.max(0, tokensBefore - tokensAfter);
    }

    plan.decisions = decisions;
    plan.tokensAfter = mode === "active" ? tokensAfter : tokensBefore;
    plan.stats.tokensAfter = plan.tokensAfter;
    lastPlan = plan;
    return plan;
  }

  /** Applies a prepared pass: returns the items that survive into the next model call. */
  function apply(pass, mode = config.mode) {
    if (mode !== "active") return pass.items.slice();
    const droppedIds = new Set(
      pass.decisions.filter((decision) => decision.action === "drop").map((decision) => decision.id),
    );
    return pass.items.filter((item) => !droppedIds.has(item.id));
  }

  /** Full pass: plan + apply, with metrics recorded. */
  async function run(rawItems, options = {}) {
    // NB: the local must not be named `plan` — that would shadow the `plan()`
    // function declared above and put it in the temporal dead zone.
    const pass = await plan(rawItems, options);
    const survivors = apply(pass, options.mode || config.mode);
    // Per-pass deltas only, so cumulative cache totals are never double-counted.
    metrics.recordPass(pass.stats);
    // Persist newly learned judgements. `save()` is a no-op unless something
    // changed, so a call that learned nothing performs no disk I/O.
    cache.save();
    return { items: survivors, plan: pass, stats: pass.stats };
  }

  /**
   * Background classification. Resolves judgements for items that were kept
   * only because their judgement was not ready yet, so the *next* call can drop
   * them without paying latency on the critical path.
   *
   * Never throws; never blocks the caller (the caller must not await it on the
   * critical path).
   */
  async function prewarm(rawItems, options = {}) {
    if (!config.background || !config.usable) return { classified: 0, skipped: true };
    try {
      const scope = options.scope || "default";
      const items = rawItems.map((raw, index) =>
        makeItem(raw, { scope, policyVersion: config.policyVersion, index }),
      );
      let verdicts;
      if (options.writeTime) {
        // Same rule set the blocking write-time path uses, so a warm cache
        // filled in shadow mode produces exactly the decisions active mode
        // would have applied.
        const priorDigests = options.priorDigests instanceof Map ? options.priorDigests : null;
        const countsByDigest = priorDigests ? new Map(priorDigests) : new Map();
        for (const item of items) countsByDigest.set(item.digest, (countsByDigest.get(item.digest) || 0) + 1);
        verdicts = items.map((item) => classifyWriteTimeItem(item, { countsByDigest }));
      } else {
        verdicts = classifyAll(items, { keepRecentItems: config.keepRecentItems }).verdicts;
      }

      const pending = [];
      for (let index = 0; index < items.length; index += 1) {
        if (verdicts[index].action !== "ask") continue;
        const item = items[index];
        if (cache.get(item.digest)) continue;
        const redaction = redact(item.text);
        if (mustNotTransmit(redaction, { failClosed: config.redactFailClosed })) {
          item.flags.secretFailClosed = true;
          continue;
        }
        pending.push({
          item,
          questionId: questionId("item", index),
          redactedText: redaction.text,
          tokens: item.tokens,
        });
      }
      if (pending.length === 0) return { classified: 0, skipped: false };

      const batches = buildBatches(pending, { taskText: safeTaskText(options.taskText), config });
      let classified = 0;
      let wouldDrop = 0;
      let droppedTokens = 0;
      let openjevCalls = 0;
      let openjevInputTokens = 0;
      let openjevLatencyTotalMs = 0;
      let failures = 0;
      for (const batch of batches) {
        const result = await client.classify({ state: batch.state, questions: batch.questions });
        openjevCalls += 1;
        openjevLatencyTotalMs += result.latencyMs || 0;
        if (!result.ok) {
          failures += 1;
          continue;
        }
        if (result.usage) openjevInputTokens += Number(result.usage.input_tokens) || 0;
        for (const entry of batch.items) {
          const answer = result.answers[entry.questionId];
          if (!answer) continue;
          const judgement = interpretAnswer(answer, config);
          if (judgement.action === "drop") {
            cache.set(entry.item.digest, judgement);
            classified += 1;
            if (options.mode !== "active") {
              wouldDrop += 1;
              droppedTokens += entry.item.tokens || 0;
            }
          }
        }
      }
      cache.save();
      // Background work still has to be visible in `jev-prune stats`, otherwise
      // shadow mode on a hook-only host would look like it did nothing at all.
      metrics.record({
        toolResultsEvaluated: pending.length,
        cacheMisses: pending.length,
        openjevCalls,
        openjevInputTokens,
        openjevLatencyTotalMs,
        openjevLatencySamples: openjevCalls,
        apiFailureCount: failures,
        fallbackCount: failures,
        itemsWouldDrop: wouldDrop,
        shadowEvaluations: options.mode === "active" ? 0 : 1,
      });
      metrics.save();
      return { classified, wouldDrop, droppedTokens, skipped: false };
    } catch (error) {
      // Background work must never surface as a host failure.
      logger("prewarm-failed", { detail: String(error && error.message ? error.message : error).slice(0, 200) });
      return { classified: 0, error: true };
    }
  }

  function keepDecision(item, reason) {
    return {
      id: item.id,
      index: item.position,
      position: item.position,
      action: "keep",
      reason,
      source: "rule",
      confidence: 0,
      dropProbability: 0,
      tokens: item.tokens,
    };
  }

  return {
    config,
    settings,
    cache,
    metrics,
    client,
    plan,
    apply,
    run,
    prewarm,
    get lastPlan() {
      return lastPlan;
    },
    saveState() {
      const cacheResult = cache.save();
      metrics.save();
      return cacheResult;
    },
  };
}

export { containsFailure };
