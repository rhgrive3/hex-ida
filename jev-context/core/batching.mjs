import { estimateTokens } from "./tokens.mjs";

/**
 * Batching — turns "these items are ambiguous" into a small number of OpenJEV
 * calls whose state stays inside a token budget.
 *
 * Two budgets are enforced together:
 *   - `maxQuestionsPerCall`: OpenJEV answers every question against the same
 *     state in parallel, so one call can carry many judgements — but not
 *     unboundedly many.
 *   - `maxStateTokens`: the state is the only world the model sees, so its size
 *     is capped. We never re-send the whole conversation; only the items under
 *     question plus a short task header.
 */

function prefixWithinBudget(text, budgetTokens) {
  if (budgetTokens <= 0 || !text) return "";
  if (estimateTokens(text) <= budgetTokens) return text;
  let low = 0, high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, mid)) <= budgetTokens) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low);
}

function suffixWithinBudget(text, budgetTokens) {
  if (budgetTokens <= 0 || !text) return "";
  if (estimateTokens(text) <= budgetTokens) return text;
  let low = 0, high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(text.length - mid)) <= budgetTokens) low = mid;
    else high = mid - 1;
  }
  return text.slice(text.length - low);
}

/** Head/tail excerpt so a single huge tool result cannot blow the state budget. */
export function excerpt(text, budgetTokens) {
  const body = String(text ?? "");
  const budget = Math.max(0, Math.floor(Number(budgetTokens) || 0));
  if (budget === 0) return "";
  if (estimateTokens(body) <= budget) return body;

  const marker = "\n\n...[content omitted to fit OpenJEV state budget]...\n\n";
  const markerTokens = estimateTokens(marker);
  if (markerTokens >= budget) return prefixWithinBudget(body, budget);

  const available = budget - markerTokens;
  const headBudget = Math.floor(available * 0.7);
  const tailBudget = available - headBudget;
  const head = prefixWithinBudget(body, headBudget);
  const tail = suffixWithinBudget(body, tailBudget);
  const result = `${head}${marker}${tail}`;

  // The estimator is the authority for the configured budget. Keep this final
  // guard even though the pieces were budgeted independently.
  return estimateTokens(result) <= budget ? result : prefixWithinBudget(result, budget);
}

const KEEP_INSTRUCTIONS =
  "In the context of the current task below, must the concrete content of this tool result be " +
  "preserved verbatim in the next LLM call?";

const KEEP_CRITERIA = {
  keep: "Its concrete content is still needed for future reasoning, editing, verification or constraint compliance.",
  drop: "It is stale, an exact or near duplicate, already superseded by later information, a resolved issue, or merely a verbose log.",
};

/**
 * Priority for whom to ask about first when the budget is tight: large items
 * that are recent score highest (most savings, least risk of asking about
 * something the model has already moved past).
 */
function priority(candidate, index, total) {
  const recency = total <= 1 ? 1 : (index + 1) / total; // 1 = newest
  return candidate.tokens * (0.35 + 0.65 * recency);
}

/**
 * Selects and formats the items to ask OpenJEV about.
 *
 * @returns {{ batches: Array<{state: string, questions: object, items: Array}>, skipped: Array }}
 */
