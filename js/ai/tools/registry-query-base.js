import { createHexToolRegistry as createBaseHexToolRegistry, ToolRegistry } from './registry-base.js';
import { shortHash, stableSerialize } from './paging/cursor.js';
import { addressText } from '../validation.js';

export { ToolRegistry };

function nonNegativeSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function queryContext(context) {
  return context?.analysisAuthority === 'AnalysisQueryAPI';
}

function pageRows(value) {
  return Array.isArray(value?.results) ? value.results : [];
}

function continuation(value, offset, cursorFactory) {
  const out = { ...(value || {}) };
  const rows = pageRows(out);
  out.offset = nonNegativeSafeInteger(out.offset) ?? offset;
  const returned = nonNegativeSafeInteger(out.returned);
  out.returned = returned === rows.length ? returned : rows.length;
  if (out.complete !== true && rows.length && !out.continuation && typeof cursorFactory === 'function') {
    out.continuation = { cursor:cursorFactory(offset + rows.length) };
  }
  return out;
}

function replace(registry, name, execute) {
  const current = registry.get(name);
  if (!current) return;
  registry.tools.set(name, Object.freeze({ ...current, execute }));
}

function queryPaging(registry, tool, params, cursor) {
  const codec = registry.observationStore.cursorCodec;
  const hash = shortHash(stableSerialize(params));
  let offset = 0;
  if (cursor) {
    const payload = codec.decode(cursor, {
      bindingKey:registry.observationStore.binding().key,
      kind:'tool-page',
    });
    if (payload.tool !== tool || payload.paramsHash !== hash) throw new Error('cursor-parameter-mismatch');
    offset = nonNegativeSafeInteger(payload.offset);
    if (offset == null) throw new Error('cursor-offset-invalid');
  }
  const makeCursor = (next) => codec.encode({
    kind:'tool-page',
    bindingKey:registry.observationStore.binding().key,
    tool,
    paramsHash:hash,
    offset: normalizeCursorOffset(next),
  });
  return { offset, makeCursor };
}

function normalizeCursorOffset(value) {
  const normalized = nonNegativeSafeInteger(value);
  if (normalized == null) throw new Error('cursor-offset-invalid');
  return normalized;
}

function markQueryAuthority(value) {
  return value && typeof value === 'object'
    ? { ...value, analysisAuthority:'AnalysisQueryAPI' }
    : value;
}

