/*
 * query/planner.js â€” AnalysisQuery -> bounded whole-program semantic search.
 *
 * Candidate generation uses cheap source-isolated pools. Expensive Semantic IR
 * is built lazily only for a quota-merged shortlist, leaving turn resources for
 * later LLM refinement and deterministic verification.
 */
import { compileGoal } from '../goalc.js';
import { FACT } from '../semantic.js';
import { createAgentTools } from '../agent/tools.js';

const POOL_ORDER = Object.freeze(['lexical', 'string', 'graph', 'recognition', 'runtime', 'semantic', 'exploration']);
const POOL_SHARE = Object.freeze({ lexical: 0.29, string: 0.17, graph: 0.21, recognition: 0.17, runtime: 0.06, semantic: 0.06, exploration: 0.04 });

function asAddr(v) {
  if (typeof v === 'bigint') return v >= 0n ? v : null;
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
  if (typeof v === 'string') {
    const text = v.trim();
    if (/^(?:0[xX][0-9a-fA-F]+|\d+)$/.test(text)) return BigInt(text);
  }
  return null;
}
function lower(v) { return String(v == null ? '' : v).toLowerCase(); }
function resultAddress(row) {
  if (!row) return null;
  for (const k of ['function', 'functionAddress', 'addr', 'address', 'start']) {
    const a = asAddr(row[k]); if (a != null) return a;
  }
  return null;
}
function explicitFunctionAddress(row) {
  if (!row) return null;
  let a = asAddr(row.functionAddress); if (a != null) return a;
  if (row.function && typeof row.function === 'object') a = asAddr(row.function.address ?? row.function.addr ?? row.function.start);
  else a = asAddr(row.function);
  return a;
}
function newCandidate(addr) {
  return {
    address: addr, score: 0, sources: [], terms: new Set(), semantic: null, verification: null,
    scoreComponents: { lexicalScore: 0, semanticScore: 0, graphScore: 0, evidenceScore: 0, runtimeScore: 0 },
    sourcePoolScores: {}, coverageSum: 0, coverageWeight: 0,
  };
}
function poolMap(pools, name) {
  if (!pools[name]) pools[name] = new Map();
  return pools[name];
}
function sourceComponent(pool) {
  if (pool === 'graph') return 'graphScore';
  if (pool === 'runtime') return 'runtimeScore';
  if (pool === 'semantic') return 'semanticScore';
  return 'lexicalScore';
}
const STAGED_PENDING = Symbol('planner-staged-pending');
const PROBATION_PENDING = Symbol('planner-probation-pending');

function stagedPool(map) {
  if (!map[STAGED_PENDING]) map[STAGED_PENDING] = new Map();
  return map[STAGED_PENDING];
}

function probationPool(map) {
  if (!map[PROBATION_PENDING]) map[PROBATION_PENDING] = new Map();
  return map[PROBATION_PENDING];
}

function worstEntry(map) {
  let worstKey = null;
  let worstScore = Infinity;
  for (const [candidateKey, candidate] of map) {
    if (candidate.score < worstScore) { worstScore = candidate.score; worstKey = candidateKey; }
  }
  return { worstKey, worstScore };
}

