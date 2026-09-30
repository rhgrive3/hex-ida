// Optional interactive suggestion. It cannot replace the local result or issue
// binary facts. Only the active binary's branded anonymous C++ fields are sent.
import { adviseWithJev } from '../../pinpoint.js';
import { cxxSemanticViews } from './cxx-semantic-preference.js';
import { cxxQueryTokens } from '../cxx/query-recovery.js';
import { demangleCxx } from '../../rtti.js';

const INSTRUCTION = 'Select only an existing candidate. Identify the main object and requested value in the phrase separately from actions and related helper objects. Prefer evidence for that object and value over an unrelated class with a matching word. Machine use roles and method names are context, not proof of a source field name. A shared method may access several different members. This is a weak ranking preference, never binary proof. Prefer a method that retrieves or changes the requested value over a method that only mentions an action in the question. Constructor and shared-method accesses do not distinguish individual unnamed members. Treat identical context as ambiguous; do not infer a source member name from an offset.';
const bounded = value => String(value).slice(0, 240);

// This pure projection accepts an already validated view; unknown properties
// (including descriptions, source labels, and oracle objects) are ignored.
export function jevAdvisoryRequest(query, views) {
  const tokens = new Set(cxxQueryTokens(query));
  const criteria = Object.fromEntries(views.map((c, index) => {
    const owner = cxxQueryTokens(c.className);
    const contexts = (c.functionContexts ?? []).slice(0, 64).map((ctx, position) => {
      const method = ctx.name ? (demangleCxx(ctx.name) ?? ctx.name).split('(')[0].split('::').at(-1) : '';
      const hits = cxxQueryTokens(method).filter(t => tokens.has(t) && !owner.includes(t)).length;
      return { ctx, position, priority: hits * (ctx.accessRoles?.includes('return-input') ? 2 : 1) };
    }).sort((a, b) => b.priority - a.priority || a.ctx.address.localeCompare(b.ctx.address) || a.position - b.position).slice(0, 8);
    const parts = [`class: ${bounded(c.className)}`, `member: offset 0x${c.offset.toString(16)}`,
      `size: ${Number.isSafeInteger(c.size) && c.size > 0 ? c.size : 'unknown'}`,
      `recovered category: ${bounded(c.recoveredType?.category ?? c.type?.kind ?? 'unknown')}`,
      `type proven: ${c.recoveredType?.proven === true}`, `reads: ${c.readCount ?? 'unknown'}`, `writes: ${c.writeCount ?? 'unknown'}`];
    for (const { ctx } of contexts) parts.push(`release method: ${bounded(ctx.name ? (demangleCxx(ctx.name) ?? ctx.name) : `0x${BigInt(ctx.address).toString(16)}`)}; proven receiver: ${ctx.receiverProven === true}; uses: ${(ctx.accessRoles ?? []).filter(r => ['return-input', 'comparison-input', 'arithmetic-input', 'address-base'].includes(r)).join(', ') || 'unclassified'}`);
    return [`c${index}`, parts.join(' | ')];
  }));
  return { model: 'openjev', state: { userPhrase: query, queryKind: 'partial', candidateDescriptionsAreBinaryDerived: true },
    questions: { pick: { type: 'choice', instructions: INSTRUCTION, criteria },
      unique: { type: 'noul', instructions: 'Does the user phrase uniquely identify one of these candidates without additional context?',
        criteria: { true: 'The phrase distinguishes one field', false: 'Several fields plausibly fit' } } } };
}

export async function requestJevAlternative(query, local, options = {}) {
  const fallback = () => adviseWithJev(query, local);
  try {
  if (options.enabled !== true || options.mode != null && options.mode !== 'partial'
    || typeof options.isCurrent !== 'function' || options.isCurrent() !== true
    || typeof options.apiKey !== 'string' || !options.apiKey.trim() || options.apiKey.length > 4096
    || typeof query !== 'string' || query.length > 2048 || !Array.isArray(local?.candidates)
    || local.candidates.some(c => c.source !== 'cxx' || c.anonymous !== true || c.askedByName)) return fallback();
  } catch (_) { return fallback(); }
  const client = { async call({ query: phrase, candidates, signal }) {
    const contexts = cxxSemanticViews(candidates, options.symbols);
    if (!contexts || contexts.some(c => !c)) return null;
    const views = candidates.map((c, i) => ({ ...contexts[i], offset: c.offset, size: c.size,
      recoveredType: c.recoveredType, type: c.type ?? c.field.type,
      readCount: c.field.readCount, writeCount: c.field.writeCount }));
    const response = await (options.fetchImpl ?? fetch)('https://api.openjev.sh/v1/systemone', {
      method: 'POST', headers: { authorization: `Bearer ${options.apiKey.trim()}`, 'content-type': 'application/json' },
      body: JSON.stringify(jevAdvisoryRequest(phrase, views)), signal,
    });
    if (!response.ok) return null;
    const payload = await response.json(), pick = payload?.answers?.pick, unique = payload?.answers?.unique;
    const unit = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
    if (payload?.model !== 'openjev' || pick?.type !== 'choice' || !/^c(?:0|[1-9]\d*)$/.test(pick.choice ?? '')
      || !unit(pick.confidence) || !unit(pick.probabilities?.[pick.choice]) || unique?.type !== 'noul' || !unit(unique.noul)) return null;
    const index = Number(pick.choice.slice(1));
    if (!Number.isSafeInteger(index) || index >= candidates.length || candidates[index].field.conflict) return null;
    for (const [key, probability] of Object.entries(pick.probabilities))
      if (!/^c(?:0|[1-9]\d*)$/.test(key) || Number(key.slice(1)) >= candidates.length || !unit(probability)) return null;
    return { selectedKey: candidates[index].key, choiceIndex: index };
  } };
  return adviseWithJev(query, local, { enabled: true, mode: 'partial', maxChoices: 255,
    timeoutMs: 15000, signal: options.signal, isCurrent: options.isCurrent, client });
}
