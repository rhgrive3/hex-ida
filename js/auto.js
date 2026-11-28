import { stableDigest, jsonSafe } from './core/identity/index.js';
/*
 * 自動解析 — 利用者が何も指示しなくても、分かることを全部やる。
 * 重い処理は索引 → 採点 → pinpoint → 深掘りの順で、失敗を隠さない。
 */
import { GOALS, goalFromPreset } from './goals.js';
import { rankCandidates } from './rank.js';
import { vendorsOf } from './vendors.js';
import { groupByFeature, detectEngine } from './features.js';
import { findValueUpdates, constantComparisons } from './dataflow.js';
import { buildAppMap, buildStringMap } from './appmap.js';
import { pinpointField, pinpointFunction, pinpointLocation } from './pinpoint.js';
import { VERDICT, verdictRank } from './evidence.js';
import { inferRole } from './role.js';
import { runWasmStructuralAnalysis } from './analysis/wasm-suite.js';

const SIGNALS = [
  { id: 'endpoint', level: 'high', re: /^https?:\/\/[^\s"']{4,}/i, max: 12 },
  { id: 'anticheat', level: 'high', re: /cheat|jailbr|jailbroken|cydia|frida(?!y)|substrate|tamper|integrity|debugger|ptrace|sandbox_?check|不正|改造|チート/i, max: 8 },
  { id: 'crypto', level: 'normal', re: /\baes\b|\bsha(1|256|512)\b|\bhmac\b|\brsa\b|encrypt|decrypt|cipher|keychain|private_?key/i, max: 8 },
  { id: 'ads', level: 'normal', re: /admob|applovin|unityads|ironsource|vungle|tapjoy|adjust\.com|appsflyer|interstitial|rewarded[\s_-]?(?:ads?|video|interstitial)/i, max: 6 },
  { id: 'purchase', level: 'high', re: /storekit|skpayment|receipt|verifyreceipt|subscription|in_?app_?purchase/i, max: 6 },
  { id: 'debuglog', level: 'low', re: /\bdebug\b|verbose|assert|FIXME/i, caseRe: /\bTODO\b/, max: 4 },
  { id: 'path', level: 'low', re: /^\/(Users|var|private|tmp|Applications)\/[^\s"']{4,}/, max: 6 },
];

function toSafeNonNegInt(v) {
  let bi = null;
  if (typeof v === 'bigint') bi = v;
  else if (typeof v === 'number') bi = Number.isSafeInteger(v) ? BigInt(v) : null;
  else if (typeof v === 'string' && v.trim()) {
    try { bi = BigInt(v.trim()); } catch { bi = null; }
  }
  if (bi == null || bi < 0n || bi > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(bi);
}

function extractConstDataSectionsFromImage(image) {
  if (!image || !Array.isArray(image.sections) || !(image.bytes instanceof Uint8Array)) return [];
  const out = [];
  for (let i = 0; i < image.sections.length; i++) {
    const sec = image.sections[i];
    if (!sec) continue;
    const seg = typeof sec.segment === 'string' ? sec.segment : '';
    const name = typeof sec.name === 'string' ? sec.name : '';
    const isMachOConst = ((seg === '__DATA_CONST' || seg === '__TEXT' || seg === '__DATA') && name === '__const')
      || name === '__DATA_CONST.__const'
      || name === '__TEXT.__const'
      || name === '__DATA.__const';
    const isElfPeConst = name === '.rodata' || name === '.data.rel.ro' || name === '.rdata';
    if (!isMachOConst && !isElfPeConst) continue;
    const off = toSafeNonNegInt(sec.fileOffset);
    const sz = toSafeNonNegInt(sec.fileSize ?? sec.size);
    if (off == null || sz == null) continue;
    if (off < 0 || sz < 16 || off + sz > image.bytes.length) continue;
    const displayName = seg && !name.startsWith(`${seg}.`) ? `${seg}.${name}` : name;
    out.push({
      name: displayName,
      bytes: image.bytes.subarray(off, off + sz),
      va: sec.address ?? sec.va ?? null,
    });
  }
  return out;
}

function lowerBoundBig(values, target) {
  let lo = 0, hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * Fairly sample the whole function range rather than silently taking the first
 * N addresses. This prevents late executable regions/functions from starving.
 */
function fairFunctionList(symbols, region, max = 20000) {
  if (!symbols?.funcs?.length) return [];
  if (!region) {
    // SymbolIndex.functionList() returns a plain, silently truncated Array with
    // no completeness metadata, and readers treat missing metadata fail-open.
    // Publish the authority explicitly: a list cut at `max` is a sample, not a
    // complete inventory (#4044).
    const list = symbols.functionList?.(region, max) || [];
    const total = Number.isSafeInteger(symbols.functionCount) ? symbols.functionCount : list.length;
    Object.defineProperties(list, {
      complete: { value: list.length >= total, enumerable: false },
      sampled: { value: list.length < total, enumerable: false },
      totalFunctions: { value: total, enumerable: false },
    });
    return list;
  }
  const lo = region.vmAddr;
  const hi = region.vmAddr + region.size;
  const first = lowerBoundBig(symbols.funcs, lo);
  const last = lowerBoundBig(symbols.funcs, hi);
  const total = Math.max(0, last - first);
  if (!total) return [];
  const count = Math.min(max, total);
  const indexes = [];
  if (total <= max) {
    for (let i = first; i < last; i++) indexes.push(i);
  } else {
    const seen = new Set();
    for (let slot = 0; slot < count; slot++) {
      const rel = count === 1 ? 0 : Math.round(slot * (total - 1) / (count - 1));
      const idx = first + rel;
      if (!seen.has(idx)) { seen.add(idx); indexes.push(idx); }
    }
  }
  const hasDirectEnd = typeof symbols._functionEnd === 'function';
  const hasDirectAddrs = symbols.addrs?.length > 0 && Array.isArray(symbols.names);
  const renames = symbols.renames instanceof Map && symbols.renames.size > 0 ? symbols.renames : null;
  let symCursor = hasDirectAddrs ? lowerBoundBig(symbols.addrs, symbols.funcs[indexes[0]]) : 0;
  const out = indexes.map((idx) => {
    const addr = symbols.funcs[idx];
    const end = hasDirectEnd ? symbols._functionEnd(idx) : (symbols.functionAt?.(addr)?.end ?? null);
    let name = null;
    if (renames) name = renames.get(addr.toString()) || null;
    if (name == null) {
      if (hasDirectAddrs) {
        while (symCursor < symbols.addrs.length && symbols.addrs[symCursor] < addr) symCursor++;
        while (symCursor + 1 < symbols.addrs.length && symbols.addrs[symCursor + 1] === addr) symCursor++;
        if (symCursor < symbols.addrs.length && symbols.addrs[symCursor] === addr) {
          name = symbols.names[symCursor] || null;
        }
      } else {
        name = symbols.nameAt?.(addr) || null;
      }
    }
    return { addr, name, size: end != null ? end - addr : null };
  });
  Object.defineProperties(out, {
    complete: { value: total <= max, enumerable: false },
    sampled: { value: total > max, enumerable: false },
    totalFunctions: { value: total, enumerable: false },
  });
  return out;
}

function fallbackFunctionEnd(symbols, addr, region) {
  const funcs = symbols?.funcs;
  if (!funcs || !funcs.length) return null;
  const idx = lowerBoundBig(funcs, addr);
  if (idx < 0 || idx >= funcs.length || funcs[idx] !== addr) return null;
  if (typeof symbols._containmentBound === 'function') {
    const bound = symbols._containmentBound(idx);
    if (bound != null && bound > addr) return bound;
  }
  const regionEnd = (region && region.vmAddr != null && region.size != null)
    ? BigInt(region.vmAddr) + BigInt(region.size)
    : null;
  const next = idx + 1 < funcs.length ? funcs[idx + 1] : null;
  if (next != null && next > addr && next - addr <= 0x40000n) {
    return regionEnd != null && regionEnd < next ? regionEnd : next;
  }
  if (regionEnd != null && regionEnd > addr) {
    const capped = addr + 0x40000n;
    return regionEnd < capped ? regionEnd : capped;
  }
  return null;
}

export function notableFunctions(program, symbols, region, limit = 12) {
  if (!program || !symbols || !symbols.functionCount) return [];
  const list = fairFunctionList(symbols, region, 20000);
  const out = [];
  for (const f of list) {
    const rawRange = program.functionRange(f.addr);
    if (!rawRange) continue;
    const end = rawRange.end != null ? rawRange.end : fallbackFunctionEnd(symbols, rawRange.start, rawRange.region || region);
    if (end == null || end <= rawRange.start) continue;
    const range = rawRange.end != null ? rawRange : { ...rawRange, end };
    const stats = program.statsOf(range.start, range.end);
    if (!stats.total) continue;
    const called = program.callCountOf(f.addr);
    const reasons = [];
    let score = 0;
    if (called >= 2) {
      const p = Math.min(18, called * 3); score += p;
      reasons.push({ code: 'called', points: p, detail: { n: called } });
    }
    if (stats.numeric) {
      const p = Math.min(12, stats.numeric * 3); score += p;
      reasons.push({ code: 'numeric', points: p, detail: { mul: stats.mul, div: stats.div, fmul: stats.fmul } });
    }
    if (stats.store && stats.load) {
      const p = Math.min(10, stats.store * 2); score += p;
      reasons.push({ code: 'readwrite', points: p, detail: { load: stats.load, store: stats.store } });
    }
    if (f.name) { score += 6; reasons.push({ code: 'named', points: 6, detail: { name: f.name } }); }
    if (stats.cmp >= 2) { score += 4; reasons.push({ code: 'compare', points: 4, detail: { n: stats.cmp } }); }
    if (stats.total > 1500) { score -= 10; reasons.push({ code: 'huge', points: -10, detail: { n: stats.total } }); }
    if (score <= 6) continue;
    out.push({ addr: f.addr, name: f.name, score, reasons, stats, called, range, sampleComplete: list.complete !== false });
  }
  out.sort((a, b) => b.score - a.score || (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0));
  const normalizedLimit = (typeof limit === 'number' && Number.isFinite(limit) && Number.isInteger(limit))
    ? Math.max(0, limit)
    : 12;
  const result = out.slice(0, normalizedLimit);
  Object.defineProperties(result, {
    complete: { value: list.complete !== false, enumerable: false },
    sampled: { value: list.sampled === true, enumerable: false },
  });
  return result;
}

/**
 * Keep interesting dead/unreferenced strings visible as data, but mark them
 * explicitly non-actionable. Only proven code xrefs may drive next-step advice.
 */
// The xref span must be the string's original UTF-8 byte extent (#5698).
// Producer contract (worker scanStrings): display text is control-escaped
// (`\t`/`\r`/`\n`), and the emitted byteLength is the raw run's extent. A
// non-escape display code point has a determined UTF-8 width (1..4 bytes by
// code-point range). An escape is ambiguous from the display alone — a real
// escaped control is 1 raw byte but a literal backslash+letter is 2 — so it
// counts 1..2. From the display text that gives a provable [minRaw, maxRaw]
// window; a carried byteLength outside it (or of the wrong type) is a
// forged/malformed authority and fails closed.
function producerByteExtentWindow(text) {
  let minRaw = 0;
  let maxRaw = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x5c && (text[i + 1] === 't' || text[i + 1] === 'r' || text[i + 1] === 'n')) {
      // Ambiguous from the display alone: a real escaped control is 1 raw
      // byte, a literal backslash+letter is 2. The window admits both so a
      // genuine producer extent is never rejected (#5698 completeness).
      minRaw += 1;
      maxRaw += 2;
      i++;
      continue;
    }
    const unit = text.codePointAt(i);
    if (unit > 0xffff) i++;
    // A non-escape decoded code point has a determined UTF-8 width: the
    // producer scanned raw UTF-8, so U+0020..U+007E came from 1 byte,
    // U+0080..U+07FF from 2, U+0800..U+FFFF from 3, astral from 4. Both
    // window edges take that exact width — a smaller claimed byteLength
    // (e.g. a truncated slice) must not become xref authority (#5698).
    const width = unit <= 0x7f ? 1 : unit <= 0x7ff ? 2 : unit <= 0xffff ? 3 : 4;
    minRaw += width;
    maxRaw += width;
  }
  return { minRaw, maxRaw };
}

// Returns the authoritative raw byte span, or null when the entry carries no
// provable extent (missing byteLength falls back to the provable minimum; a
// malformed/forged carried value gets no xref authority at all).
function toBigIntAddress(addr) {
  if (typeof addr === 'bigint') return addr >= 0n ? addr : null;
  if (typeof addr === 'number') return Number.isSafeInteger(addr) && addr >= 0 ? BigInt(addr) : null;
  if (typeof addr === 'string') {
    const text = addr.trim();
    if (/^(?:\d+|0[xX][0-9a-fA-F]+)$/.test(text)) {
      try {
        const v = BigInt(text);
        return v >= 0n ? v : null;
      } catch { return null; }
    }
  }
  return null;
}

function stringByteSpan(s) {
  if (typeof s?.text !== 'string') return null;
  const carried = s.byteLength;
  if (carried === undefined || carried === null) {
    const { minRaw } = producerByteExtentWindow(s.text);
    return minRaw > 0 ? minRaw : null;
  }
  if (typeof carried !== 'number' || !Number.isSafeInteger(carried) || carried <= 0) {
    return null;
  }
  const { minRaw, maxRaw } = producerByteExtentWindow(s.text);
  if (carried < minRaw || carried > maxRaw) return null;
  return carried;
}

export function findings(strings, program, symbols, limit = 50) {
  const out = [];
  if (!program || limit <= 0) return out;
  // Collect referenced (actionable) matches first per signal so dead/unreferenced
  // strings at the front of the table cannot starve real code references (#findings-priority).
  const buckets = SIGNALS.map((sig) => ({
    actionable: [],
    unreferenced: [],
    byText: new Map(),
    probes: 0,
    maxProbes: Math.max(sig.max * 512, 2048),
    done: false,
  }));
  let activeSignals = SIGNALS.length;
  for (const s of strings || []) {
    if (activeSignals === 0) break;
    if (typeof s?.text !== 'string') continue;
    const text = s.text;
    for (let si = 0; si < SIGNALS.length; si++) {
      const sig = SIGNALS[si];
      const bucket = buckets[si];
      if (bucket.done) continue;
      if (!sig.re.test(text) && !(sig.caseRe && sig.caseRe.test(text))) continue;
      // The xref span is a virtual-address byte range (#5698): use the
      // string's authoritative raw byte extent; entries without one stay
      // visible as data but get no xref authority (no over-inclusive
      // display-derived span), so they cannot be marked referenced.
      const span = stringByteSpan(s);
      const addr = toBigIntAddress(s.addr);
      const users = (span == null || addr == null)
        ? { length: 0, complete: false, map: () => [] }
        : program.functionsReferencing(addr, BigInt(Math.max(1, Math.min(span, 256))), 8);
      const actionable = users.length > 0;
      const mappedUsers = users.map((u) => ({
        addr: u.addr, site: u.site,
        name: u.addr != null && symbols ? symbols.nameAt(u.addr) : null,
      }));
      bucket.probes++;
      const existing = bucket.byText.get(text);
      if (existing) {
        for (const u of mappedUsers) {
          if (existing.users.length >= 8) break;
          if (!existing.users.some((eu) => eu.addr === u.addr && eu.site === u.site)) {
            existing.users.push(u);
          }
        }
        if (actionable && !existing.actionable) {
          existing.actionable = true;
          existing.status = 'referenced';
          existing.addr = addr ?? existing.addr;
          existing.xrefsComplete = users.complete !== false;
          const idx = bucket.unreferenced.indexOf(existing);
          if (idx >= 0) bucket.unreferenced.splice(idx, 1);
          bucket.actionable.push(existing);
          if (bucket.actionable.length >= sig.max) {
            bucket.done = true;
            activeSignals--;
          }
        }
      } else {
        const entry = {
          id: sig.id, level: sig.level, text: s.text, addr: addr ?? s.addr,
          actionable,
          status: actionable ? 'referenced' : 'unreferenced',
          xrefsComplete: users.complete !== false,
          users: mappedUsers,
        };
        if (actionable) {
          bucket.byText.set(text, entry);
          bucket.actionable.push(entry);
          if (bucket.actionable.length >= sig.max) {
            bucket.done = true;
            activeSignals--;
          }
        } else if (bucket.unreferenced.length < sig.max) {
          bucket.byText.set(text, entry);
          bucket.unreferenced.push(entry);
        }
      }
      if (!bucket.done && bucket.probes >= bucket.maxProbes) {
        bucket.done = true;
        activeSignals--;
      }
    }
  }
  for (let si = 0; si < SIGNALS.length; si++) {
    const sig = SIGNALS[si];
    const bucket = buckets[si];
    const combined = bucket.actionable.concat(bucket.unreferenced).slice(0, sig.max);
    for (const entry of combined) out.push(entry);
  }
  // Proven/actionable findings always precede dead strings before applying total limit.
  out.sort((a, b) => Number(b.actionable) - Number(a.actionable) || b.users.length - a.users.length);
  return out.slice(0, limit);
}

export async function autoAnalyze(opts) {
  const o = opts || {};
  const { strings = [], program = null, symbols = null, region = null } = o;
  // Progress/cancel callbacks are invocation authorities: only callable
  // values may be invoked. Truthy non-functions must not raise TypeError
  // mid-analysis (#3308).
  const progress = typeof o.onProgress === 'function' ? o.onProgress : () => {};
  const cancelled = typeof o.isCancelled === 'function' ? o.isCancelled : () => false;
  // deepLimit is an analysis-coverage authority like the pinpoint budgets:
  // only a primitive non-negative safe integer may define it. Malformed
  // values fall back to the default instead of coercing through relational
  // comparisons, where Infinity would uncap and strings/booleans would set
  // arbitrary counts (#5285, #5288). Explicit 0 disables deep analysis.
  const deepLimit = typeof o.deepLimit === 'number' && Number.isSafeInteger(o.deepLimit) && o.deepLimit >= 0 ? o.deepLimit : 12;

  const report = {
    map: null, engine: null, features: [], goals: [], pinned: [], confirmed: [],
    settled: [], unsettled: [], unexamined: [], notable: [], findings: [], deep: [],
    diagnostics: [],
    stats: {
      strings: strings.length,
      calls: program ? program.callCount : 0,
      refs: program ? program.refCount : 0,
      functions: symbols ? symbols.functionCount : 0,
      statsComplete: program ? program.statsComplete : false,
      capped: !!(program && (program.callsCapped || program.refsCapped)),
    },
    wasmAnalysis: null,
    notes: [],
  };

  const diagnose = (phase, error, detail = null) => {
    const type = String(error?.type || error?.code || error?.name || 'analysis_error');
    const message = String(error?.message || error || 'analysis failed').slice(0, 1000);
    const retryable = !['cancelled', 'AbortError', 'scope_violation', 'invalid_tool_call'].includes(type);
    report.diagnostics.push({ phase, type, message, retryable, detail });
  };

  progress({ phase: 'features', done: 0, all: 1 });
  report.engine = detectEngine(strings);
  report.features = groupByFeature(strings);
  report.findings = findings(strings, program, symbols);
  const cryptoConstants = Array.isArray(o.cryptoConstants)
    ? o.cryptoConstants
    : (Array.isArray(o.cryptoScan?.constants) ? o.cryptoScan.constants : []);
  const highEntropyWindows = Array.isArray(o.highEntropyWindows)
    ? o.highEntropyWindows
    : (Array.isArray(o.cryptoScan?.highEntropy) ? o.cryptoScan.highEntropy : []);
  report.crypto = { constants: cryptoConstants, highEntropy: highEntropyWindows };
  if (cryptoConstants.length) {
    for (const hit of cryptoConstants.slice(0, 16)) {
      const addr = toBigIntAddress(hit.address);
      const span = Math.max(16, Math.min(Number(hit.length) || 16, 256));
      const users = (program && addr != null)
        ? program.functionsReferencing(addr, BigInt(span), 8)
        : { length: 0, complete: false, map: () => [] };
      const actionable = users.length > 0;
      report.findings.push({
        id: 'crypto', level: 'high',
        text: `${hit.name} (${hit.id})${hit.section ? ` [${hit.section}]` : ''}`,
        addr: addr ?? hit.address,
        actionable,
        status: actionable ? 'referenced' : 'unreferenced',
        xrefsComplete: users.complete !== false,
        users: users.map((u) => ({
          addr: u.addr, site: u.site,
          name: u.addr != null && symbols ? symbols.nameAt(u.addr) : null,
        })),
      });
    }
  }
  const packedWindows = highEntropyWindows.filter((w) => w && w.kind === 'encrypted-or-packed');
  if (packedWindows.length) {
    const top = packedWindows.slice().sort((a, b) => (b.entropy || 0) - (a.entropy || 0))[0];
    report.findings.push({
      id: 'crypto', level: 'medium',
      text: `High-entropy region (${Number(top.entropy || 0).toFixed(2)} bits/byte, ${packedWindows.length} window${packedWindows.length > 1 ? 's' : ''})${top.section ? ` [${top.section}]` : ''}`,
      addr: toBigIntAddress(top.address) ?? top.address,
      actionable: false,
      status: 'unreferenced',
      xrefsComplete: true,
      users: [],
    });
  }

  progress({ phase: 'map', done: 0, all: 1 });
  const fields = o.fields || null;
  report.map = (fields && fields.classCount)
    ? buildAppMap({ fields, program, symbols, strings, region })
    : buildStringMap({ program, symbols, strings });
  report.stats.classes = fields ? fields.classCount : 0;
  report.stats.fields = fields ? fields.fieldCount : 0;
  await tick();

  const all = GOALS.length;
  const rankedByGoal = new Map();
  const vendors = vendorsOf(fields);
  for (let i = 0; i < GOALS.length; i++) {
    if (cancelled()) { report.notes.push('cancelled'); return report; }
    progress({ phase: 'goals', done: i, all });
    const goal = goalFromPreset(GOALS[i].id);
    const ranked = rankCandidates({ goal, strings, program, symbols, region, limit: 12, vendors, cryptoConstants });
    rankedByGoal.set(goal.id, { goal, ranked });
    if (ranked.candidates.length) {
      report.goals.push({
        goal, candidates: ranked.candidates, best: ranked.candidates[0],
        matchedStrings: ranked.matchedStrings.length, notes: ranked.notes,
      });
    }
    await tick();
  }
  report.goals.sort((a, b) => b.best.score - a.best.score);

  // Pinpoint budgets are analysis-coverage authorities. Only primitive finite
  // numbers may define one; structured values fall back to the defaults
  // instead of coercing through Math.min/comparisons (#3286).
  const budgetOption = (value, fallback) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
  const startBudget = budgetOption(o.pinpointBudget, 360);
  const perGoal = budgetOption(o.pinpointPerGoal, 24);
  const fieldBudget = budgetOption(o.pinpointFieldBudget, 7);
  const locationBudget = budgetOption(o.pinpointLocationBudget, 7);
  const functionBudget = budgetOption(o.pinpointFunctionBudget, 12);
  const budget = { left: startBudget };
  const memo = o.analyze ? memoize(o.analyze) : null;
  const hasClasses = !!(fields?.classCount || o.cxxFields?.fieldCount);

  const pinProbability = (p) => p?.top?.fusion ? p.top.fusion.probability : 0;
  const pinIdentifying = (p) => p?.top?.fusion ? (p.top.fusion.identifying || 0) : 0;
  const pinVerified = (p) => p?.top?.fusion ? (p.top.fusion.verified || 0) : 0;
  const usablePin = (p) => !!(p && p.top && pinIdentifying(p) > 0);
  const multipleVerifiedPin = (p) => usablePin(p) && p.kind === 'function' && p.verdict === VERDICT.AMBIGUOUS &&
    (p.tiedVerified || 0) >= 2 && pinVerified(p) > 0 && pinProbability(p) >= 0.99;
  const settledPin = (p) => usablePin(p) && (verdictRank(p.verdict) >= verdictRank(VERDICT.LIKELY) || multipleVerifiedPin(p));
  const beatsPin = (next, cur) => {
    if (!usablePin(next)) return false;
    if (!usablePin(cur)) return true;
    const vr = verdictRank(next.verdict) - verdictRank(cur.verdict);
    if (vr) return vr > 0;
    const pp = pinProbability(next) - pinProbability(cur);
    if (Math.abs(pp) > 1e-12) return pp > 0;
    const vv = pinVerified(next) - pinVerified(cur);
    if (vv) return vv > 0;
    return pinIdentifying(next) > pinIdentifying(cur);
  };
  const runWithBudget = async (goalBudget, max, fn, phase) => {
    if (budget.left <= 0 || goalBudget.left <= 0 || max <= 0) return null;
    const purse = { left: Math.max(0, Math.min(max, goalBudget.left, budget.left)) };
    const before = purse.left;
    try {
      return await fn(purse);
    } catch (error) {
      diagnose(phase || 'pinpoint', error);
      return null;
    } finally {
      const spent = Math.max(0, before - purse.left);
      budget.left = Math.max(0, budget.left - spent);
      goalBudget.left = Math.max(0, goalBudget.left - spent);
    }
  };

  const goalOrder = GOALS.map((g) => g.id).sort((a, b) => {
    const ea = rankedByGoal.get(a), eb = rankedByGoal.get(b);
    const sa = ea?.ranked?.candidates?.[0]?.score || 0;
    const sb = eb?.ranked?.candidates?.[0]?.score || 0;
    return sb - sa;
  });
  report.stats.pinpointModes = { field: 0, location: 0, function: 0 };

  if (memo || hasClasses) {
    for (let i = 0; i < goalOrder.length; i++) {
      if (cancelled()) {
        report.notes.push('pin-cancelled');
        report.unexamined.push(...goalOrder.slice(i).map((id) => goalFromPreset(id)));
        break;
      }
      progress({ phase: 'pinpoint', done: i, all });
      if (budget.left <= 0) {
        report.unexamined.push(...goalOrder.slice(i).map((id) => goalFromPreset(id)));
        break;
      }
      const entry = rankedByGoal.get(goalOrder[i]);
      const goal = entry ? entry.goal : goalFromPreset(goalOrder[i]);
      const ranked = entry ? entry.ranked.candidates : [];
      const common = {
        goal, fields, program, symbols, strings, region, map: report.map,
        cxxFields: o.cxxFields || null,
        binaryContextPreference: true,
        shapes: o.shapes || null, analyze: memo, scanAccess: o.scanAccess || null,
        isCancelled: cancelled, limit: 12,
      };
      const goalBudget = { left: perGoal };
      const alternatives = [];
      let best = null;

      if (hasClasses) {
        const fieldPin = await runWithBudget(goalBudget, fieldBudget,
          (purse) => {
            report.stats.pinpointModes.field++;
            return pinpointField({ ...common, budget: purse });
          }, `pinpoint-field:${goal.id}`);
        if (fieldPin) alternatives.push(fieldPin);
        if (beatsPin(fieldPin, best)) best = fieldPin;
      }

      const canLocate = memo && ((common.shapes && common.shapes.size) || ranked.length);
      if (canLocate && !((best && best.verdict === VERDICT.CONFIRMED) && best.kind === 'field')) {
        const locPin = await runWithBudget(goalBudget, locationBudget,
          (purse) => {
            report.stats.pinpointModes.location++;
            return pinpointLocation({ ...common, ranked, budget: purse });
          }, `pinpoint-location:${goal.id}`);
        if (locPin) alternatives.push(locPin);
        if (beatsPin(locPin, best)) best = locPin;
      }

      const canFindFunction = memo && (ranked.length || (common.shapes && common.shapes.size));
      if (canFindFunction && !(best && best.verdict === VERDICT.CONFIRMED && best.kind === 'field')) {
        let fieldHint = null;
        const named = alternatives.find((p) => p && p.kind === 'field' && p.top && p.top.source !== 'cxx' && settledPin(p));
        if (named) fieldHint = { offset: named.top.offset, className: named.top.className, plain: named.top.plain, name: named.top.field?.name };
        const fnPin = await runWithBudget(goalBudget, functionBudget,
          (purse) => {
            report.stats.pinpointModes.function++;
            return pinpointFunction({ ...common, ranked, budget: purse, functionCount: symbols ? symbols.functionCount : 0, field: fieldHint });
          },
          `pinpoint-function:${goal.id}`);
        if (fnPin) alternatives.push(fnPin);
        if (beatsPin(fnPin, best)) best = fnPin;
      }

      if (!usablePin(best) || best.verdict === VERDICT.NONE) continue;
      best.alternatives = alternatives.filter((p) => p && p !== best && usablePin(p));
      if (best.kind !== 'function') {
        const fn = alternatives.find((p) => p && p.kind === 'function' && usablePin(p));
        if (fn) best.function = fn;
      } else {
        const value = alternatives.filter((p) => p && p.kind !== 'function' && usablePin(p))
          .sort((a, b) => (beatsPin(a, b) ? -1 : beatsPin(b, a) ? 1 : 0))[0];
        if (value) best.value = value;
      }
      report.pinned.push(best);
      const g = report.goals.find((x) => x.goal.id === goal.id);
      if (g) g.pinned = best;
      await tick();
    }

    report.pinned.sort((a, b) => (verdictRank(b.verdict) - verdictRank(a.verdict)) || (pinProbability(b) - pinProbability(a)));
    report.confirmed = report.pinned.filter((p) => p.verdict === VERDICT.CONFIRMED);
    report.multiple = report.pinned.filter(multipleVerifiedPin);
    for (const p of report.multiple) p.resolution = 'multiple';
    report.settled = report.pinned.filter(settledPin);
    report.unsettled = report.pinned.filter((p) => !settledPin(p));
    report.stats.pinpointUsed = startBudget - budget.left;
    report.stats.pinpointBudget = startBudget;
    report.stats.goalsExamined = goalOrder.length - report.unexamined.length;
  }

  progress({ phase: 'notable', done: 0, all: 1 });
  const recognized = Array.isArray(o.recognition?.records) ? o.recognition.records : [];
  const regionLo = region && typeof region.vmAddr === 'bigint' ? region.vmAddr : null;
  const regionHi = regionLo != null && typeof region.size === 'bigint' ? regionLo + region.size : null;
  const inRegion = (addr) => {
    const a = toBigIntAddress(addr);
    if (a == null) return false;
    if (regionLo == null || regionHi == null) return true;
    return a >= regionLo && a < regionHi;
  };
  const compareNotable = (a, b) => {
    const scoreDiff = (b.score || 0) - (a.score || 0);
    if (scoreDiff) return scoreDiff;
    if (a.addr === b.addr) return 0;
    if (typeof a.addr === 'bigint' && typeof b.addr === 'bigint') return a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0;
    const sa = String(a.addr ?? ''), sb = String(b.addr ?? '');
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  };
  const recognizedNotable = recognized
    .filter((item) => item && item.classification === 'APPLICATION' && inRegion(item.address))
    .map((item) => {
      const addr = toBigIntAddress(item.address);
      const score = Number.isFinite(item.score) ? Math.round(item.score * 100) : 0;
      return {
        addr,
        name: item.name || null,
        score,
        reasons: [{ code: 'recognition', points: score, detail: { classification: item.classification, confidence: item.confidence, knowledge: !!item.knowledge } }],
        recognition: item,
      };
    })
    .sort(compareNotable)
    .slice(0, 24);
  const structuralNotable = notableFunctions(program, symbols, region);
  const seen = new Set();
  report.notable = [...recognizedNotable, ...structuralNotable]
    .map((item) => {
      if (!item) return null;
      const norm = toBigIntAddress(item.addr);
      if (norm == null) return null;
      return item.addr === norm ? item : Object.assign({}, item, { addr: norm });
    })
    .filter(Boolean)
    .sort(compareNotable)
    .filter((item) => {
      const key = item.addr.toString();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 24);
  Object.defineProperties(report.notable, {
    complete:{value:o.recognition ? o.recognition.complete===true && structuralNotable.complete!==false : structuralNotable.complete!==false,enumerable:false},
    sampled:{value:o.recognition?.complete===false || structuralNotable.sampled===true,enumerable:false},
  });
  report.stats.recognition = o.recognition ? { scanned:o.recognition.scannedCount||0,total:o.recognition.total||0,complete:o.recognition.complete===true,knowledgeMatches:o.recognition.knowledgeMatches||0 } : null;
  if (report.notable.sampled) report.notes.push('notable-functions-sampled');

  if (o.analyze && deepLimit > 0) {
    const targets = [];
    const seen = new Set();
    const push = (addr, why, goal) => {
      if (addr == null) return;
      const key = addr.toString();
      if (seen.has(key) || targets.length >= deepLimit) return;
      seen.add(key); targets.push({ addr, why, goal: goal || null });
    };
    for (const g of report.goals) {
      push(g.best.addr, 'goal', g.goal);
      if (g.candidates[1]) push(g.candidates[1].addr, 'goal', g.goal);
    }
    for (const n of report.notable) push(n.addr, 'notable', null);
    for (let i = 0; i < targets.length; i++) {
      if (cancelled()) { report.notes.push('deep-cancelled'); break; }
      progress({ phase: 'deep', done: i, all: targets.length });
      const t = targets[i];
      const range = program ? program.functionRange(t.addr) : null;
      let model = null;
      try {
        model = await (memo || o.analyze)(t.addr, range ? range.end : null);
      } catch (error) {
        diagnose('deep-analyze', error, { address: t.addr.toString() });
      }
      if (!model) continue;
      const updates = findValueUpdates(model).filter((u) => u.kind !== 'compute-store');
      const compares = constantComparisons(model);
      const owner = fields ? fields.ownerOf(t.addr) : null;
      for (const u of updates) {
        u.field = fields ? fields.resolveAccess({
          base: u.location.base, disp: u.location.disp,
          indexAddr: u.location.indexAddr, self: u.location.self,
        }, owner ? owner.className : null) : null;
      }
      const f = model.facts || {};
      const selectors = (model.calls || []).map((c) => c.selector).filter(Boolean);
      const stringFacts = f.strings || [];
      const role = inferRole({
        name: symbols ? symbols.nameAt(t.addr) : null, owner, updates,
        apis: f.apis || [], selectors,
        strings: stringFacts.map((text) => ({ text })), callees: f.calledNames || [], callers: program?.callersOf ? program.callersOf(t.addr).slice(0, 12).map((a) => symbols?.nameAt?.(a)).filter(Boolean) : [],
        comparisons: compares.length, conditionals: f.conditionals || 0,
        calls: f.calls || 0, stores: f.stores || 0, verified: true,
      });
      report.deep.push({
        addr: t.addr, owner, name: symbols ? symbols.nameAt(t.addr) : null,
        why: t.why, goal: t.goal ? t.goal.id : null, goalLabel: t.goal ? t.goal.text : null,
        role, updates: updates.slice(0, 4), compares: compares.slice(0, 4),
        instructions: f.instructionCount || 0, selectors: selectors.slice(0, 4), strings: stringFacts.slice(0, 3),
      });
      await tick();
    }
    report.deep.sort((a, b) => b.updates.length - a.updates.length || (b.goal ? 1 : 0) - (a.goal ? 1 : 0));
  }

  try {
    const codeBytes = o.codeBytes
      || (o.region && o.region.bytes instanceof Uint8Array ? o.region.bytes : null)
      || (program && typeof program.textBytes === 'function' ? program.textBytes() : null);
    const dataBytes = o.dataBytes
      || (program && typeof program.dataBytes === 'function' ? program.dataBytes() : null);
    const dataSections = Array.isArray(o.dataSections) && o.dataSections.length
      ? o.dataSections
      : extractConstDataSectionsFromImage(o.image);
    const imageBase = o.imageBase ?? o.image?.imageBase ?? null;
    if (codeBytes || dataBytes || program || (dataSections && dataSections.length > 0) || o.textConstBytes || o.image) {
      const textVa = o.textVa ?? (o.region?.vmAddr != null ? o.region.vmAddr : 0n);
      const textLo = o.textLo ?? (o.region?.vmAddr != null ? o.region.vmAddr : null);
      const textHi = o.textHi ?? (o.region?.vmAddr != null && o.region?.size != null
        ? BigInt(o.region.vmAddr) + BigInt(o.region.size)
        : null);
      const wa = runWasmStructuralAnalysis({
        codeBytes,
        dataBytes,
        dataSections,
        image: o.image,
        textConstBytes: o.textConstBytes,
        textConstVa: o.textConstVa,
        dataVa: o.dataVa,
        imageBase,
        textVa,
        textLo,
        textHi,
        arch: o.architecture || o.arch || program?.architecture || program?.arch || 'arm64',
        ptrSize: o.ptrSize ?? 8,
        program,
        symbols,
      });
      if (wa.rmw || wa.x86Rmw || wa.vtables || wa.jumpTables || wa.constTables || wa.callgraph || wa.objcSwift || wa.xrefLinks) {
        report.wasmAnalysis = wa;
      }
    }
  } catch (error) {
    diagnose('wasm-analysis', error);
  }

    progress({ phase: 'done', done: 1, all: 1 });
  return report;
}

export function autoNextSteps(report) {
  const steps = [];
  if (!report) return steps;
  const confirmed = (report.confirmed || []).filter((p) => p.top && p.top.kind === 'field');
  if (confirmed.length) {
    const p = confirmed[0];
    const write = (p.changeSites || []).find((s) => s.stores);
    steps.push({ code: 'open-pinned', detail: { label: p.goal.text, className: p.top.className, field: p.top.plain, addr: write ? write.first : null } });
  } else {
    const split = (report.pinned || []).find((x) => x.verdict === VERDICT.AMBIGUOUS && x.top && x.top.kind === 'field');
    if (split) steps.push({ code: 'decide-ambiguous', detail: { label: split.goal.text, a: split.top.plain, b: split.runnerUp?.kind === 'field' ? split.runnerUp.plain : null } });
  }
  const withUpdates = (report.deep || []).filter((d) => d.updates.length);
  if (withUpdates.length) steps.push({ code: 'open-update', detail: { addr: withUpdates[0].updates[0].store.address, name: withUpdates[0].name } });
  if (report.goals?.length) steps.push({ code: 'open-goal', detail: { label: report.goals[0].goal.text, addr: report.goals[0].best.addr } });
  if (report.findings?.some((f) => f.id === 'endpoint' && f.actionable !== false)) steps.push({ code: 'check-endpoint', detail: null });
  if (report.findings?.some((f) => f.id === 'anticheat' && f.actionable !== false)) steps.push({ code: 'check-anticheat', detail: null });
  if (!report.goals?.length && !report.notable?.length) steps.push({ code: 'nothing-found', detail: null });
  if (report.engine) steps.push({ code: 'other-binary', detail: { engine: report.engine.id } });
  steps.push({ code: 'verify-runtime', detail: null });
  return steps;
}

function tick() { return new Promise((resolve) => setTimeout(resolve, 0)); }

/*
 * Cache only successful, non-null analysis. Rejections/nulls are retryable.
 * Option-bearing calls are intentionally never shared (#5068): options enter
 * the execution semantics but not the addr/end cache identity, and a
 * caller-owned AbortSignal must never become the cancellation authority
 * for another caller's analysis.
 */
export function memoizeAnalysis(analyze) {
  const cache = new Map();
  return (addr, end, options = undefined) => {
    if (options !== undefined) return Promise.resolve().then(() => analyze(addr, end, options));
    // Cache identity is analysis authority (#3309): structured values must
    // not collide with their primitive lookalikes through toString(), or a
    // malformed address would reuse another address's cached analysis.
    const keyPart = (value) => {
      if (value === null) return ['null', null];
      if (value === undefined) return ['undefined', null];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return [typeof value, String(value)];
      try { return ['structured', stableDigest(jsonSafe(value))]; } catch { return null; }
    };
    const addrPart = keyPart(addr);
    const endPart = keyPart(end);
    // An uncanonicalizable value has no safe cache identity. Running it without
    // memoization preserves the analyzer's actual input and avoids sharing one
    // opaque sentinel across unrelated cyclic values (#3309).
    if (addrPart == null || endPart == null) return Promise.resolve().then(() => analyze(addr, end, options));
    const key = JSON.stringify([addrPart, endPart]);
    if (cache.has(key)) return cache.get(key);
    const p = Promise.resolve()
      .then(() => analyze(addr, end, options))
      .then((value) => {
        if (value == null) cache.delete(key);
        return value;
      }, (error) => {
        cache.delete(key);
        throw error;
      });
    cache.set(key, p);
    if (cache.size > 400) cache.delete(cache.keys().next().value);
    return p;
  };
}

function memoize(analyze) { return memoizeAnalysis(analyze); }