function addCandidate(pools, pool, address, source, term, weight, coverage = 1, cap = Infinity) {
  const addr = asAddr(address);
  if (addr == null) return;
  const map = poolMap(pools, pool);
  const staged = stagedPool(map);
  const probation = probationPool(map);
  const key = addr.toString();
  const quality = Number.isFinite(Number(coverage)) ? Math.max(0.2, Math.min(1, Number(coverage))) : 0.7;
  const amount = (weight || 0) * quality;
  let c = map.get(key);
  let pending = null;
  let pendingBucket = null;
  let pendingMarker = null;

  if (!c) {
    c = staged.get(key);
    if (c) {
      pending = c;
      pendingBucket = staged;
      pendingMarker = STAGED_PENDING;
    }
  }
  if (!c) {
    c = probation.get(key);
    if (c) {
      pending = c;
      pendingBucket = probation;
      pendingMarker = PROBATION_PENDING;
    }
  }
  if (!c) {
    if (map.size < cap) {
      c = newCandidate(addr);
      map.set(key, c);
    } else if (staged.size < cap) {
      // Retain a bounded overflow candidate so later evidence for the same
      // address can be aggregated even when each increment is below the
      // weakest stored score (#5910).
      c = newCandidate(addr);
      c[STAGED_PENDING] = true;
      staged.set(key, c);
      pending = c;
      pendingBucket = staged;
      pendingMarker = STAGED_PENDING;
    } else if (probation.size < cap) {
      // A second bounded overflow tier prevents a newly observed candidate
      // from displacing a stronger staged candidate merely because the
      // staged tier is full. Both tiers are bounded by the same pool cap.
      c = newCandidate(addr);
      c[PROBATION_PENDING] = true;
      probation.set(key, c);
      pending = c;
      pendingBucket = probation;
      pendingMarker = PROBATION_PENDING;
    } else {
      // This is a bounded heavy-hitter fallback: once both overflow tiers are
      // full, do not evict a stronger pending aggregate for a weaker single
      // arrival. A candidate can still accumulate while retained.
      const weakestProbation = worstEntry(probation);
      if (weakestProbation.worstKey == null || amount <= weakestProbation.worstScore) return;
      probation.delete(weakestProbation.worstKey);
      c = newCandidate(addr);
      c[PROBATION_PENDING] = true;
      probation.set(key, c);
      pending = c;
      pendingBucket = probation;
      pendingMarker = PROBATION_PENDING;
    }
  }

  c.score += amount;
  c.scoreComponents[sourceComponent(pool)] += amount;
  c.sourcePoolScores[pool] = (c.sourcePoolScores[pool] || 0) + amount;
  if (source != null) c.sources.push(source);
  if (term) c.terms.add(term);
  c.coverageSum += quality * Math.max(1, Math.abs(weight || 1));
  c.coverageWeight += Math.max(1, Math.abs(weight || 1));

  if (pending && pendingBucket) {
    const weakestStored = worstEntry(map);
    if (weakestStored.worstKey != null && c.score > weakestStored.worstScore) {
      map.delete(weakestStored.worstKey);
      pendingBucket.delete(key);
      delete c[pendingMarker];
      map.set(key, c);
    }
  }
}

