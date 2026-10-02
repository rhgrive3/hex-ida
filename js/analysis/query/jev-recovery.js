// Semantic retrieval over already-proven release function identities. Remote
// choices may direct existing Fast analysis; they cannot prove a field/owner.
import { demangleCxx } from '../../rtti.js';

export function createJevRecoveryClient({ apiKey, fetchImpl = fetch } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 4096) return null;
  return Object.freeze({ async call({ query, choices, signal, requestPolicy = 'legacy' }) {
    const response = await fetchImpl('https://api.openjev.sh/v1/systemone', {
      method: 'POST', headers: { authorization: `Bearer ${apiKey.trim()}`, 'content-type': 'application/json' },
      body: JSON.stringify(jevRecoveryRequest(query, choices, { requestPolicy })), signal,
    });
    return response.ok ? response.json() : null;
  } });
}

const COMPACT_POLICY = 'compact-accessor-v5';
function compactDescription(row) {
  const method = row.symbolName ? demangleCxx(row.symbolName) ?? row.symbolName : row.methodName || 'unnamed';
  return `class: ${String(row.className).slice(0, 160)} | method: ${String(method).slice(0, 160)}`.replace(/\s+/g, ' ');
}

export function jevRecoveryRequest(query, choices, { requestPolicy = 'legacy' } = {}) {
  if (!['legacy', COMPACT_POLICY].includes(requestPolicy)) throw new Error('unknown Jev retrieval request policy');
  if (requestPolicy === COMPACT_POLICY) {
    if (!Array.isArray(choices) || choices.length > 254) throw new Error('compact retrieval requires at most254 functions');
    const criteria = Object.fromEntries(choices.map((row, index) => [`c${index}`, compactDescription(row)]));
    criteria.none = 'No listed method provides meaningful evidence for the requested stored value on the primary object.';
    return { model: 'openjev', state: { userPhrase: query, queryKind: 'release-function-retrieval' }, questions: {
      pick: { type: 'choice', instructions: 'Identify the primary object and its requested stored value separately from incidental actions and related objects. Choose a listed method only when its class and method together provide meaningful evidence for that value. Prefer a value accessor. Choose none when the descriptions do not distinguish a suitable method. Names are release-binary context, not source field names. This choice directs analysis only and proves no binary fact.', criteria },
    } };
  }
  const criteria = Object.fromEntries(choices.map((row, index) => [`c${index}`,
    `class: ${row.className.slice(0, 240)} | release method: ${String(row.symbolName
      ? demangleCxx(row.symbolName) ?? row.symbolName : row.methodName || 'unnamed').slice(0, 240)}
      | address: 0x${row.address.toString(16)} | receiver evidence: ${row.proof}`.replace(/\s+/g, ' ')]));
  return { model: 'openjev', state: { userPhrase: query, queryKind: 'release-function-retrieval' }, questions: {
    object: { type: 'choice', instructions: 'Identify the primary object whose stored state the user asks about. Choose an existing method belonging to that object. Related objects and incidental actions in the question are weaker cues. Method names are release-binary context, not source field names.', criteria },
    pick: { type: 'choice', instructions: 'Choose an existing method most likely to access the requested stored value on the primary object. Prefer a value accessor to a helper that only matches an incidental action. This choice directs analysis only; it proves no binary fact.', criteria },
  } };
}

export async function selectJevRecoveryPlan(query, planner, options = {}) {
  const fallback = () => ({ plan: planner.plan(query, { maxFunctions: options.maxFunctions ?? 8 }),
    source: 'hex', selectedAddress: null, selectedClass: null });
  let controller, timer, abort;
  try {
    if (options.enabled !== true || typeof options.client?.call !== 'function'
      || typeof options.isCurrent !== 'function' || options.isCurrent() !== true
      || options.signal?.aborted || typeof query !== 'string' || query.length > 2048) return fallback();
    const requestPolicy = options.requestPolicy ?? 'legacy';
    if (!['legacy', COMPACT_POLICY].includes(requestPolicy)) return fallback();
    let choices = planner.choices(query, { maxChoices: requestPolicy === COMPACT_POLICY ? 254 : 255 });
    if (requestPolicy === COMPACT_POLICY) {
      const bound = options.maxDeclaredSizeBytes;
      if (bound != null && (!Number.isSafeInteger(bound) || bound < 4 || bound > 16384)) return fallback();
      if (bound != null) choices = choices.filter(row => typeof row.declaredSizeBytes === 'bigint'
        && row.declaredSizeBytes > 0n && row.declaredSizeBytes <= BigInt(bound));
      // Addresses are not semantic descriptions. Duplicate visible method
      // identities cannot be resolved by the model, including truncation
      // collisions. Exclude every colliding entry rather than picking one.
      const counts = new Map();
      for (const row of choices) { const label = compactDescription(row); counts.set(label, (counts.get(label) ?? 0) + 1); }
      choices = choices.filter(row => counts.get(compactDescription(row)) === 1);
    }
    if (choices.length < 2) return fallback();
    const timeoutMs = options.timeoutMs ?? 15000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) return fallback();
    controller = new AbortController();
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('recovery-selection-timeout')); }, timeoutMs);
      abort = () => { controller.abort(); reject(new Error('recovery-selection-cancelled')); };
      options.signal?.addEventListener('abort', abort, { once: true });
    });
    const payload = await Promise.race([Promise.resolve().then(() => options.client.call({ query,
      choices, requestPolicy, body: jevRecoveryRequest(query, choices, { requestPolicy }), signal: controller.signal })), deadline]);
    if (options.isCurrent() !== true || options.signal?.aborted || payload?.model !== 'openjev') return fallback();
    const compact = requestPolicy === COMPACT_POLICY;
    const indexes = (compact ? ['pick'] : ['object', 'pick']).map(question => {
      const answer = payload?.answers?.[question];
      if (answer?.type !== 'choice' || !(compact && answer.choice === 'none')
        && !/^c(?:0|[1-9]\d*)$/.test(answer.choice ?? '')) return null;
      const index = answer.choice === 'none' ? -1 : Number(answer.choice.slice(1));
      const unit = number => typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= 1;
      if (!Number.isSafeInteger(index) || index >= choices.length || !unit(answer.confidence)
        || !unit(answer.probabilities?.[answer.choice])) return null;
      for (const [key, probability] of Object.entries(answer.probabilities))
        if (!(compact && key === 'none') && (!/^c(?:0|[1-9]\d*)$/.test(key)
          || Number(key.slice(1)) >= choices.length) || !unit(probability)) return null;
      return index;
    });
    if (indexes.some(index => index === null || index < 0)) return fallback();
    const object = choices[indexes[0]], selected = choices[indexes[compact ? 0 : 1]];
    if (!compact && object.className !== selected.className) return fallback();
    return { plan: planner.planOwner(query, selected.className, { maxFunctions: options.maxFunctions ?? 8,
      firstAddress: selected.address }), source: 'jev-retrieval', selectedAddress: selected.address,
      selectedClass: selected.className };
  } catch (_) { return fallback(); }
  finally {
    clearTimeout(timer);
    if (abort) options.signal?.removeEventListener('abort', abort);
  }
}
