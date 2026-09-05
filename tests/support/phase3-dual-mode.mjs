import os from 'node:os';

function normalizedSwitch(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (['0','false','off','no'].includes(text)) return false;
  if (['1','true','on','yes'].includes(text)) return true;
  return null;
}

/**
 * The v2 and legacy Phase 3 command corpora are independent child-process proof
 * families. On a sufficiently wide local host they can overlap without reducing
 * either denominator. Hosted CI remains conservative because runner contention is
 * externally variable and exact-head evidence must not gain a new timing flake.
 */
export function resolvePhase3DualMode({ env = process.env, availableParallelism = os.availableParallelism() } = {}) {
  const available = Number.isSafeInteger(availableParallelism) && availableParallelism >= 1 ? availableParallelism : 1;
  if (env?.GITHUB_ACTIONS) return Object.freeze({ enabled:false, available, perCorpusConcurrency:1, reason:'hosted-ci' });

  const requested = normalizedSwitch(env?.HEX_PHASE3_DUAL_MODE_PARALLEL);
  if (requested === false) return Object.freeze({ enabled:false, available, perCorpusConcurrency:1, reason:'disabled' });
  const minimum = requested === true ? 6 : 8;
  if (available < minimum) return Object.freeze({ enabled:false, available, perCorpusConcurrency:1, reason:'insufficient-parallelism' });

  // Reserve two logical CPUs for the parent process, timers and OS work. At 8
  // CPUs this yields 3+3 corpus children; at >=10 CPUs it caps at 4+4.
  const perCorpusConcurrency = Math.max(2, Math.min(4, Math.floor((available - 2) / 2)));
  return Object.freeze({ enabled:true, available, perCorpusConcurrency, reason:requested === true ? 'explicit' : 'local-wide-host' });
}
