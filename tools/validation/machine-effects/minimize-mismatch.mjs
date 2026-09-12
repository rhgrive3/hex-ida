import { createCorpusCase, validateCorpusCase } from './oracle-schema.mjs';
import { createReferenceOracle, runIndependentComparison } from './oracle-runner.mjs';

const VERSION = 'machine-effects-input-mismatch-minimizer/v1';

/** Reduce a real defined-bit mismatch while keeping instruction bytes, model,
 * observables and masks fixed. Each trial regenerates expected state with the
 * existing independent reference model and reruns the production subject.
 * This is single-bit input reduction, not instruction deletion or a global
 * minimum. Limited/cancelled runs retain the last confirmed counterexample.
 */
export async function minimizeMachineEffectsMismatch({ corpusCase, subject, signal,
  maxComparisons = 256, timeoutMs = 30000 } = {}) {
  const startedAt = performance.now();
  const original = validateCorpusCase(corpusCase);
  if (typeof subject !== 'function') throw new TypeError('minimizer-subject-required');
  if (!Number.isSafeInteger(maxComparisons) || maxComparisons < 1 || maxComparisons > 4096
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw new TypeError('minimizer-invalid-budget');
  }
  const controller = new AbortController();
  let stopped = null, comparisons = 0, current = original, result = null, signature = null;
  const steps = [];
  let stopResolve;
  const stopPromise = new Promise(resolve => { stopResolve = resolve; });
  const stop = reason => {
    if (stopped) return;
    stopped = reason;
    controller.abort();
    stopResolve(null);
  };
  const cancelled = () => stop('cancelled');
  signal?.addEventListener('abort', cancelled, { once: true });
  if (signal?.aborted) cancelled();
  const timer = setTimeout(() => stop('resource-limited'), Math.max(1, timeoutMs - (performance.now() - startedAt)));
  const finish = (status, reason, minimal = false) => Object.freeze({
    version: VERSION, status, reason, reductionScope: 'lhs-rhs-initial-register-bit-clearing',
    originalCaseId: original.caseId, caseValue: result?.status === 'mismatch' ? current : null,
    comparison: result, comparisons, steps: Object.freeze(steps),
    minimality: minimal ? 'single-bit-clearing-fixed-point' : 'not-established', passContribution: 0,
  });
  const oracle = createReferenceOracle({ identity: original.oracleIdentity, version: original.oracleVersion,
    toolchainIdentity: original.provenance.toolchainIdentity, provenance: original.provenance });
  const compare = async candidate => {
    if (performance.now() - startedAt >= timeoutMs) stop('resource-limited');
    if (stopped) return null;
    if (comparisons >= maxComparisons) { stop('resource-limited'); return null; }
    comparisons++;
    const comparison = await Promise.race([runIndependentComparison({ corpusCase: candidate, subject, oracle,
      signal: controller.signal, budgets: { timeoutMs } }), stopPromise]);
    // Fulfilled comparison promises may monopolize the microtask queue; a
    // timer alone cannot enforce the aggregate deadline in that case.
    if (performance.now() - startedAt >= timeoutMs) stop('resource-limited');
    return stopped ? null : comparison;
  };
  const sameMismatch = value => value?.status === 'mismatch' && value.mismatches.some(mismatch =>
    mismatch.reason === 'defined-bit-mismatch' && mismatch.observable === signature);
  try {
    if (original.expectedOutcome.kind !== 'normal') return finish('unsupported', 'normal-state-required');
    result = await compare(original);
    if (stopped) return finish(stopped, 'comparison-interrupted');
    signature = result?.mismatches.find(mismatch => mismatch.reason === 'defined-bit-mismatch')?.observable;
    if (result?.status === 'exact/equivalent') return finish('not-mismatch', 'no-defined-bit-counterexample');
    if (result?.status !== 'mismatch' || !signature) return finish('inconclusive', 'no-confirmed-defined-bit-counterexample');
    const registers = [...new Set([original.operation.lhs, original.operation.rhs])].sort();
    const trial = async (register, value) => {
      const input = structuredClone(current);
      delete input.caseId;
      input.initialState.registers[register] = `0x${value.toString(16).padStart(16, '0')}`;
      // Never reuse the old expected value after changing an input.
      const reference = await oracle.evaluate(input, { signal: controller.signal });
      if (stopped || !reference.state) return false;
      input.expectedState = reference.state;
      const candidate = createCorpusCase(input);
      const comparison = await compare(candidate);
      if (stopped) return false;
      if (sameMismatch(comparison)) {
        steps.push(Object.freeze({ fromCaseId: current.caseId, toCaseId: candidate.caseId, register,
          before: current.initialState.registers[register], after: candidate.initialState.registers[register],
          comparisonId: comparison.resultId, observable: signature }));
        current = candidate;
        result = comparison;
        return true;
      }
      // Unknown, missing state and different failures cannot establish that a
      // smaller input stops reproducing this counterexample.
      if (comparison.status !== 'exact/equivalent'
          && !(comparison.status === 'mismatch' && comparison.mismatches.every(mismatch => mismatch.reason === 'defined-bit-mismatch'))) {
        stop('inconclusive');
      }
      return false;
    };
    let changed;
    do {
      changed = false;
      for (const register of registers) {
        let value = BigInt(current.initialState.registers[register]);
        if (value !== 0n && await trial(register, 0n)) changed = true;
        if (stopped) return finish(stopped, 'reduction-interrupted');
        for (let bit = 63; bit >= 0; bit--) {
          value = BigInt(current.initialState.registers[register]);
          const mask = 1n << BigInt(bit);
          if ((value & mask) !== 0n && await trial(register, value & ~mask)) changed = true;
          if (stopped) return finish(stopped, 'reduction-interrupted');
        }
      }
    } while (changed);
    const replay = await compare(current);
    if (stopped) return finish(stopped, 'final-replay-interrupted');
    if (!sameMismatch(replay)) return finish('inconclusive', 'final-counterexample-not-reproduced');
    result = replay;
    return finish('minimized', 'defined-bit-mismatch-preserved', true);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancelled);
  }
}
