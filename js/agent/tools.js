/*
 * Thin authority-boundary wrapper around the deterministic agent tool core.
 * Keep the large implementation byte-identical to current main; only the
 * completeness/range contracts fixed by #4104/#4106/#4275/#4360/#4461 live here.
 */
import { irFor } from '../ir.js';
import {
  AgentToolError,
  compactFact,
  createAgentTools as createCoreAgentTools,
  DETERMINISTIC_TOOL_NAMES,
} from './tools-core.js';

export { AgentToolError, compactFact, DETERMINISTIC_TOOL_NAMES };

function nonNegativeOffset(value) {
  if (value == null) return 0;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    if (Number.isSafeInteger(n)) return n;
  }
  throw new AgentToolError('invalid-argument', 'offset must be a non-negative safe integer', { name:'offset', value });
}

function bounded(value, fallback, min, max) {
  const n = value == null ? fallback : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function asAddress(value) {
  try {
    const raw = value?.addr ?? value;
    if (typeof raw === 'bigint') return raw >= 0n ? raw : null;
    if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw >= 0 ? BigInt(raw) : null;
    if (typeof raw === 'string' && /^(?:0[xX][0-9a-fA-F]+|\d+)$/.test(raw.trim())) return BigInt(raw.trim());
  } catch {}
  return null;
}

export function pageRows(value, limit, offset = 0) {
  const meta = !Array.isArray(value) && value && typeof value === 'object' ? value : {};
  const rows = Array.isArray(value) ? value : (Array.isArray(meta.results) ? meta.results : []);
  const start = nonNegativeOffset(offset);
  const reportedRaw = meta.offset ?? meta.pageOffset ?? meta.pagination?.offset;
  const reported = typeof reportedRaw === 'number' && Number.isSafeInteger(reportedRaw) && reportedRaw >= 0 ? reportedRaw : null;
  let sourceStart;
  if (reported === start) sourceStart = 0;
  else if (reported != null && reported !== start) {
    const rel = start - reported;
    sourceStart = rel >= 0 && rel < rows.length ? rel : rows.length;
  } else if (start === 0) sourceStart = 0;
  else sourceStart = rows.length > limit ? Math.min(start, rows.length) : 0;

  const results = rows.slice(sourceStart, sourceStart + limit);
  const totalRaw = meta.total ?? meta.completeness?.total;
  const hasExplicitTotal = totalRaw != null;
  const explicitTotal = hasExplicitTotal && Number.isSafeInteger(totalRaw) && totalRaw >= 0 ? totalRaw : null;
  const invalidTotal = hasExplicitTotal && explicitTotal == null;
  const returned = results.length;
  const completeFlags = [meta.complete, meta.completeness?.complete];
  const invalidCompleteness = [...completeFlags, meta.truncated]
    .some((flag) => flag != null && typeof flag !== 'boolean');
  let complete = completeFlags[0] ?? completeFlags[1];
  const upstreamTruncated = meta.truncated === true || completeFlags.includes(false);
  if (invalidTotal || invalidCompleteness || upstreamTruncated) complete = false;
  else if (complete == null) {
    if (explicitTotal != null) complete = start + returned >= explicitTotal && !upstreamTruncated;
    else complete = rows.length < limit && !upstreamTruncated;
  }

  const sourceComplete = complete === true;
  const localTruncated = sourceStart + returned < rows.length
    || (explicitTotal != null && start + returned < explicitTotal);
  if (localTruncated) complete = false;
  const sourceOffset = reported ?? (rows.length > limit ? 0 : start);
  const total = invalidTotal || invalidCompleteness ? null
    : (explicitTotal ?? (sourceComplete ? sourceOffset + rows.length : (rows.length > limit ? rows.length : null)));
  const coverageRaw = meta.coverage ?? meta.completeness?.coverage;
  let coverage = !invalidCompleteness && typeof coverageRaw === 'number' && Number.isFinite(coverageRaw) ? coverageRaw : NaN;
  if (!Number.isFinite(coverage)) coverage = total ? Math.min(1, (start + returned) / total) : (complete ? 1 : null);
  if (localTruncated && total > 0 && Number.isFinite(coverage)) coverage = Math.min(coverage, (start + returned) / total);
  const reason = invalidCompleteness ? 'invalid-completeness'
    : (meta.reason ?? meta.completeness?.reason ?? (invalidTotal ? 'invalid-total' : (complete ? null : 'result-limit')));
  const normalizedCoverage = Number.isFinite(coverage) ? Math.max(0, Math.min(1, coverage)) : null;
  return {
    results, total, returned, offset:start, complete:complete === true, truncated:!complete,
    coverage:normalizedCoverage, reason,
    ...(meta.scanned != null ? { scanned:meta.scanned } : {}),
    ...(meta.scanTotal != null ? { scanTotal:meta.scanTotal } : {}),
    completeness:{ complete:complete === true, returned, total, coverage:normalizedCoverage, reason },
  };
}

function sanitizeProducerPage(value, limit, offset = 0) {
  if (Array.isArray(value) || !value || typeof value !== 'object') return value;
  const meta = { ...value };
  const nested = meta.completeness && typeof meta.completeness === 'object' && !Array.isArray(meta.completeness)
    ? { ...meta.completeness } : null;
  const flags = [meta.complete, nested?.complete, meta.truncated];
  const malformed = flags.some((flag) => flag != null && typeof flag !== 'boolean');
  if (malformed) {
    meta.complete = false;
    meta.truncated = true;
    meta.total = null;
    meta.coverage = null;
    meta.reason = 'invalid-completeness';
    if (nested) meta.completeness = { ...nested, complete:false, total:null, coverage:null, reason:'invalid-completeness' };
    return meta;
  }
  const rows = Array.isArray(meta.results) ? meta.results : [];
  const start = nonNegativeOffset(offset);
  const total = Number.isSafeInteger(meta.total) && meta.total >= 0 ? meta.total
    : (Number.isSafeInteger(nested?.total) && nested.total >= 0 ? nested.total : null);
  if (rows.length > limit || (total != null && start + Math.min(rows.length, limit) < total)) {
    meta.complete = false;
    meta.truncated = true;
    meta.reason ??= 'result-limit';
    if (nested) meta.completeness = { ...nested, complete:false, reason:nested.reason ?? 'result-limit' };
  }
  return meta;
}

function candidateAddresses(context, requested, limit) {
  const addresses = [];
  const seen = new Set();
  for (const source of [requested ?? [], context.candidateFunctions ?? []]) {
    for (const value of source) {
      const address = asAddress(value);
      if (address == null) continue;
      const key = address.toString();
      if (seen.has(key)) continue;
      if (addresses.length >= limit) return { addresses, scopeTruncated:true };
      seen.add(key); addresses.push(address);
    }
  }
  return { addresses, scopeTruncated:false };
}

function semanticSourceReason(model) {
  if (model == null) return 'semantic-ir-unavailable';
  try { return irFor(model)?.truncated === true ? 'semantic-ir-truncated' : null; }
  catch { return 'semantic-ir-unavailable'; }
}

function forceIncomplete(result, reason) {
  if (!result || typeof result !== 'object') return result;
  return {
    ...result,
    total:null,
    complete:false,
    truncated:true,
    reason,
    coverage:null,
    ...(result.completeness && typeof result.completeness === 'object'
      ? { completeness:{ ...result.completeness, total:null, complete:false, coverage:null, reason } }
      : {}),
  };
}

export function createAgentTools(context, opts = {}) {
  const ctx = context || {};
  const models = new Map();
  const wrapped = { ...ctx };
  if (typeof ctx.analyze === 'function') {
    wrapped.analyze = async (address, end) => {
      const model = await ctx.analyze(address, end);
      const key = asAddress(address)?.toString();
      if (key != null) models.set(key, model);
      return model;
    };
  }
  if (typeof ctx.searchStrings === 'function') {
    wrapped.searchStrings = async (query, options = {}) => sanitizeProducerPage(
      await ctx.searchStrings(query, options), bounded(options.limit, 50, 1, 200), options.offset ?? 0);
  }
  if (ctx.strings && typeof ctx.strings.search === 'function') {
    wrapped.strings = { ...ctx.strings, search:async (query, limit, offset) => sanitizeProducerPage(
      await ctx.strings.search(query, limit, offset), bounded(limit, 50, 1, 200), offset ?? 0) };
  }
  if (typeof ctx.searchFunctions === 'function') {
    wrapped.searchFunctions = async (query, options = {}) => sanitizeProducerPage(
      await ctx.searchFunctions(query, options), bounded(options.limit, 40, 1, 200), options.offset ?? 0);
  }
  // Normalize function-range address types before the unchanged core consumes them.
  if (ctx.program && typeof ctx.program === 'object') {
    wrapped.program = new Proxy(ctx.program, { get(target, property, receiver) {
      if (property === 'functionRange' && typeof target.functionRange === 'function') {
        return (address) => {
          const range = target.functionRange(address);
          if (!range || typeof range !== 'object') return range;
          return { ...range,
            ...(range.start == null ? {} : { start:asAddress(range.start) ?? range.start }),
            ...(range.end == null ? {} : { end:asAddress(range.end) ?? range.end }),
          };
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }

  const tools = createCoreAgentTools(wrapped, opts);
  const maxFunctions = (() => {
    if (opts.maxFunctions == null) return 64;
    const n = Number(opts.maxFunctions);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 64;
  })();

  const originalCallees = tools.get_callees;
  tools.get_callees = async (address, options) => {
    const addr = asAddress(address);
    let range = null;
    if (addr != null && ctx.program && typeof ctx.program.functionRange === 'function') {
      try { range = ctx.program.functionRange(addr); }
      catch (error) { throw new AgentToolError('tool-failed', 'functionRange failed', { method:'functionRange', cause:String(error?.message ?? error) }); }
    }
    if (!ctx.program || typeof ctx.program !== 'object') {
      const offset = bounded(options?.offset, 0, 0, 1000000);
      return { tool:'get_callees', address:addr, supported:false, results:[], offset, returned:0,
        total:null, complete:false, truncated:true, reason:'unsupported-program-query', cost:{ functions:0, disassembly:0 } };
    }
    const end = asAddress(range?.end);
    const start = range?.start == null ? null : asAddress(range.start);
    if (addr == null || end == null || end <= addr || (range?.start != null && (start == null || start > addr))) {
      const offset = bounded(options?.offset, 0, 0, 1000000);
      return { tool:'get_callees', address:addr, supported:false, results:[], offset, returned:0,
        total:null, complete:false, truncated:true, reason:'function-range-unavailable', cost:{ functions:0, disassembly:0 } };
    }
    return originalCallees(address, options);
  };

  for (const name of ['find_field_writers', 'find_field_readers', 'find_thresholds', 'get_semantic_facts', 'verify_field_update']) {
    const original = tools[name];
    tools[name] = async (address, ...args) => {
      const result = await original(address, ...args);
      const key = asAddress(address)?.toString();
      const reason = key == null ? null : semanticSourceReason(models.get(key));
      return reason ? forceIncomplete(result, reason) : result;
    };
  }

  for (const name of ['find_constant', 'explain_evidence']) {
    const original = tools[name];
    tools[name] = async (...args) => {
      const options = name === 'find_constant' ? args[1] : args[1];
      const scope = candidateAddresses(ctx, options?.functions, maxFunctions);
      let result = await original(...args);
      if (scope.scopeTruncated) result = { ...forceIncomplete(result, 'function-budget'), scopeTruncated:true, scopedFunctions:scope.addresses.length };
      else {
        const reason = scope.addresses.map((addr) => semanticSourceReason(models.get(addr.toString()))).find(Boolean) ?? null;
        if (reason) result = forceIncomplete(result, reason);
        result = { ...result, scopeTruncated:false, scopedFunctions:scope.addresses.length };
      }
      return result;
    };
  }

  return tools;
}
