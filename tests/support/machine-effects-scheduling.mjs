import path from 'node:path';

// Runtime-cost hints only. They affect which independent child starts first,
// never discovery, denominator, per-file assertions, result identity or output order.
// These are the large finite-denominator files that historically dominate the
// tail of the bounded MachineEffects worker pool.
const PRIORITY = Object.freeze({
  'arm64e-a64-delegation-denominator.test.mjs': 120,
  'arm64-a64-system-denominator.test.mjs': 110,
  'x86-long64-lea-denominator.test.mjs': 105,
  'x86-long64-integer-denominator.test.mjs': 100,
  'x86-long64-memory-denominator.test.mjs': 95,
  'arm64-a64-memory-denominator.test.mjs': 90,
  'arm64-a64-simd-denominator.test.mjs': 85,
  'x86-long64-string-denominator.test.mjs': 80,
  'x86-long64-decoder-denominator.test.mjs': 75,
  'riscv64-rv64imc-denominator.test.mjs': 70,
  'a2-denominator.test.mjs': 65,
});

export function machineEffectSchedulingPriority(file) {
  return PRIORITY[path.basename(String(file ?? ''))] ?? 0;
}

/**
 * Stable longest-first work queue. `index` is always the original canonical
 * filename-order slot, so callers publish evidence/results in the historical
 * order even though heavy independent processes start earlier.
 */
export function scheduleMachineEffectFiles(files) {
  if (!Array.isArray(files)) throw new TypeError('machine-effects scheduler: files must be an array');
  return files
    .map((file, index) => ({ file, index, priority: machineEffectSchedulingPriority(file) }))
    .sort((left, right) => right.priority - left.priority || left.index - right.index);
}
