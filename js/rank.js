import { matchText, matchName, numericSymbolRole, isDiagnosticString, normalizeCallableName, symbolMutationKind } from './goals.js';
import { vendorOf, vendorInText, vendorConflicts, classFromSymbol } from './vendors.js';

export const REASON = {
  STRING_REF: 'string-ref', NAME: 'name-match', CALLEE_NAME: 'callee-name', CALLER_NAME: 'caller-name',
  CALLS_MATCH: 'calls-match', CALLED_BY_MATCH: 'called-by-match', NUMERIC: 'numeric', STORE: 'store',
  COMPARE: 'compare', POPULAR: 'popular', SIZE_PENALTY: 'size-penalty', VENDOR: 'vendor', NO_EVIDENCE: 'no-evidence',
};
const POINTS = {
  [REASON.STRING_REF]: 20, [REASON.NAME]: 25, [REASON.CALLEE_NAME]: 12, [REASON.CALLER_NAME]: 10,
  [REASON.CALLS_MATCH]: 8, [REASON.CALLED_BY_MATCH]: 8, [REASON.NUMERIC]: 12, [REASON.STORE]: 8,
  [REASON.COMPARE]: 6, [REASON.POPULAR]: 5, [REASON.SIZE_PENALTY]: -6, [REASON.VENDOR]: -34,
};
const KIND_OF = {
  [REASON.STRING_REF]: 'fact', [REASON.NAME]: 'fact', [REASON.CALLEE_NAME]: 'fact', [REASON.CALLER_NAME]: 'fact',
  [REASON.CALLS_MATCH]: 'inference', [REASON.CALLED_BY_MATCH]: 'inference', [REASON.NUMERIC]: 'fact', [REASON.STORE]: 'fact',
  [REASON.COMPARE]: 'fact', [REASON.POPULAR]: 'fact', [REASON.SIZE_PENALTY]: 'inference', [REASON.VENDOR]: 'fact',
};
const UTF8_ENCODER = typeof TextEncoder === 'function' ? new TextEncoder() : null;

export function reasonKind(code) { return Object.hasOwn(KIND_OF, code) ? KIND_OF[code] : 'inference'; }
export function scoreToConfidence(score) { return score > 0 ? 1 - Math.exp(-score / 45) : 0; }
export function stars(confidence) { return confidence >= 0.85 ? 5 : confidence >= 0.7 ? 4 : confidence >= 0.5 ? 3 : confidence >= 0.3 ? 2 : 1; }

