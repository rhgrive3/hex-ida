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

/** Head/tail excerpt so a single huge tool result cannot blow the state budget. */
export function excerpt(text, budgetTokens) {
  const body = String(text ?? "");
  if (estimateTokens(body) <= budgetTokens) return body;

  const chars = body.length;
  // Rough char split proportional to the token budget (head-heavy: the head
  // carries the command and the failure, the tail carries the summary line).
  const headChars = Math.floor(chars * 0.7);
  const tailChars = Math.floor(chars * 0.2);
  const omitted = chars - headChars - tailChars;
  const head = body.slice(0, headChars);
  const tail = body.slice(chars - tailChars);
  return `${head}\n\n...[${omitted} characters omitted from the middle of this tool result]...\n\n${tail}`;
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
  const recency = total <= 1 ? 1 : 1 - index / total; // 1 = newest
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

  // Per-item excerpt budget: leave room for the task header and the item headers.
  const headerBudget = Math.min(tasksTokens, Math.floor(config.maxStateTokens * 0.3));
  const perItemBudget = Math.max(
    200,
    Math.floor((config.maxStateTokens - headerBudget) / Math.max(1, Math.min(candidates.length, config.maxQuestionsPerCall))),
  );

  const ranked = candidates
    .map((candidate, index) => ({ candidate, score: priority(candidate, index, candidates.length) }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.candidate);

  const batches = [];
  let current = { items: [], stateTokens: 0 };

  const header = taskText
    ? `CURRENT TASK (authoritative, do not question it):\n${excerpt(taskText, headerBudget)}`
    : "CURRENT TASK: (not supplied)";

  for (const candidate of ranked) {
    const excerptText = excerpt(candidate.redactedText, perItemBudget);
    const headerLine = `--- ${candidate.questionId} [tool=${candidate.item.tool || "unknown"}${
      candidate.item.meta && candidate.item.meta.group ? `, group=${candidate.item.meta.group}` : ""
    }, ~${candidate.tokens} tokens] ${candidate.note || ""}`;
    const block = `${headerLine}\n${excerptText}`;
    const blockTokens = estimateTokens(block);

    const wouldExceedQuestions = current.items.length >= config.maxQuestionsPerCall;
    const wouldExceedState = current.stateTokens + blockTokens > config.maxStateTokens;

    if ((wouldExceedQuestions || wouldExceedState) && current.items.length > 0) {
      batches.push(current);
      current = { items: [], stateTokens: 0 };
    }

    current.items.push({ ...candidate, block });
    current.stateTokens += blockTokens;
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
    const state = `${header}\n\nITEMS UNDER JUDGEMENT (one question per item id):\n\n${batch.items
      .map((entry) => entry.block)
      .join("\n\n")}`;
    return { state, questions, items: batch.items };
  });
}
