/* QueryAPI completeness facade for the AI tool registry. */
export { ToolRegistry } from './registry-query-base.js';

import { createHexToolRegistry as createBaseHexToolRegistry } from './registry-query-base.js';

function addressText(value) {
  if (value == null) return null;
  try { return `0x${BigInt(value).toString(16)}`; } catch { return String(value); }
}
function replace(registry, name, execute) {
  const current = registry.get(name);
  if (!current) return;
  registry.tools.set(name, Object.freeze({ ...current, execute }));
}

function isCanonicalRuntimeConfirmation(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  if (Object.hasOwn(result, 'verified')) return false;
  if (result.verification && typeof result.verification === 'object' && !Array.isArray(result.verification)
      && Object.hasOwn(result.verification, 'verified')) return false;
  const verdict = result.verdict;
  const coverage = result.coverage;
  const cases = result.cases;
  if (!verdict || typeof verdict !== 'object' || Array.isArray(verdict) || verdict.status !== 'confirmed') return false;
  if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) return false;
  if (coverage.complete !== true || coverage.truncated !== false || coverage.cancelled !== false || coverage.unsupported !== 0) return false;
  if (!Number.isSafeInteger(coverage.planned) || coverage.planned < 3) return false;
  if (!Number.isSafeInteger(coverage.executed) || coverage.executed !== coverage.planned) return false;
  if (!Array.isArray(cases) || cases.length !== coverage.planned) return false;
  if (!cases.every((entry) => entry && typeof entry === 'object' && entry.comparison?.status === 'supported')) return false;
  return verdict.supported === coverage.planned && verdict.contradicted === 0 && verdict.total === coverage.planned;
}

function bridgeRuntimeVerifierAuthority(registry) {
  const current = registry.get('verify_runtime_hypothesis');
  if (!current) return;
  replace(registry, 'verify_runtime_hypothesis', async (args, callOptions = {}) => {
    const result = await current.execute(args, callOptions);
    if (result?.verified === true || result?.verification?.verified === true) return result;
    if (!isCanonicalRuntimeConfirmation(result)) return result;
    const verification = result.verification && typeof result.verification === 'object' && !Array.isArray(result.verification)
      ? result.verification
      : {};
    return {
      ...result,
      verified: true,
      verification: { ...verification, verified: true, authority: 'runtime-confirmed-verdict' },
    };
  });
}

export function createHexToolRegistry(context = {}, options = {}) {
  const registry = createBaseHexToolRegistry(context, options);
  bridgeRuntimeVerifierAuthority(registry);
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
