import { requestBody, sha256 } from './jev-realgame-final-contract.mjs';

export function validateChoice(payload, count) {
  if (payload?.model !== 'openjev') return 'model-mismatch';
  const pick = payload?.answers?.pick;
  const unique = payload?.answers?.unique;
  if (pick?.type !== 'choice' || !/^c(?:0|[1-9]\d*)$/.test(pick.choice ?? '')) return 'malformed-choice';
  const index = Number(pick.choice.slice(1));
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) return 'invalid-candidate';
  const unit = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
  if (!unit(pick.confidence) || !pick.probabilities || !unit(pick.probabilities[pick.choice])) return 'missing-probability';
  for (const [key, value] of Object.entries(pick.probabilities)) {
    if (!/^c(?:0|[1-9]\d*)$/.test(key) || Number(key.slice(1)) >= count || !unit(value)) return 'invalid-probability';
  }
  if (unique?.type !== 'noul' || !unit(unique.noul)) return 'malformed-unique';
  return null;
}

export class RealGameJevClient {
  constructor({ apiKey, arm, fetchImpl = fetch, timeoutMs = 15000, maxAttempts = 2, requestBuilder = requestBody }) {
    Object.assign(this, { apiKey, arm, fetchImpl, timeoutMs, maxAttempts, requestBuilder });
    this.calls = [];
  }
  async call({ query, candidates }) {
    const body = this.requestBuilder(query, candidates, this.arm);
    const attempts = [];
    const started = performance.now();
    let responsePayload = null;
    for (let number = 1; number <= this.maxAttempts; number++) {
      const start = performance.now();
      let status = null, error = null;
      try {
        const response = await this.fetchImpl('https://api.openjev.sh/v1/systemone', {
          method: 'POST', headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs),
        });
        status = response.status;
        if (!response.ok) error = `http-${status}`;
        else {
          try { responsePayload = await response.json(); } catch { error = 'invalid-json'; }
          if (!error) error = validateChoice(responsePayload, candidates.length);
        }
      } catch (e) { error = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : 'network'; }
      attempts.push({ number, status, error, latencyMs: performance.now() - start });
      if (!error) break;
      if (!(error === 'timeout' || error === 'network' || status === 429 || status >= 500)) break;
    }
    const error = attempts.at(-1).error;
    const choiceIndex = error ? null : Number(responsePayload.answers.pick.choice.slice(1));
    const audit = { arm: this.arm, query, bodyHash: sha256(JSON.stringify(body)), criteria: body.questions.pick.criteria,
      attempts, error, addedLatencyMs: performance.now() - started, choiceIndex,
      selectedKey: choiceIndex == null ? null : candidates[choiceIndex].key,
      response: responsePayload };
    this.calls.push(audit);
    // Invalid responses never reach the production preference router.
    return error ? null : { selectedKey: audit.selectedKey, choiceIndex,
      confidence: responsePayload.answers.pick.confidence,
      preference: responsePayload.answers.pick.probabilities[responsePayload.answers.pick.choice],
      unique: responsePayload.answers.unique.noul };
  }
}
