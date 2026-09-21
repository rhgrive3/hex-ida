import {
  PROTECTED_ROLES,
  SUPERSEDABLE_GROUPS,
  WRITE_TIME_DROPPABLE_GROUPS,
  containsFailure,
  isProtectedNewest,
} from "./classifier.mjs";

/**
 * Pruning policy — combines Stage 1 verdicts with cached/OpenJEV judgements and
 * then re-checks every safety invariant.
 *
 * The invariant re-check is not redundancy. A cached decision can be replayed
 * against a context whose shape has changed (the "newest snapshot" moved, a
 * failure appeared), so the final gate re-validates every drop against the
 * current context. Anything that fails the gate is silently promoted to a keep.
 */

/** A drop is only allowed for aged tool output. This is the outermost invariant. */
export function isDroppable(item) {
  return item.role === "tool";
}

/**
 * Final validation of a proposed drop against the *current* context.
 * Returns a keep-reason string when the drop must be refused, or null to allow.
 */
export function vetDrop(item, context) {
  if (context && context.writeTime) return vetWriteTimeDrop(item);
  if (!isDroppable(item)) return "only tool output may be dropped";
  if (context.prefixEnd !== undefined && item.position < context.prefixEnd) {
    return "inside the stable prompt prefix";
  }
  if (item.flags && item.flags.secretFailClosed) {
    return "likely credential that could not be safely redacted";
  }
  if (item.flags && item.flags.containsUserConstraint) return "carries a user constraint";
  if (item.flags && (item.flags.isCurrentEdit || item.flags.isLatestDiff)) {
    return "current edit or latest diff";
  }
  if (context.recentIds && context.recentIds.has(item.id)) return "within the recent working window";
  if (
    context.newestIdByResource &&
    isProtectedNewest(item, {
      newestIdByResource: context.newestIdByResource,
      countsByResource: context.countsByResource || new Map(),
    })
  ) {
    return "newest snapshot for its resource";
  }
  // Only guard the surviving copy of *duplicated* content. A unique item is not
  // "the last copy" of anything in a meaningful sense, and vetoing every unique
  // item would make the engine incapable of pruning at all.
  if (
    context.newestIdByDigest &&
    context.countsByDigest &&
    (context.countsByDigest.get(item.digest) || 0) > 1 &&
    context.newestIdByDigest.get(item.digest) === item.id
  ) {
    return "last surviving copy of this content";
  }
  // An unresolved failure that no later success has resolved must survive.
  if (containsFailure(item.text || "")) {
    const resolved = isResolvedByLaterSuccess(item, context);
    if (!resolved) return "unresolved failure still relevant";
  }
  return null;
}

function vetWriteTimeDrop(item) {
  if (item.role !== "tool") return "only tool output may be dropped";
  if (item.flags && item.flags.secretFailClosed) {
    return "likely credential that could not be safely redacted";
  }
  if (item.flags && item.flags.containsUserConstraint) return "carries a user constraint";
  if (item.flags && (item.flags.isCurrentEdit || item.flags.isLatestDiff)) {
    return "current edit or latest diff";
  }
  const group = (item.meta && item.meta.group) || "other";
  if (!WRITE_TIME_DROPPABLE_GROUPS.has(group) && group !== "install") {
    return `fresh ${group} output is current state`;
  }
  // Losing an unresolved failure is the one mistake that is never worth the
  // tokens, at any age.
  if (containsFailure(item.text || "")) return "unresolved failure still relevant";
  return null;
}

function isResolvedByLaterSuccess(item, context) {
  const resourceKey = item.meta && item.meta.resourceKey;
  if (!resourceKey || !context.itemsById) return false;
  const newerIds = context.idsByResourceNewerThan && context.idsByResourceNewerThan.get(item.id);
  if (!newerIds) return false;
  for (const id of newerIds) {
    const newer = context.itemsById.get(id);
    if (!newer) continue;
    const group = (newer.meta && newer.meta.group) || "other";
    if (!SUPERSEDABLE_GROUPS.has(group)) continue;
    const text = newer.text || "";
    if (!containsFailure(text) && /\bexit code 0\b|\bexit=0\b|\bpassed\b|\bPASS\b|\bok\b/i.test(text)) return true;
  }
  return false;
}

