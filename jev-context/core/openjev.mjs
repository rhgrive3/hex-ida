/**
 * OpenJEV client — the only place in the system that talks to the network.
 *
 * Endpoint contract (verified against the live service):
 *   POST {baseUrl}/v1/systemone
 *   Authorization: Bearer <OPENJEV_API_KEY>
 *   body:     { model, state, questions: { id: { type:"choice"|"score"|"noul", ... } } }
 *   response: { answers: { id: { type, choice, probabilities, confidence } }, usage: {...} }
 *
 * Every failure mode — timeout, 401, 422, 503, DNS, TLS, malformed JSON, an
 * answer set that does not match the questions — resolves to `{ ok: false }`.
 * The caller then prunes nothing. OpenJEV can never stop the host agent from
 * working; the worst case is that the context is sent unpruned.
 */

/** Errors are sanitised before they reach a caller: an exception must never echo the key. */
function sanitizeError(error) {
  const message = error && error.message ? String(error.message) : String(error);
  return message.replace(/oj_(?:live|test)\.[A-Za-z0-9._-]+/g, "[REDACTED:openjev-key]").slice(0, 400);
}

export function createOpenJevClient(config, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;

  /**
   * Sends one batch of questions about one state.
   * Never throws. Never logs the key.
   */
  async function classify({ state, questions, signal }) {
    if (!config.apiKey) {
      return { ok: false, reason: "missing-api-key", latencyMs: 0 };
    }
    if (typeof fetchImpl !== "function") {
      return { ok: false, reason: "no-fetch-implementation", latencyMs: 0 };
    }
    const questionIds = Object.keys(questions || {});
    if (questionIds.length === 0) return { ok: true, answers: {}, usage: null, latencyMs: 0 };

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    let timedOut = false;
    const timeoutGuard = setTimeout(() => {
      timedOut = true;
    }, config.timeoutMs);

    try {
      const response = await fetchImpl(`${config.baseUrl}${config.endpointPath}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ model: config.model, state, questions }),
        signal: controller.signal,
      });

      const latencyMs = Date.now() - started;

      if (!response.ok) {
        // Body is read but never surfaced verbatim (it can echo request content).
        return { ok: false, reason: `http-${response.status}`, status: response.status, latencyMs };
      }

      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        return { ok: false, reason: "malformed-json", latencyMs };
      }

      if (!payload || typeof payload !== "object" || !payload.answers || typeof payload.answers !== "object") {
        return { ok: false, reason: "malformed-response", latencyMs };
      }

      const answers = {};
      for (const id of questionIds) {
        const answer = payload.answers[id];
        if (answer && typeof answer === "object") answers[id] = answer;
      }

      // A response that answered nothing is treated as a failure, not as "keep
      // nothing" — silently dropping every item would be the worst outcome.
      if (Object.keys(answers).length === 0) {
        return { ok: false, reason: "no-answers", latencyMs };
      }

      return {
        ok: true,
        answers,
        usage: payload.usage && typeof payload.usage === "object" ? payload.usage : null,
        latencyMs,
      };
    } catch (error) {
      const latencyMs = Date.now() - started;
      const aborted = timedOut || (error && error.name === "AbortError");
      return {
        ok: false,
        reason: aborted ? "timeout" : "network-error",
        detail: sanitizeError(error),
        latencyMs,
      };
    } finally {
      clearTimeout(timer);
      clearTimeout(timeoutGuard);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  /** Cheap liveness/shape check used by `jev-prune status` and `--probe`. */
  async function probe() {
    return classify({
      state: "item_0001 [tool=shell] a single trivial tool result used only to verify connectivity.",
      questions: {
        item_0001_keep: {
          type: "choice",
          instructions: "Must this content be preserved verbatim to continue the current task?",
          criteria: { keep: "still needed", drop: "stale, duplicated or verbose" },
        },
      },
    });
  }

  return { classify, probe };
}

/**
 * Interprets one OpenJEV answer under the configured thresholds.
 *
 * Conservative by construction: DROP requires the response to positively choose
 * `drop`, the drop probability to clear `dropProbability`, the confidence to
 * clear `minConfidence`, and no missing fields. Anything else is KEEP.
 */
export function interpretAnswer(answer, config) {
  if (!answer || typeof answer !== "object") {
    return { action: "keep", reason: "no-answer", confidence: 0, dropProbability: 0 };
  }
  const probabilities = answer.probabilities && typeof answer.probabilities === "object" ? answer.probabilities : {};
  const dropProbability = Number(probabilities.drop);
  const keepProbability = Number(probabilities.keep);
  const confidence = Number(answer.confidence);

  if (!Number.isFinite(dropProbability) || !Number.isFinite(confidence)) {
    return { action: "keep", reason: "unusable-answer-shape", confidence: 0, dropProbability: 0 };
  }
  if (answer.choice !== "drop") {
    return { action: "keep", reason: "model-chose-keep", confidence, dropProbability };
  }
  if (dropProbability < config.dropProbability) {
    return { action: "keep", reason: "below-drop-probability-threshold", confidence, dropProbability };
  }
  if (confidence < config.minConfidence) {
    return { action: "keep", reason: "below-min-confidence", confidence, dropProbability };
  }
  if (Number.isFinite(keepProbability) && keepProbability > dropProbability) {
    return { action: "keep", reason: "keep-probability-dominates", confidence, dropProbability };
  }
  return { action: "drop", reason: "confident-drop", confidence, dropProbability };
}
