/* QueryAPI completeness facade for the AI tool registry. */
export { ToolRegistry } from './registry-query-base.js';

import { createHexToolRegistry as createBaseHexToolRegistry } from './registry-query-base.js';
import { irFor } from '../../ir.js';
import { AIError } from '../schema.js';
import { verifyConditionalEdgeFeasibility, verifyBoundedEquivalence } from '../../symbolic/verify/index.js';
import { defaultSolverRegistry } from '../../symbolic/solver/registry.js';

function addressText(value) {
  if (value == null) return null;
  try { return `0x${BigInt(value).toString(16)}`; } catch { return String(value); }
}
function replace(registry, name, execute) {
  const current = registry.get(name);
  if (!current) return;
  registry.tools.set(name, Object.freeze({ ...current, execute }));
}

async function canonicalVerificationIr(registry, functionAddress) {
  if (!functionAddress) return null;
  const model = await registry.legacyTools?.__loader?.get(functionAddress);
  return model ? irFor(model) : null;
}

function rejectUntrustedExpr(value, label) {
  if (value == null) return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) rejectUntrustedExpr(value[i], `${label}[${i}]`);
    return value;
  }
  if (!value || typeof value !== 'object') return value;
  if (typeof value.kind === 'string' && value.sort && typeof value.sort === 'object') {
    throw new AIError('invalid_tool_call', `${label} must come from canonical Semantic IR; caller-supplied Expr DAG objects are not accepted.`);
  }
  return value;
}

function bindCanonicalTarget(value, ir, label) {
  rejectUntrustedExpr(value, label);
  if (value == null || !ir) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AIError('invalid_tool_call', `${label} must identify a canonical Semantic IR instruction.`);
  }
  const instructions = Array.isArray(ir.instructions) ? ir.instructions : [];
  const identityKeys = ['id', 'semanticNodeId', 'sourceEntityId'];
  const supplied = identityKeys.filter((key) => value[key] != null);
  if (supplied.length === 0) {
    throw new AIError('invalid_tool_call', `${label} is not bound to a canonical Semantic IR instruction.`);
  }
  const matches = instructions.filter((candidate) => supplied.every((key) => candidate?.[key] === value[key]));
  if (matches.length !== 1) {
    throw new AIError('invalid_tool_call', `${label} does not identify exactly one canonical Semantic IR instruction.`);
  }
  return matches[0];
}

function installVerificationBoundary(registry) {
  const inspect = registry.get('inspect_function_region')?.execute;
  if (inspect) replace(registry, 'inspect_function_region', async (args, callOptions = {}) => {
    const result = await inspect(args, callOptions);
    if (args?.view !== 'semantic-ir' || !Array.isArray(result?.results)) return result;
    const ir = await canonicalVerificationIr(registry, args.functionAddress);
    if (!ir) return result;
    const instructions = Array.isArray(ir.instructions) ? ir.instructions : [];
    return {
      ...result,
      results: result.results.map((row) => {
        const candidate = instructions.find((inst) => row?.id != null && inst?.id === row.id);
        if (!candidate) return row;
        return {
          ...row,
          ...(candidate.sub !== undefined ? { sub:candidate.sub } : {}),
          ...(candidate.comparison !== undefined ? { comparison:candidate.comparison } : {}),
          ...(candidate.signed !== undefined ? { signed:candidate.signed } : {}),
        };
      }),
    };
  });

  replace(registry, 'verify_edge_feasibility', async ({ functionAddress, fromBlock, toBlock, edgeCondition, preconditions }, callOptions = {}) => {
    const ir = await canonicalVerificationIr(registry, functionAddress);
    const backend = defaultSolverRegistry.getDefaultBackend();
    return verifyConditionalEdgeFeasibility({
      ir,
      fromBlock,
      toBlock,
      edgeCondition: bindCanonicalTarget(edgeCondition, ir, 'edgeCondition'),
      preconditions: rejectUntrustedExpr(preconditions, 'preconditions'),
      backend,
      options: { signal:callOptions.signal, timeoutMs:callOptions.timeoutMs },
    });
  });

  replace(registry, 'verify_bounded_equivalence', async ({ beforeFunctionAddress, afterFunctionAddress, beforeTarget, afterTarget, preconditions }, callOptions = {}) => {
    const beforeIr = await canonicalVerificationIr(registry, beforeFunctionAddress);
    const afterIr = await canonicalVerificationIr(registry, afterFunctionAddress);
    const backend = defaultSolverRegistry.getDefaultBackend();
    return verifyBoundedEquivalence({
      beforeIr,
      afterIr,
      beforeTarget: bindCanonicalTarget(beforeTarget, beforeIr, 'beforeTarget'),
      afterTarget: bindCanonicalTarget(afterTarget, afterIr, 'afterTarget'),
      preconditions: rejectUntrustedExpr(preconditions, 'preconditions'),
      backend,
      options: { signal:callOptions.signal, timeoutMs:callOptions.timeoutMs },
    });
  });

  return registry;
}

export function createHexToolRegistry(context = {}, options = {}) {
  const registry = installVerificationBoundary(createBaseHexToolRegistry(context, options));
  if (context?.analysisAuthority !== 'AnalysisQueryAPI') return registry;

  if (typeof context.getDecompile === 'function') {
    replace(registry, 'decompile_function', async ({ functionAddress }) => {
      const value = await context.getDecompile(functionAddress, { signal:registry.executionSignal });
      const text = typeof value?.text === 'string' ? value.text : '';
      const preview = text.slice(0, 30000);
      const previewTruncated = text.length > preview.length;
      const complete = value?.complete === true && !previewTruncated;
      return {
        functionAddress:addressText(functionAddress),
        pseudocodeExcerpt:preview,
        total:text.length,
        returned:preview.length,
        complete,
        truncated:!complete,
        unsupported:value?.unsupported === true,
        reason:complete ? null : (previewTruncated ? 'preview-limit' : (value?.reason || 'decompile-incomplete')),
        trust:'untrusted-data',
        analysisAuthority:'AnalysisQueryAPI',
      };
    });
  }

  return registry;
}

export default createHexToolRegistry;
