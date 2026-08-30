import { createAgentTools as createBaseAgentTools } from './tools-base.js';

const MONITORED = new Set(['callersOf', 'calleesOf', 'refSitesTo', 'functionsReferencing']);

function observeProgram(program, observed) {
  if (!program || typeof program !== 'object') return program;
  return new Proxy(program, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args) => {
        const result = value.apply(target, args);
        if (MONITORED.has(property) && Array.isArray(result)) observed.set(property, result);
        return result;
      };
    },
  });
}

function incompleteState(rows) {
  if (!Array.isArray(rows)) return null;
  const explicitIncomplete = Object.prototype.hasOwnProperty.call(rows, 'complete') && rows.complete !== true;
  if (!explicitIncomplete && rows.capped !== true && rows.queryLimited !== true && !rows.incompleteReason) return null;
  return {
    reason: rows.incompleteReason || (rows.queryLimited === true ? 'query-limit' : rows.capped === true ? 'source-capped' : 'program-analysis-incomplete'),
    capped: rows.capped === true,
    queryLimited: rows.queryLimited === true,
  };
}

function failClosed(result, sources) {
  const states = sources.map(incompleteState).filter(Boolean);
  if (!states.length) return result;
  return {
    ...result,
    total: null,
    complete: false,
    truncated: true,
    reason: states.find((state) => state.reason)?.reason || 'program-analysis-incomplete',
    capped: states.some((state) => state.capped),
    queryLimited: states.some((state) => state.queryLimited),
  };
}

export function createHardenedAgentTools(context, options) {
  const observed = new Map();
  const base = createBaseAgentTools({ ...context, program: observeProgram(context?.program, observed) }, options);

  const callers = base.get_callers?.bind(base);
  if (callers) base.get_callers = async (...args) => {
    observed.delete('callersOf');
    return failClosed(await callers(...args), [observed.get('callersOf')]);
  };

  const callees = base.get_callees?.bind(base);
  if (callees) base.get_callees = async (...args) => {
    observed.delete('calleesOf');
    return failClosed(await callees(...args), [observed.get('calleesOf')]);
  };

  const xrefs = base.get_xrefs?.bind(base);
  if (xrefs) base.get_xrefs = async (...args) => {
    observed.delete('refSitesTo'); observed.delete('functionsReferencing');
    const result = failClosed(await xrefs(...args), [observed.get('refSitesTo'), observed.get('functionsReferencing')]);
    if (!result.complete && result.totals) {
      const sitesIncomplete = incompleteState(observed.get('refSitesTo'));
      const functionsIncomplete = incompleteState(observed.get('functionsReferencing'));
      result.totals = {
        sites: sitesIncomplete ? null : result.totals.sites,
        functions: functionsIncomplete ? null : result.totals.functions,
      };
    }
    return result;
  };
  return base;
}