/** Builds the id-indexed context the final gate needs. */
export function buildVetContext(items, { prefixEnd, keepRecentItems, writeTime = false }) {
  const newestIdByResource = new Map();
  const newestIdByDigest = new Map();
  const countsByResource = new Map();
  const countsByDigest = new Map();
  const itemsById = new Map();
  const idsByResourceNewerThan = new Map();

  items.forEach((item) => {
    itemsById.set(item.id, item);
    newestIdByDigest.set(item.digest, item.id);
    countsByDigest.set(item.digest, (countsByDigest.get(item.digest) || 0) + 1);
    const resourceKey = item.meta && item.meta.resourceKey;
    if (resourceKey) {
      newestIdByResource.set(resourceKey, item.id);
      countsByResource.set(resourceKey, (countsByResource.get(resourceKey) || 0) + 1);
    }
  });

  // For each item, which later ids share its resource (used for supersession).
  const seenByResource = new Map();
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    const resourceKey = item.meta && item.meta.resourceKey;
    if (!resourceKey) continue;
    const list = seenByResource.get(resourceKey) || [];
    idsByResourceNewerThan.set(item.id, [...list]);
    list.push(item.id);
    seenByResource.set(resourceKey, list);
  }

  // In write-time mode the recency window is meaningless: the single item under
  // judgement is by definition the newest, and there is no older window to
  // protect. `vetWriteTimeDrop` replaces this guard with an explicit group
  // allow-list, which is the stricter rule of the two.
  const recentIds = writeTime
    ? new Set()
    : new Set(items.slice(Math.max(0, items.length - keepRecentItems)).map((item) => item.id));

  return {
    prefixEnd,
    keepRecentItems,
    writeTime,
    newestIdByResource,
    newestIdByDigest,
    countsByResource,
    countsByDigest,
    itemsById,
    idsByResourceNewerThan,
    recentIds,
  };
}

/**
 * Produces the final decision list.
 *
 * @param {object} input
 * @param {Array} input.items
 * @param {Array} input.verdicts      Stage 1 verdicts (aligned to items)
 * @param {Map}   input.cached        digest -> cached decision
 * @param {Map}   input.judgements    questionId -> interpreted OpenJEV answer
 * @param {Map}   input.questionByItem id -> questionId
 */
export function resolveDecisions({ items, verdicts, cached, judgements, questionByItem, vetContext }) {
  const decisions = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const verdict = verdicts[index];
    let decision = {
      id: item.id,
      index,
      position: item.position,
      action: "keep",
      reason: verdict.reason,
      source: "rule",
      confidence: 0,
      dropProbability: 0,
      tokens: item.tokens,
    };

    if (verdict.action === "drop") {
      decision.action = "drop";
      decision.source = "rule";
    } else if (verdict.action === "ask") {
      const cachedEntry = cached.get(item.digest);
      if (cachedEntry) {
        decision.action = cachedEntry.a === "drop" ? "drop" : "keep";
        decision.source = "cache";
        decision.confidence = cachedEntry.c ?? 0;
        decision.dropProbability = cachedEntry.p ?? 0;
        decision.reason = `cached:${cachedEntry.r || cachedEntry.a}`;
      } else {
        const questionId = questionByItem.get(item.id);
        const judgement = questionId ? judgements.get(questionId) : null;
        if (judgement) {
          decision.action = judgement.action;
          decision.source = "openjev";
          decision.confidence = judgement.confidence;
          decision.dropProbability = judgement.dropProbability;
          decision.reason = judgement.reason;
        } else {
          // No judgement available (OpenJEV disabled, failed, or deferred to
          // the background). Ambiguity resolves to KEEP.
          decision.action = "keep";
          decision.source = "fallback";
          decision.reason = "no judgement available; kept by fail-open";
          decision.pending = true;
        }
      }
    }

    if (decision.action === "drop") {
      const refusal = vetDrop(item, vetContext);
      if (refusal) {
        decision.action = "keep";
        decision.source = `${decision.source}+veto`;
        decision.reason = `veto: ${refusal}`;
      }
    }

    decisions.push(decision);
  }

  return decisions;
}

export { PROTECTED_ROLES };