function installQueryOverrides(registry, context) {
  if (!queryContext(context)) return registry;

  const originalGetFunction = registry.get('get_function')?.execute;
  if (originalGetFunction) replace(registry, 'get_function', async (args) =>
    markQueryAuthority(await originalGetFunction(args)));

  const originalCurrent = registry.get('get_current_function')?.execute;
  if (originalCurrent) replace(registry, 'get_current_function', async (args) =>
    markQueryAuthority(await originalCurrent(args)));

  const originalInspect = registry.get('inspect_function_region')?.execute;
  if (originalInspect) replace(registry, 'inspect_function_region', async (args) => {
    if (args.view !== 'assembly' || typeof context.getInstructions !== 'function') return originalInspect(args);
    const params = {
      functionAddress:args.functionAddress,
      view:args.view,
      aroundInstructionId:args.aroundInstructionId ?? null,
      radius:args.radius ?? null,
    };
    const paging = queryPaging(registry, 'inspect_function_region', params, args.cursor);
    const count = Math.max(1, Math.min(500, Number(args.count || (args.radius ? args.radius * 2 + 1 : 160))));
    let offset = args.cursor ? paging.offset : Math.max(0, Number(args.start) || 0);
    // Mirror the base implementation: without a cursor, anchor the window on
    // the requested instruction instead of silently returning the first page.
    if (!args.cursor && args.aroundInstructionId != null) {
      const radius = Math.max(0, Math.min(250, Number(args.radius ?? 20) || 0));
      const target = Number(args.aroundInstructionId);
      const basis = [];
      let scannedComplete = false;
      // Bounded full-corpus scan so targets beyond the first window are still
      // anchored. The scan budget is an upper bound on a single window, never
      // a silent truncation of the searched corpus.
      for (let pageOffset = 0, pages = 0; pages < 40 && basis.length < 20000; pages++) {
        const window = await context.getInstructions(args.functionAddress, {
          offset: pageOffset,
          limit: 500,
          signal:registry.executionSignal,
        });
        const rows = pageRows(window);
        if (!rows.length) { scannedComplete = true; break; }
        basis.push(...rows);
        pageOffset += rows.length;
        if (window?.complete === true) { scannedComplete = true; break; }
        if (rows.some((item) => Number(item?.id ?? item?.instructionId ?? item?.row) === target)) break;
      }
      const index = basis.findIndex((item) =>
        Number(item?.id ?? item?.instructionId ?? item?.row) === target);
      if (index >= 0) offset = Math.max(0, index - radius);
      else if (!scannedComplete) {
        // The instruction corpus was not exhausted, so absence here is NOT a
        // proof of absence: refuse to masquerade the first page as an anchored
        // result (#5671; fail-closed parity with the find_paths/#5662 rule).
        return {
          functionAddress:addressText(args.functionAddress),
          view:'assembly',
          results:[],
          offset,
          returned:0,
          total:null,
          complete:false,
          truncated:true,
          reason:'anchor-unresolved',
          analysisAuthority:'AnalysisQueryAPI',
        };
      }
    }
    const page = await context.getInstructions(args.functionAddress, {
      offset,
      limit:count,
      signal:registry.executionSignal,
    });
    const rows = pageRows(page).map((row, index) => ({
      id:row?.id ?? row?.instructionId ?? offset + index,
      row:row?.row ?? null,
      address:addressText(row?.address),
      mnemonic:row?.mnemonic ?? '',
      operands:row?.operands ?? '',
    }));
    const complete = page?.complete === true;
    const out = {
      functionAddress:addressText(args.functionAddress),
      view:'assembly',
      results:rows,
      offset,
      returned:rows.length,
      total:Number.isFinite(Number(page?.total)) ? Number(page.total) : null,
      complete,
      truncated:!complete,
      reason:complete ? null : (page?.reason || 'result-limit'),
      analysisAuthority:'AnalysisQueryAPI',
    };
    if (!complete && rows.length) out.continuation = { cursor:paging.makeCursor(offset + rows.length) };
    return out;
  });

  for (const [tool, method, key, fallbackLimit] of [
    ['get_xrefs', 'getXrefs', 'address', 200],
    ['get_callers', 'getCallers', 'address', 100],
    ['get_callees', 'getCallees', 'address', 100],
  ]) {
    if (typeof context[method] !== 'function') continue;
    replace(registry, tool, async (args) => {
      const params = { [key]:args[key] };
      const paging = queryPaging(registry, tool, params, args.cursor);
      const limit = Math.max(1, Number(args.limit) || fallbackLimit);
      const value = await context[method](args[key], {
        limit,
        offset:paging.offset,
        signal:registry.executionSignal,
      });
      return continuation(value, paging.offset, paging.makeCursor);
    });
  }

  if (typeof context.getCallers === 'function' && typeof context.getCallees === 'function') {
    replace(registry, 'get_related_functions', async ({ functionAddress, limit = 24 }) => {
      const [callers, callees] = await Promise.all([
        context.getCallers(functionAddress, { limit, offset:0, signal:registry.executionSignal }),
        context.getCallees(functionAddress, { limit, offset:0, signal:registry.executionSignal }),
      ]);
      return {
        functionAddress:addressText(functionAddress),
        callers:pageRows(callers),
        callees:pageRows(callees),
        complete:callers?.complete === true && callees?.complete === true,
        truncated:callers?.complete !== true || callees?.complete !== true,
        reason:callers?.reason || callees?.reason || null,
        analysisAuthority:'AnalysisQueryAPI',
      };
    });
  }

  if (typeof context.findPaths === 'function') {
    replace(registry, 'find_paths', async ({ from, to, maxDepth = 6, maxPaths = 8, maxVisited = 10000 }) => {
      const value = await context.findPaths(from, to, {
        maxDepth,
        maxPaths,
        maxVisited,
        signal:registry.executionSignal,
      });
      return { ...(value || {}), analysisAuthority:'AnalysisQueryAPI' };
    });
  }

  return registry;
}

export function createHexToolRegistry(context = {}, options = {}) {
  return installQueryOverrides(createBaseHexToolRegistry(context, options), context);
}

export default createHexToolRegistry;
