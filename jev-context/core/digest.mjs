import { createHash } from "node:crypto";

/**
 * Stable content identity.
 *
 * Every judgement the engine makes is keyed by a digest of the *exact* content
 * it was made about. If a tool result changes (a file is re-read, a command is
 * re-run), its digest changes and the previous judgement is not reused. This is
 * what keeps the decision cache from ever applying a stale verdict to new text.
 */
export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Normalises content for hashing without changing what is transmitted.
 *
 * Only semantically irrelevant differences are erased: CRLF vs LF and trailing
 * whitespace. Interior bytes, ordering and formatting are preserved so that
 * "same digest" really does mean "same content".
 */
export function normalizeContent(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

/**
 * Builds the cache key for one context item.
 *
 * Scope is the session/task identity and `policyVersion` is the question
 * semantics, so a judgement only transfers between calls when the content, the
 * tool, the task scope and the policy all match.
 */
export function decisionDigest({ content, tool, scope, policyVersion }) {
  return sha256(
    [policyVersion || "", tool || "", scope || "", normalizeContent(content)].join("\u0000"),
  );
}

/** Builds the cache key for a whole batch (used to dedupe identical batches). */
export function batchDigest(digests) {
  return sha256([...digests].sort().join("\u0000"));
}

/** Deterministic, question-safe id. Question ids must survive any provider key charset. */
export function questionId(prefix, index) {
  return `${prefix}_${String(index).padStart(4, "0")}`;
}