export function buildBatches(candidates, options) {
  const { taskText = "", config } = options;
  const tasksTokens = estimateTokens(taskText);

  // Per-item excerpt budget: leave room for the task header, the fixed items
  // heading, and per-item metadata. The final assembly below rechecks the exact
  // estimated state size, so this is only a fair-share target.
  const maxStateTokens = Math.max(1, Math.floor(config.maxStateTokens));
  const headerBudget = Math.min(tasksTokens, Math.max(1, Math.floor(maxStateTokens * 0.3)));

  const ranked = candidates
    .map((candidate, index) => ({ candidate, score: priority(candidate, index, candidates.length) }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.candidate);

  const batches = [];

  const header = taskText
    ? `CURRENT TASK (authoritative, do not question it):\n${excerpt(taskText, headerBudget)}`
    : "CURRENT TASK: (not supplied)";
  const itemsHeading = "ITEMS UNDER JUDGEMENT (one question per item id):";
  const baseStateTokens = estimateTokens(`${header}\n\n${itemsHeading}\n\n`);
  if (baseStateTokens >= maxStateTokens) return [];
  const separatorTokens = estimateTokens("\n\n");
  const fairShareCount = Math.max(1, Math.min(candidates.length, Math.floor(config.maxQuestionsPerCall) || 1));
  const fairShareBudget = Math.max(1, Math.floor(Math.max(1, maxStateTokens - baseStateTokens) / fairShareCount));

  const freshBatch = () => ({ items: [], stateTokens: baseStateTokens });
  // ESM is always strict mode: an undeclared assignment here threw
  // "current is not defined" on every batching call, which disabled the whole
  // pruning engine instead of batching items. Declare the accumulator.
  let current = freshBatch();

  for (const candidate of ranked) {
    const headerLine = `--- ${candidate.questionId} [tool=${candidate.item.tool || "unknown"}${
      candidate.item.meta && candidate.item.meta.group ? `, group=${candidate.item.meta.group}` : ""
    }, ~${candidate.tokens} tokens] ${candidate.note || ""}`;
    const headerLineTokens = estimateTokens(`${headerLine}\n`);
    let separator = current.items.length > 0 ? separatorTokens : 0;
    let excerptBudget = Math.max(0, Math.min(
      fairShareBudget,
      maxStateTokens - current.stateTokens - separator - headerLineTokens,
    ));
    let excerptText = excerpt(candidate.redactedText, excerptBudget);
    let block = `${headerLine}\n${excerptText}`;
    let blockTokens = estimateTokens(block);

    const wouldExceedQuestions = current.items.length >= config.maxQuestionsPerCall;
    const wouldExceedState = current.stateTokens + blockTokens > maxStateTokens;

    if ((wouldExceedQuestions || wouldExceedState) && current.items.length > 0) {
      batches.push(current);
      current = freshBatch();
      separator = 0;
      excerptBudget = Math.max(0, Math.min(
        fairShareBudget,
        maxStateTokens - current.stateTokens - headerLineTokens,
      ));
      excerptText = excerpt(candidate.redactedText, excerptBudget);
      block = `${headerLine}\n${excerptText}`;
      blockTokens = estimateTokens(block);
    }

    // A pathological configuration can make the metadata itself larger than the
    // requested state budget. Never respond by sending an unbounded body: the
    // content portion is reduced to the remaining budget (possibly empty).
    if (current.stateTokens + separator + blockTokens > maxStateTokens) {
      excerptBudget = Math.max(0, maxStateTokens - current.stateTokens - separator - headerLineTokens);
      excerptText = excerpt(candidate.redactedText, excerptBudget);
      block = `${headerLine}\n${excerptText}`;
      blockTokens = estimateTokens(block);
    }

    // If even the item metadata cannot fit, leave this candidate unasked. The
    // pipeline treats missing judgements as KEEP, which is safer than violating
    // the network state budget.
    if (current.stateTokens + separator + blockTokens > maxStateTokens) continue;

    current.items.push({ ...candidate, block });
    current.stateTokens += separator + blockTokens;
  }
  if (current.items.length > 0) batches.push(current);

  return batches.map((batch) => {
    const questions = {};
    for (const entry of batch.items) {
      questions[entry.questionId] = {
        type: "choice",
        instructions: KEEP_INSTRUCTIONS,
        criteria: KEEP_CRITERIA,
      };
    }
    const state = `${header}\n\n${itemsHeading}\n\n${batch.items
      .map((entry) => entry.block)
      .join("\n\n")}`;
    return { state, questions, items: batch.items };
  });
}