function mergeCandidateInto(target, source) {

  target.score += source.score;
  for (const key of Object.keys(target.scoreComponents)) target.scoreComponents[key] += source.scoreComponents[key] || 0;
  for (const [pool, value] of Object.entries(source.sourcePoolScores || {})) target.sourcePoolScores[pool] = (target.sourcePoolScores[pool] || 0) + value;
  target.sources.push(...source.sources);
  for (const term of source.terms) target.terms.add(term);
  target.coverageSum += source.coverageSum || 0;
  target.coverageWeight += source.coverageWeight || 0;
  return target;
}
function mergedCandidates(pools) {
  const merged = new Map();
  for (const pool of POOL_ORDER) {
    for (const c of poolMap(pools, pool).values()) {
      const key = c.address.toString();
      const target = merged.get(key) || newCandidate(c.address);
      if (!merged.has(key)) merged.set(key, target);
      mergeCandidateInto(target, c);
    }
  }
  return merged;
}
function desiredFactKinds(query) {
  const a = query && query.action;
  if (a === 'increase') return new Set([FACT.RMW, FACT.INCREMENT, FACT.WRITE, FACT.CLAMP]);
  if (a === 'decrease') return new Set([FACT.RMW, FACT.DECREMENT, FACT.WRITE, FACT.CLAMP]);
  if (a === 'set') return new Set([FACT.WRITE]);
  if (a === 'save') return new Set([FACT.WRITE, FACT.TRANSFER, FACT.RMW]);
  if (a === 'read') return new Set([FACT.READ, FACT.RETURN]);
  if (a === 'decide' || a === 'check' || a === 'detect') return new Set([FACT.BRANCH, FACT.THRESHOLD, FACT.ZERO_NULL]);
  if (a === 'send') return ne²È="24°É•…Í½¹ÌèÉÉ…ä¹™É½´¡¹•ÜM•Ð¡Œ¹Í½ÕÉ•Ì¤¤°Í½ÕÉ•ÌèÉÉ…ä¹™É½´¡¹•ÜM•Ð¡Œ¹Í½ÕÉ•Ì¤¤°(€€€Í•µ…¹Ñ¥…ÑÌèŒ¹Í•µ…¹Ñ¥Œñðmt°Í•µ…¹Ñ¥½µÁ±•Ñ•¹•ÍÌèŒ¹Í•µ…¹Ñ¥½µÁ±•Ñ•¹•ÍÌñð¹Õ±°°ÍÕµµ…ÉäèŒ¹ÍÕµµ…Éäñð¹Õ±°°(€€€Ù•É¥™¥…Ñ¥½¸èŒ¹Ù•É¥™¥…Ñ¥½¸ñð¹Õ±°°Ñ¡É•Í¡½±‘Ù¥‘•¹”èŒ¹Ñ¡É•Í¡½±‘Ù¥‘•¹”ñð¹Õ±°°•Ù¥‘•¹”èÉÉ…ä¹™É½´¡Œ¹•Ù¥‘•¹”ñðmt¤°(€€€½µÁ±•Ñ”è½µÁ±•Ñ•¹•ÍÌ€ü½µÁ±•Ñ•¹•ÍÌ¹½µÁ±•Ñ”€ôôôÑÉÕ”€èÑÉÕ”°‰Õ‘•Ñ1¥µ¥Ñ•è½µÁ±•Ñ•¹•ÍÌ€ü½µÁ±•Ñ•¹•ÍÌ¹‰Õ‘•Ñ1¥µ¥Ñ•€ôôôÑÉÕ”€è™…±Í”°(€ôì)ô)™Õ¹Ñ¥½¸Õ…É‘•‘½¹Ñ•áÐ¡Ñà°ˆ¤ì(€¥˜€¡ÑåÁ•½˜Ñà¹…¹…±åé”€„ôô€™Õ¹Ñ¥½¸œ¤É•ÑÕÉ¸Ñàì(€É•ÑÕÉ¸ì(€€€€¸¸¹Ñà°(€€€…¹…±åé”è…Íå¹Œ€ ¸¸¹…ÉÌ¤€ôøì(€€€€€¥˜€¡•áÁ¥É•¡ˆ¤¤Ñ¡É½Ü…‰½ÉÑÉÉ½È¡ˆ¤ì(€€€€€¥˜€¡ˆ¹…¹…±åé•‘%¹ÍÑÉÕÑ¥½¹Ì€øôˆ¹µ…á¥Í…ÍÍ•µ‰±ä¤ìˆ¹‘¥Í…ÍÍ•µ‰±åá¡…ÕÍÑ•€ôÑÉÕ”ìÑ¡É½Ü=‰©•Ð¹…ÍÍ¥¸¡¹•ÜÉÉ½È ‘¥Í…ÍÍ•µ‰±äµ‰Õ‘•Ðœ¤°ì½‘”è‘¥Í…ÍÍ•µ‰±äµ‰Õ‘•Ðœô¤ìô(€€€€€½¹ÍÐµ½‘•°€ô…Ý…¥Ð…Ý…¥Ñ	Õ‘•Ð¡Ñà¹…¹…±åé” ¸¸¹…ÉÌ¤°ˆ¤ì(€€€€€¥˜€¡•áÁ¥É•¡ˆ¤¤Ñ¡É½Ü…‰½ÉÑÉÉ½È¡ˆ¤ì(€€€€€½¹ÍÐ½ÍÐ€ô5…Ñ ¹µ…à À°ÉÉ…ä¹¥ÍÉÉ…ä¡µ½‘•°€˜˜µ½‘•°¹¥¹ÍÑÉÕÑ¥½¹Ì¤€üµ½‘•°¹¥¹ÍÑÉÕÑ¥½¹Ì¹±•¹Ñ €è€À¤ì(€€€€€¥˜€¡ˆ¹…¹…±åé•‘%¹ÍÑÉÕÑ¥½¹Ì€¬½ÍÐ€øˆ¹µ…á¥Í…ÍÍ•µ‰±ä¤ìˆ¹‘¥Í…ÍÍ•µ‰±åá¡…ÕÍÑ•€ôÑÉÕ”ìÑ¡É½Ü=‰©•Ð¹…ÍÍ¥¸¡¹•ÜÉÉ½È ‘¥Í…ÍÍ•µ‰±äµ‰Õ‘•Ðœ¤°ì½‘”è‘¥Í…ÍÍ•µ‰±äµ‰Õ‘•Ðœô¤ìô(€€€€€ˆ¹…¹…±åé•‘%¹ÍÑÉÕÑ¥½¹Ì€¬ô½ÍÐì(€€€€€É•ÑÕÉ¸µ½‘•°ì(€€€ô°(€ôì)ô)™Õ¹Ñ¥½¸…É•…Ñ•M•…É¡½Ù•É…”¡É•Á½ÉÑÌ¤ì(€¥˜€ …É•Á½ÉÑÌ¹±•¹Ñ ¤É•ÑÕÉ¸ì½µÁ±•Ñ”èÑÉÕ”°½Ù•É…”è€Ä°É•…Í½¸è¹Õ±°°É•Á½ÉÑÌèmtôì(€½¹ÍÐ½Ù•É…”€ôÉ•Á½ÉÑÌ¹É•‘Õ” ¡ÍÕ´°É•Á½ÉÐ¤€ôøÍÕ´€¬É•Á½ÉÐ¹½Ù•É…”°€À¤€¼É•Á½ÉÑÌ¹±•¹Ñ ì(€½¹ÍÐ¥¹½µÁ±•Ñ”€ôÉ•Á½ÉÑÌ¹™¥±Ñ•È ¡É•Á½ÉÐ¤€ôø€…É•Á½ÉÐ¹½µÁ±•Ñ”¤ì(€É•ÑÕÉ¸ì½µÁ±•Ñ”è¥¹½µÁ±•Ñ”¹±•¹Ñ €ôôô€À°½Ù•É…”°É•…Í½¸è¥¹½µÁ±•Ñ•lÁtü¹É•…Í½¸ñð¹Õ±°°É•Á½ÉÑÌôì)ô)•áÁ½ÉÐ…Íå¹Œ™Õ¹Ñ¥½¸Á±…¹¹…±åÍ¥Í½…°¡½…±=ÉEÕ•Éä°½¹Ñ•áÐ°½ÁÑÌ¤ì(€½¹ÍÐÅÕ•Éä€ôÑåÁ•½˜½…±=ÉEÕ•Éä€ôôô€ÍÑÉ¥¹œœ€ü½µÁ¥±•½…°¡½…±=ÉEÕ•Éä¤€è½…±=ÉEÕ•Éäì(€½¹ÍÐÑà€ô½¹Ñ•áÐñðíôì(€½¹ÍÐˆ€ô‰Õ‘•ÑMÑ…Ñ”¡½ÁÑÌ¤ì(€ÑÉäì(€€€½¹ÍÐÑ½½±Ì€ô½ÁÑÌ€˜˜½ÁÑÌ¹Ñ½½±ÌñðÉ•…Ñ••¹ÑQ½½±Ì¡Õ…É‘•‘½¹Ñ•áÐ¡Ñà°ˆ¤°ìµ…áÕ¹Ñ¥½¹Ìèˆ¹µ…áÕ¹Ñ¥½¹Ì°µ…á¥Í…ÍÍ•µ‰±äèˆ¹µ…á¥Í…ÍÍ•µ‰±äô¤ì(€€€¥˜€ …ÅÕ•Éä¤É•ÑÕÉ¸ìÅÕ•Éäè¹Õ±°°…¹‘¥‘…Ñ•Ìèmt°‰•ÍÐè¹Õ±°°•Ù¥‘•¹”èmt°µ¥ÍÍ¥¹Ù¥‘•¹”èlÅÕ•Éät°•¹¥¹”è€‘•Ñ•Éµ¥¹¥ÍÑ¥Œµ½…°µÁ±…¹¹•Èœôì(€€€±•ÐÁ½½±Ì€ô=‰©•Ð¹™É½µ¹ÑÉ¥•Ì¡A==1}=IH¹µ…À ¡¹…µ”¤€ôøm¹…µ”°¹•Ü5…À ¥t¤¤ì(€€€±•ÐÉ…¹­•€ômtì(€€€±•Ð‰•ÍÐ€ô¹Õ±°ì(€€€ÑÉäì(€€€€€Á½½±Ì€ô…Ý…¥Ð…¹‘¥‘…Ñ•A½½±Ì¡ÅÕ•Éä°Ñ½½±Ì°Ñà°ˆ¤ì(€€€€€¥˜€ …•áÁ¥É•¡ˆ¤¤…Ý…¥Ð•áÁ…¹‘…±±9•¥¡‰½É¡½½¡Á½½±Ì°Ñ½½±Ì°ˆ¤ì(€€€€€É…¹­•€ô…Ý…¥Ð…¹…±åé•…¹‘¥‘…Ñ•Ì¡ÅÕ•Éä°Á½½±Ì°Ñ½½±Ì°ˆ¤ì(€€€€€‰•ÍÐ€ô…Ý…¥ÐÙ•É¥™å	•ÍÐ¡ÅÕ•Éä°É…¹­•°Ñ½½±Ì°ˆ¤ì(€€€ô…Ñ €¡•ÉÉ½È¤ì(€€€€€½¹ÍÐ½‘”€ôMÑÉ¥¹œ¡•ÉÉ½È€˜˜€¡•ÉÉ½È¹½‘”ñð•ÉÉ½È¹µ•ÍÍ…”¤ñð€œœ¤ì(€€€€€¥˜€¡½‘”€„ôô€Ñ¥µ•½ÕÐœ€˜˜½‘”€„ôô€…¹•±±•œ€˜˜½‘”€„ôô€Ñ½½°µ…±°µ‰Õ‘•Ðœ¤Ñ¡É½Ü•ÉÉ½Èì(€€€ô(€€€É…¹­•€ôÉ…¹­•¹Í½ÉÐ ¡„°ˆÈ¤€ôøˆÈ¹Í½É”€´„¹Í½É”¤ì(€€€¥˜€¡‰•ÍÐ¤‰•ÍÐ€ôÉ…¹­•¹™¥¹ ¡à¤€ôøà¹…‘‘É•ÍÌ€ôôô‰•ÍÐ¹…‘‘É•ÍÌ¤ñð‰•ÍÐì(€€€½¹ÍÐ•Ù¥‘•¹”€ô¹•ÜM•Ð ¤ì(€€€¥˜€¡‰•ÍÐ¤™½È€¡½¹ÍÐ”½˜‰•ÍÐ¹•Ù¥‘•¹”ñðmt¤•Ù¥‘•¹”¹…‘¡”¤ì(€€€¥˜€¡‰•ÍÐü¹Ù•É¥™¥…Ñ¥½¸ü¹•Ù¥‘•¹”¤™½È€¡½¹ÍÐ”½˜‰•ÍÐ¹Ù•É¥™¥…Ñ¥½¸¹•Ù¥‘•¹”¤•Ù¥‘•¹”¹…‘¡”¤ì(€€€½¹ÍÐµ¥ÍÍ¥¹Ù¥‘•¹”€ômtì(€€€¥˜€ …‰•ÍÐ¤µ¥ÍÍ¥¹Ù¥‘•¹”¹ÁÕÍ  ¹¼µ…¹‘¥‘…Ñ”µ™Õ¹Ñ¥½¸œ¤ì(€€€•±Í”¥˜€ …‰•ÍÐ¹Ù•É¥™¥…Ñ¥½¸¤µ¥ÍÍ¥¹Ù¥‘•¹”¹ÁÕÍ  ¹¼µÉÕ¹Ñ¥µ”µ½Èµ…ÕÍ…°µÙ•É¥™¥…Ñ¥½¸œ¤ì(€€€¥˜€¡ˆ¹‘¥Í…ÍÍ•µ‰±åá¡…ÕÍÑ•¤µ¥ÍÍ¥¹Ù¥‘•¹”¹ÁÕÍ  ‘¥Í…ÍÍ•µ‰±äµ‰Õ‘•Ðœ¤ì(€€€¥˜€¡ˆ¹™Õ¹Ñ¥½¹á¡…ÕÍÑ•¤µ¥ÍÍ¥¹Ù¥‘•¹”¹ÁÕÍ  ™Õ¹Ñ¥½¸µ‰Õ‘•Ðœ¤ì(€€€¥˜€¡ˆ¹Í¡½ÉÑ±¥ÍÑ1¥µ¥Ñ•¤µ¥ÍÍ¥¹Ù¥‘•¹”¹ÁÕÍ  Á±…¹¹•ÈµÍ¡½ÉÑ±¥ÍÐµ±¥µ¥Ðœ¤ì(€€€¥˜€¡ˆ¹Í½ÕÉ•A½½±QÉÕ¹…Ñ•¤µ¥ÍÍ¥¹Ù¥‘•¹”¹ÁÕÍ  …¹‘¥‘…Ñ”µÍ½ÕÉ”µ±¥µ¥Ðœ¤ì(€€€¥˜€¡ˆ¹Í•…É¡%¹½µÁ±•Ñ”¤µ¥ÍÍ¥¹Ù¥‘•¹”¹ÁÕÍ  Í•…É µ¥¹½µÁ±•Ñ”œ¤ì(€€€¥˜€¡ˆ¹Õ¹…½Õ¹Ñ•‘Q½½±½ÍÐ¤µ¥ÍÍ¥¹Ù¥‘•¹”¹ÁÕÍ  Õ¹…½Õ¹Ñ•µÑ½½°µ½ÍÐœ¤ì(€€€¥˜€¡Ñ½½±…±±	Õ‘•Ñá¡…ÕÍÑ•¡ˆ¤¤µ¥ÍÍ¥¹Ù¥‘•¹”¹ÁÕÍ  Ñ½½°µ…±°µ‰Õ‘•Ðœ¤ì(€€€¥˜€¡Ñ¥µ•‘=ÕÐ¡ˆ¤¤µ¥ÍÍ¥¹Ù¥‘•¹”¹ÁÕÍ  Ñ¥µ•½ÕÐœ¤ì(€€€¥˜€¡…¹•±±•¡ˆ¤¤µ¥ÍÍ¥¹Ù¥‘•¹”¹ÁÕÍ  …¹•±±•œ¤ì(€€€¥˜€¡ÅÕ•Éä¹½¹™¥‘•¹Ð€ôôô™…±Í”¤µ¥ÍÍ¥¹Ù¥‘•¹”¹ÁÕÍ  ¸¸¸¡ÅÕ•Éä¹µ¥ÍÍ¥¹œñðmt¤¤ì(€€€½¹ÍÐÍ•…É €ô…É•…Ñ•M•…É¡½Ù•É…”¡ˆ¹Í•…É¡I•Á½ÉÑÌ¤ì(€€€½¹ÍÐÍ½ÕÉ•½µÁ±•Ñ•¹•ÍÍ%¹™¼€ôˆ¹Í½ÕÉ•½µÁ±•Ñ•¹•ÍÌñðÍ½ÕÉ•½µÁ±•Ñ•¹•ÍÌ¡Á½½±Ì°ˆ¤ì(€€€½¹ÍÐ¥¹½µÁ±•Ñ”€ô•áÁ¥É•¡ˆ¤ñðˆ¹Í¡½ÉÑ±¥ÍÑ1¥µ¥Ñ•ñðˆ¹Í½ÕÉ•A½½±QÉÕ¹…Ñ•ñðˆ¹Í•…É¡%¹½µÁ±•Ñ”ì(€€€½¹ÍÐ‰Õ‘•Ñ1¥µ¥Ñ•€ôˆ¹‘¥Í…ÍÍ•µ‰±åá¡…ÕÍÑ•ñðˆ¹™Õ¹Ñ¥½¹á¡…ÕÍÑ•ñðÑ½½±…±±	Õ‘•Ñá¡…ÕÍÑ•¡ˆ¤ì(€€€½¹ÍÐ…±°€ôµ•É•‘…¹‘¥‘…Ñ•Ì¡Á½½±Ì¤ì(€€€½¹ÍÐ…¹‘¥‘…Ñ•½Õ¹Ð€ô…±°¹Í¥é”ì(€€€½¹ÍÐ…¹…±åé•‘½Õ¹Ð€ôÉ…¹­•¹±•¹Ñ ì(€€€½¹ÍÐÍÑ½É•‘…¹‘¥‘…Ñ•½Ù•É…”€ô…¹‘¥‘…Ñ•½Õ¹Ð€ôôô€À€ü€Ä€è5…Ñ ¹µ¥¸ Ä°…¹…±åé•‘½Õ¹Ð€¼…¹‘¥‘…Ñ•½Õ¹Ð¤ì(€€€½¹ÍÐ…¹‘¥‘…Ñ•½Ù•É…”€ôÍÑ½É•‘…¹‘¥‘…Ñ•½Ù•É…”€¨Í•…É ¹½Ù•É…”€¨Í½ÕÉ•½µÁ±•Ñ•¹•ÍÍ%¹™¼¹½Ù•É…”ì(€€€½¹ÍÐÉ•…Í½¸€ôÑ½½±…±±	Õ‘•Ñá¡…ÕÍÑ•¡ˆ¤€ü€Ñ½½°µ…±°µ‰Õ‘•Ðœ(€€€€€€èˆ¹™Õ¹Ñ¥½¹á¡…ÕÍÑ•€ü€™Õ¹Ñ¥½¸µ‰Õ‘•Ðœ(€€€€€€èˆ¹‘¥Í…ÍÍ•µ‰±åá¡…ÕÍÑ•€ü€‘¥Í…ÍÍ•µ‰±äµ‰Õ‘•Ðœ(€€€€€€€€èÑ¥µ•‘=ÕÐ¡ˆ¤€ü€Ñ¥µ•½ÕÐœ(€€€€€€€€€€è…¹•±±•¡ˆ¤€ü€…¹•±±•œ(€€€€€€€€€€€€èˆ¹Í½ÕÉ•A½½±QÉÕ¹…Ñ•€ü€…¹‘¥‘…Ñ”µÍ½ÕÉ”µ±¥µ¥Ðœ(€€€€€€€€€€€€€€èˆ¹Í¡½ÉÑ±¥ÍÑ1¥µ¥Ñ•€ü€Á±…¹¹•ÈµÍ¡½ÉÑ±¥ÍÐµ±¥µ¥Ðœ(€€€€€€€€€€€€€€€€èˆ¹Í•…É¡%¹½µÁ±•Ñ”€ü€¡Í•…É ¹É•…Í½¸ñð€Í•…É µ¥¹½µÁ±•Ñ”œ¤€è¹Õ±°ì(€€€½¹ÍÐ½µÁ±•Ñ•¹•ÍÌ€ôì(€€€€€½µÁ±•Ñ”è€…¥¹½µÁ±•Ñ”°Á…ÉÑ¥…°è¥¹½µÁ±•Ñ”°‰Õ‘•Ñ1¥µ¥Ñ•°É•…Í½¸°…¹‘¥‘…Ñ•½Ù•É…”°(€€€€€ÍÑ½É•‘…¹‘¥‘…Ñ•½Ù•É…”°…¹‘¥‘…Ñ•M½ÕÉ•½Ù•É…”èÍ½ÕÉ•½µÁ±•Ñ•¹•ÍÍ%¹™¼¹½Ù•É…”°(€€€€€Í•…É¡½Ù•É…”èÍ•…É ¹½Ù•É…”°Í•…É¡½µÁ±•Ñ”èÍ•…É ¹½µÁ±•Ñ”°(€€€€€…¹…±åé•‘Õ¹Ñ¥½¹Ìè…¹…±åé•‘½Õ¹Ð°…¹‘¥‘…Ñ•Õ¹Ñ¥½¹Ìè…¹‘¥‘…Ñ•½Õ¹Ð°Õ¹…¹…±åé•‘Õ¹Ñ¥½¹Ìè5…Ñ ¹µ…à À°…¹‘¥‘…Ñ•½Õ¹Ð€´…¹…±åé•‘½Õ¹Ð¤°(€€€ôì(€€€É•ÑÕÉ¸ì(€€€€€ÅÕ•Éä°(€€€€€…¹‘¥‘…Ñ•ÌèÉ…¹­•¹Í±¥” À°5…Ñ ¹µ¥¸ ÈÀ°ˆ¹µ…áÕ¹Ñ¥½¹Ì¤¤¹µ…À ¡Œ¤€ôøÁÕ‰±¥…¹‘¥‘…Ñ”¡Œ°½µÁ±•Ñ•¹•ÍÌ¤¤°(€€€€€‰•ÍÐèÁÕ‰±¥…¹‘¥‘…Ñ”¡‰•ÍÐ°½µÁ±•Ñ•¹•ÍÌ¤°•Ù¥‘•¹”èÉÉ…ä¹™É½´¡•Ù¥‘•¹”¤°µ¥ÍÍ¥¹Ù¥‘•¹”èÉÉ…ä¹™É½´¡¹•ÜM•Ð¡µ¥ÍÍ¥¹Ù¥‘•¹”¤¤°(€€€€€•á¡…ÕÍÑ•è‰Õ‘•Ñ1¥µ¥Ñ•ñðÑ¥µ•‘=ÕÐ¡ˆ¤ñð…¹•±±•¡ˆ¤°Á…ÉÑ¥…°è¥¹½µÁ±•Ñ”°½µÁ±•Ñ•¹•ÍÌ°(€€€€€É•™¥¹•µ•¹ÑÙ…¥±…‰±”è€…‰Õ‘•Ñ1¥µ¥Ñ•€˜˜€¡ˆ¹É•Í•ÉÙ•‘Õ¹Ñ¥½¹Ì€ø€Àñðˆ¹É•Í•ÉÙ•‘¥Í…ÍÍ•µ‰±ä€ø€À¤°(€€€€€…¹‘¥‘…Ñ•M½ÕÉ•Ìèì(€€€€€€€ÅÕ½Ñ…Ìèˆ¹ÅÕ½Ñ…ÌñðÅÕ½Ñ…½Õ¹ÑÌ¡Á½½±Ì°ˆ¹µ…áÕ¹Ñ¥½¹Ì¤°ÍÑ½É•è=‰©•Ð¹™É½µ¹ÑÉ¥•Ì¡A==1}=IH¹µ…À ¡Á½½°¤€ôømÁ½½°°Á½½±ÍmÁ½½±t¹Í¥é•t¤¤°ÍÕÁÁ±¥•èì€¸¸¹ˆ¹Í½ÕÉ•Q½Ñ…±Ìô°(€€€€€€€€¼¼ÍÑ½É•€¬ÍÑ…•€¬ÁÉ½‰…Ñ¥½¸ìÍ½ÕÉ”É½ÝÌ…É”½¹ÍÕµ•¥¹É•µ•¹Ñ…±±ä¸(€€€€€€€É•Ñ…¥¹•‘	½Õ¹è=‰©•Ð¹™É½µ¹ÑÉ¥•Ì¡A==1}=IH¹µ…À ¡Á½½°¤€ôømÁ½½°°Í½ÕÉ•A½½±…À¡ˆ°Á½½°¤€¨€Ít¤¤°(€€€€€€€½µÁ±•Ñ•¹•ÍÌèÍ½ÕÉ•½µÁ±•Ñ•¹•ÍÍ%¹™¼°(€€€€€ô°(€€€€€‰Õ‘•Ðèì(€€€€€€€É•ÅÕ•ÍÑ•èì™Õ¹Ñ¥½¹Ìèˆ¹É•ÅÕ•ÍÑ•‘5…áÕ¹Ñ¥½¹Ì°‘¥Í…ÍÍ•µ‰±äèˆ¹É•ÅÕ•ÍÑ•‘5…á¥Í…ÍÍ•µ‰±äô°(€€€€€€€Á±…¹¹•Èèì™Õ¹Ñ¥½¹Ìèˆ¹µ…áÕ¹Ñ¥½¹Ì°‘¥Í…ÍÍ•µ‰±äèˆ¹µ…á¥Í…ÍÍ•µ‰±äô°(€€€€€€€É•Í•ÉÙ•èì™Õ¹Ñ¥½¹Ìèˆ¹É•Í•ÉÙ•‘Õ¹Ñ¥½¹Ì°‘¥Í…ÍÍ•µ‰±äèˆ¹É•Í•ÉÙ•‘¥Í…ÍÍ•µ‰±äô°(€€€€€ô°(€€€€€Í•…É¡½µÁ±•Ñ•¹•ÍÌèÍ•…É °(€€€€€ÍÑ…ÑÌèì(€€€€€€€…¹…±åé•‘Õ¹Ñ¥½¹Ìè…¹…±åé•‘½Õ¹Ð°…¹‘¥‘…Ñ•Õ¹Ñ¥½¹Ìè…¹‘¥‘…Ñ•½Õ¹Ð°Õ¹…¹…±åé•‘Õ¹Ñ¥½¹Ìè5…Ñ ¹µ…à À°…¹‘¥‘…Ñ•½Õ¹Ð€´…¹…±åé•‘½Õ¹Ð¤°(€€€€€€€‘¥Í…ÍÍ•µ‰±äèˆ¹…¹…±åé•‘%¹ÍÑÉÕÑ¥½¹Ì°Ñ½½±…±±Ìèˆ¹Ñ½½±…±±	Õ‘•Ð¹ÕÍ•°•±…ÁÍ•‘5Ìè…Ñ”¹¹½Ü ¤€´ˆ¹ÍÑ…ÉÑ•°(€€€€€€€Á±…¹¹•ÉÕ¹Ñ¥½¹	Õ‘•Ðèˆ¹µ…áÕ¹Ñ¥½¹Ì°É•ÅÕ•ÍÑ•‘Õ¹Ñ¥½¹	Õ‘•Ðèˆ¹É•ÅÕ•ÍÑ•‘5…áÕ¹Ñ¥½¹Ì°(€€€€€€€Á±…¹¹•É¥Í…ÍÍ•µ‰±å	Õ‘•Ðèˆ¹µ…á¥Í…ÍÍ•µ‰±ä°É•ÅÕ•ÍÑ•‘¥Í…ÍÍ•µ‰±å	Õ‘•Ðèˆ¹É•ÅÕ•ÍÑ•‘5…á¥Í…ÍÍ•µ‰±ä°(€€€€€ô°(€€€€€•¹¥¹”è€‘•Ñ•Éµ¥¹¥ÍÑ¥Œµ½…°µÁ±…¹¹•Èœ°(€€€ôì(€ô™¥¹…±±äì‘¥ÍÁ½Í•	Õ‘•Ð¡ˆ¤ìô)ô)•áÁ½ÉÐ½¹ÍÐÉÕ¹½…±A±…¹¹•È€ôÁ±…¹¹…±åÍ¥Í½…°ì(