function utf8ByteLength(text) {
  if (typeof text !== 'string' || !text.length) return 0;
  if (UTF8_ENCODER) return UTF8_ENCODER.encode(text).byteLength;
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; i++; }
      else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function compareAddr(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function combinedMatcher(goal) {
  const parts = [];
  for (const re of goal.strong || []) parts.push(re.source);
  for (const re of goal.weak || []) parts.push(re.source);
  for (const term of goal.extraTerms || []) parts.push(term.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!parts.length) return null;
  try { return new RegExp(parts.join('|'), 'i'); } catch { return null; }
}
function vendorOfCandidate(c, learned) {
  if (c.name) {
    const v = vendorOf(classFromSymbol(c.name) || c.name, learned);
    if (v) return { ...v, where: 'name', name: c.name };
  }
  for (const s of c.strings || []) {
    const v = vendorInText(s.text);
    if (v) return { ...v, where: 'string', text: s.text };
  }
  return null;
}

function fairPrefix(values, max) {
  if (values.length <= max) return { values, complete: true };
  /* Keep the strongest half while reserving the other half for stratified tail
     samples. Rank 301+ can therefore seed a candidate without an unbounded xref
     expansion. */
  const head = Math.floor(max / 2);
  const out = values.slice(0, head);
  const tailSlots = max - head;
  const tailSize = values.length - head;
  const seen = new Set(out.map((x) => `${x.addr}:${x.text}`));
  for (let i = 0; i < tailSlots; i++) {
    const index = head + Math.min(tailSize - 1, Math.floor((i + 0.5) * tailSize / tailSlots));
    const item = values[index];
    const key = `${item.addr}:${item.text}`;
    if (!seen.has(key)) { seen.add(key); out.push(item); }
  }
  return { values: out, complete: false };
}

export function rankCandidates({ goal, strings, program, symbols, region, limit = 40, vendors = null }) {
  const notes = [], byAddr = new Map();
  if (!goal) return { candidates: [], matchedStrings: [], notes: ['no-goal'] };
  const resultLimit = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  const hasProgram = !!program;
  if (!hasProgram) notes.push('no-program-index');

  let normalizedRenames = null;
  if (symbols?.renames instanceof Map && symbols.renames.size > 0) {
    normalizedRenames = new Map();
    for (const [rawKey, name] of symbols.renames.entries()) {
      if (typeof rawKey !== 'string' && typeof rawKey !== 'bigint' && typeof rawKey !== 'number') continue;
      if (typeof rawKey === 'string' && !rawKey.trim()) continue;
      if (typeof rawKey === 'number' && (!Number.isSafeInteger(rawKey) || rawKey < 0)) continue;
      let a;
      try {
        a = typeof rawKey === 'bigint' ? rawKey : BigInt(typeof rawKey === 'string' ? rawKey.trim() : rawKey);
        if (a < 0n) continue;
      } catch {
        continue;
      }
      normalizedRenames.set(a.toString(), { addr: a, name });
    }
    if (!normalizedRenames.size) normalizedRenames = null;
  }
  const symbolNameAt = (addr) => {
    if (!symbols || addr == null) return null;
    if (normalizedRenames) {
      const renamed = normalizedRenames.get(addr.toString());
      if (renamed && renamed.name) return renamed.name;
    }
    return typeof symbols.nameAt === 'function' ? (symbols.nameAt(addr) || null) : null;
  };

  const candidate = (addr, site) => {
    if (addr == null) return null;
    const key = addr.toString();
    let c = byAddr.get(key);
    if (!c) {
      c = { addr, name: symbolNameAt(addr), score: 0, reasons: [], strings: [], stats: null, firstSite: site != null ? site : addr };
      byAddr.set(key, c);
    }
    return c;
  };
  const addReason = (c, code, points, detail) => {
    if (!c || !Number.isFinite(points) || points === 0) return;
    c.reasons.push({ code, points: Math.round(points), kind: reasonKind(code), detail: detail || null });
    c.score += points;
  };

  const matcher = combinedMatcher(goal);
  const matchedStrings = [];
  const seenStrings = new Set();
  for (const s of strings || []) {
    if (!s || typeof s.text !== 'string') continue;
    if (matcher && !matcher.test(s.text)) continue;
    const dedupKey = `${s.addr}:${s.text}`;
    if (seenStrings.has(dedupKey)) continue;
    const m = matchText(goal, s.text);
    if (m) {
      seenStrings.add(dedupKey);
      const diagFactor = isDiagnosticString(s.text) ? 0.45 : 1;
      matchedStrings.push({
        addr: s.addr,
        text: s.text,
        score: m.score,
        diagFactor,
        effectiveScore: m.score * diagFactor,
        byteLength: s.byteLength,
        term: m.term,
        region: s.region,
      });
    }
  }
  matchedStrings.sort((a, b) => (
    b.effectiveScore - a.effectiveScore
    || b.diagFactor - a.diagFactor
    || a.text.length - b.text.length
    || compareAddr(a.addr, b.addr)
  ));
  const STRING_EXPANSION_BUDGET = 1200;
  const selectedStrings = hasProgram
    ? fairPrefix(matchedStrings, STRING_EXPANSION_BUDGET)
    : { values: [], complete: true };
  if (!selectedStrings.complete) notes.push(`string-matches-sampled:${selectedStrings.values.length}/${matchedStrings.length}`);
  let referenced = 0;
  for (const ms of selectedStrings.values) {
    if (!hasProgram) break;
    const bytes = Number.isSafeInteger(ms.byteLength) && ms.byteLength > 0
      ? ms.byteLength
      : utf8ByteLength(ms.text);
    const span = BigInt(Math.max(1, Math.min(bytes, 256)));
    const users = program.functionsReferencing(ms.addr, span, 60);
    if (users.length) referenced++;
    for (const u of users) {
      const c = candidate(u.addr != null ? u.addr : u.site, u.site);
      if (!c) continue;
      const nth = c.strings.length;
      const factor = nth === 0 ? 1 : nth === 1 ? 0.6 : nth === 2 ? 0.35 : 0;
      c.strings.push({ addr: ms.addr, text: ms.text, site: u.site, kind: u.kind, users: users.length, score: ms.score, complete: users.complete !== false });
      if (factor > 0) addReason(c, REASON.STRING_REF, POINTS[REASON.STRING_REF] * ms.effectiveScore * factor, {
        text: ms.text, addr: ms.addr, site: u.site, term: ms.term, refKind: u.kind,
        users: users.length, complete: users.complete !== false,
      });
    }
  }
  if (hasProgram && matchedStrings.length && !referenced) notes.push('strings-unreferenced');

  /* Preserve latest-main behaviour: collect all name matches, sort by match
     quality, then cap. An address-order first-400 cap is biased. */
  if (symbols && (symbols.symbolCount > 0 || (symbols.renames?.size > 0))) {
    const lo = region ? region.vmAddr : null, hi = region ? region.vmAddr + region.size : null;
    const resolveCandAddr = (a) => {
      if (!symbols.functionCount) return a;
      if (typeof symbols.functionStartAt === 'function') {
        const start = symbols.functionStartAt(a);
        return start != null ? start : a;
      }
      if (typeof symbols.isFunctionStart === 'function') {
        const start = symbols.isFunctionStart(a) ? a : null;
        return start != null ? start : a;
      }
      return a;
    };
    const goalAction = goal.query?.action || goal.action || null;
    const wantsMutation = !!(
      (goal.expects && goal.expects.store)
      || goalAction === 'increase'
      || goalAction === 'decrease'
      || goalAction === 'set'
    );
    const compareNameMatch = (a, b) => (
      (a.vendorConflict ? 1 : 0) - (b.vendorConflict ? 1 : 0)
      || (a.isVendor ? 1 : 0) - (b.isVendor ? 1 : 0)
      || b.effScore - a.effScore
      || b.roleRank - a.roleRank
      || b.mutatorRank - a.mutatorRank
      || a.leafLen - b.leafLen
      || a.name.length - b.name.length
      || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      || compareAddr(a.candAddr, b.candAddr)
      || compareAddr(a.a, b.a)
    );
    const bestByCand = new Map();
    const considerSymbol = (a, name) => {
      if (!name || typeof name !== 'string') return;
      const normName = normalizeCallableName(name);
      if (matcher && !matcher.test(name) && !(normName && matcher.test(normName))) return;
      const m = matchName(goal, name);
      if (!m) return;
      const role = numericSymbolRole(goal, name);
      const roleRank = role === 'value' ? 2 : role === 'neutral' ? 1 : 0;
      const roleMult = role === 'value' ? 1.6 : role === 'non-value' ? 0.4 : 1;
      const mutInfo = symbolMutationKind(name);
      const mutatorRank = mutInfo.kind === 'mutator' ? 2 : mutInfo.kind === 'const-getter' ? 0 : 1;
      const mutatorMult = (wantsMutation && role !== 'non-value')
        ? (mutInfo.kind === 'mutator' ? 1.15 : mutInfo.kind === 'const-getter' ? 0.95 : 1)
        : 1;
      const effScore = m.score * roleMult * mutatorMult;
      const v = vendorOf(classFromSymbol(name) || name, vendors);
      const isVendor = !!v;
      const vendorConflict = !!(v && vendorConflicts(goal.id, v));
      const leafLen = mutInfo.leafLen || name.length;
      const candAddr = resolveCandAddr(a);
      const candKey = candAddr.toString();
      const entry = {
        a, candAddr, candKey, name, m, role, roleRank, roleMult, mutatorRank, mutatorMult,
        effScore, isVendor, vendorConflict, leafLen,
      };
      const prev = bestByCand.get(candKey);
      if (!prev || compareNameMatch(entry, prev) < 0) bestByCand.set(candKey, entry);
    };

    const seenRenameKeys = normalizedRenames ? new Set() : null;
    const symAddrs = symbols.addrs || [];
    const symNames = symbols.names || [];
    for (let i = 0; i < symAddrs.length; i++) {
      const a = symAddrs[i];
      const key = a.toString();
      let name = symNames[i];
      if (normalizedRenames && normalizedRenames.has(key)) {
        seenRenameKeys.add(key);
        name = normalizedRenames.get(key).name;
      }
      if (lo != null && (a < lo || a >= hi)) continue;
      considerSymbol(a, name);
    }
    if (normalizedRenames) {
      for (const [key, { addr: a, name }] of normalizedRenames.entries()) {
        if (seenRenameKeys.has(key)) continue;
        if (lo != null && (a < lo || a >= hi)) continue;
        considerSymbol(a, name);
      }
    }

    const matches = Array.from(bestByCand.values()).sort(compareNameMatch);
    const kept = [];
    let newMatchCount = 0;
    let capped = false;
    for (const entry of matches) {
      if (byAddr.has(entry.candKey)) {
        kept.push(entry);
      } else if (newMatchCount < 400) {
        kept.push(entry);
        newMatchCount++;
      } else {
        capped = true;
      }
    }
    if (capped) notes.push('name-matches-capped');
    for (const { candAddr, a, name, m, role, roleMult, mutatorMult } of kept) {
      const c = candidate(candAddr, a);
      if (!c) continue;
      c.name = c.name || name;
      addReason(c, REASON.NAME, POINTS[REASON.NAME] * m.score * roleMult * mutatorMult, { name, term: m.term, role });
    }
  }

  const vendorChecked = new Set();
  const applyVendorPenalty = (c) => {
    const key = c.addr.toString();
    if (vendorChecked.has(key)) return;
    vendorChecked.add(key);
    const vendor = vendorOfCandidate(c, vendors);
    if (!vendor) return;
    c.vendor = vendor;
    if (vendorConflicts(goal.id, vendor)) {
      const penalty = vendor.confidence === 'low' ? POINTS[REASON.VENDOR] * 0.45 : POINTS[REASON.VENDOR];
      addReason(c, REASON.VENDOR, penalty, {
        vendor: vendor.vendor, kind: vendor.kind, where: vendor.where,
        name: vendor.name || null, text: vendor.text || null,
      });
    }
  };
  for (const c of byAddr.values()) applyVendorPenalty(c);

  const taintedName = (name) => {
    if (!name) return false;
    const v = vendorOf(classFromSymbol(name) || name, vendors);
    return !!v && vendorConflicts(goal.id, v);
  };
  const tainted = (c) => {
    if (!c) return false;
    const v = vendorOfCandidate(c, vendors);
    return !!v && vendorConflicts(goal.id, v);
  };
  if (hasProgram) {
    const seeds = Array.from(byAddr.values())
      .sort((a, b) => b.score - a.score || compareAddr(a.addr, b.addr))
      .slice(0, 40);
    const baseScores = new Map(seeds.map((s) => [s, s.score]));
    for (const seed of seeds) {
      const seedBaseScore = baseScores.get(seed);
      const seedTainted = tainted(seed);
      if (seedTainted) continue;
      let calleeNameHits = 0;
      let callerNameHits = 0;
      const range = program.functionRange(seed.addr);
      /* Unknown end means "unknown body", never "from here to EOF". Callee
         evidence is valid only for an exact, bounded containing function. */
      if (range && range.start === seed.addr && range.end != null) {
        for (const callee of program.calleesOf(range.start, range.end, 40)) {
          if (callee.addr == null || callee.addr === seed.addr) continue;
          const name = symbolNameAt(callee.addr);
          const existingCallee = byAddr.get(callee.addr.toString());
          const calleeTainted = existingCallee ? tainted(existingCallee) : taintedName(name);
          const m = name && !calleeTainted ? matchName(goal, name) : null;
          if (m) {
            const factor = calleeNameHits === 0 ? 1 : calleeNameHits === 1 ? 0.6 : calleeNameHits === 2 ? 0.35 : 0;
            calleeNameHits++;
            if (factor > 0) addReason(seed, REASON.CALLEE_NAME, POINTS[REASON.CALLEE_NAME] * m.score * factor, { name, addr: callee.addr, site: callee.site });
          }
          if (seedBaseScore >= 20) {
            const c = candidate(callee.addr, callee.site);
            if (c && c !== seed && !c.reasons.some((r) => r.code === REASON.CALLED_BY_MATCH)) {
              addReason(c, REASON.CALLED_BY_MATCH, POINTS[REASON.CALLED_BY_MATCH], { from: seed.addr, fromName: seed.name, site: callee.site });
            }
          }
        }
      } else notes.push('callee-range-unknown:' + seed.addr.toString());

      for (const caller of program.callersOf(seed.addr, 40)) {
        if (caller.addr == null || caller.addr === seed.addr) continue;
        const name = symbolNameAt(caller.addr);
        const existingCaller = byAddr.get(caller.addr.toString());
        const callerTainted = existingCaller ? tainted(existingCaller) : taintedName(name);
        const m = name && !callerTainted ? matchName(goal, name) : null;
        if (m) {
          const factor = callerNameHits === 0 ? 1 : callerNameHits === 1 ? 0.6 : callerNameHits === 2 ? 0.35 : 0;
          callerNameHits++;
          if (factor > 0) addReason(seed, REASON.CALLER_NAME, POINTS[REASON.CALLER_NAME] * m.score * factor, { name, addr: caller.addr, site: caller.site });
        }
        if (seedBaseScore >= 20) {
          const c = candidate(caller.addr, caller.site);
          if (c && c !== seed && !c.reasons.some((r) => r.code === REASON.CALLS_MATCH)) {
            addReason(c, REASON.CALLS_MATCH, POINTS[REASON.CALLS_MATCH], { to: seed.addr, toName: seed.name, site: caller.site });
          }
        }
      }
    }
  }

  for (const c of byAddr.values()) applyVendorPenalty(c);

  const expects = goal.expects || {};
  for (const c of byAddr.values()) {
    if (!hasProgram) break;
    if (c.score <= 10 && c.vendor && vendorConflicts(goal.id, c.vendor)) continue;
    const called = program.callCountOf(c.addr);
    if (called >= 3) {
      const isConstGetter = !!(c.name && symbolMutationKind(c.name).kind === 'const-getter');
      const popPoints = isConstGetter ? POINTS[REASON.POPULAR] * 0.4 : POINTS[REASON.POPULAR];
      addReason(c, REASON.POPULAR, popPoints, { n: called, complete: !program.callsCapped });
    }
    c.calledCount = called;
    const range = program.functionRange(c.addr);
    if (!range || range.start !== c.addr || range.end == null) continue;
    const stats = program.statsOf(range.start, range.end);
    c.stats = stats; c.range = range;
    if (!stats.total) continue;
    if (expects.numeric && stats.numeric > 0) addReason(c, REASON.NUMERIC, Math.min(POINTS[REASON.NUMERIC], 4 * stats.numeric), { mul: stats.mul, div: stats.div, fmul: stats.fmul, farith: stats.farith, complete: stats.covered !== false });
    if (expects.store && stats.store > 0) addReason(c, REASON.STORE, POINTS[REASON.STORE], { n: stats.store, complete: stats.covered !== false });
    if (expects.compare && stats.cmp > 0) addReason(c, REASON.COMPARE, POINTS[REASON.COMPARE], { n: stats.cmp, complete: stats.covered !== false });
    if (stats.total > 1500) addReason(c, REASON.SIZE_PENALTY, POINTS[REASON.SIZE_PENALTY], { n: stats.total, complete: stats.covered !== false });
  }

  const out = [];
  for (const c of byAddr.values()) {
    if (c.score <= 0) continue;
    c.confidence = scoreToConfidence(c.score); c.stars = stars(c.confidence);
    c.reasons.sort((a, b) => b.points - a.points); out.push(c);
  }
  out.sort((a, b) => b.score - a.score || compareAddr(a.addr, b.addr));
  return {
    candidates: out.slice(0, resultLimit), matchedStrings, notes, total: out.length,
    matchedStringsComplete: selectedStrings.complete,
  };
}

export function breakdown(candidate) {
  if (!candidate) return [];
  const merged = new Map();
  for (const r of candidate.reasons) {
    const key = r.code + ':' + (r.detail?.name || '');
    if (!merged.has(key)) merged.set(key, { ...r, points: 0, count: 0 });
    const m = merged.get(key); m.count++; m.points += r.points;
  }
  return Array.from(merged.values()).sort((a, b) => b.points - a.points);
}
