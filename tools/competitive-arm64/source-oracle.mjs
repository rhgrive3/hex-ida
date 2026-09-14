/** Tiny independent mathematical observation checker, not a static analyzer.
 * Source hash/build trace must be bound separately before benchmark admission.
 */
export function checkU64Add7(samples) {
  if (!Array.isArray(samples) || !samples.length || samples.length > 4096) throw new TypeError('oracle-sample-count');
  const max = (1n << 64n) - 1n;
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    if (!sample || Object.keys(sample).sort().join('|') !== 'input|output'
      || ![sample.input, sample.output].every(value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 20)) throw new TypeError('oracle-u64-scalar');
    const input = BigInt(sample.input), output = BigInt(sample.output);
    if (input > max || output > max) throw new TypeError('oracle-u64-width');
    if (((input + 7n) & max) !== output) return { status: 'rejected', firstDivergence: index, checker: 'u64-add-7/v1', scope: 'finite-observations-only' };
  }
  return { status: 'verified', samples: samples.length, checker: 'u64-add-7/v1', scope: 'finite-observations-only', staticProof: false };
}
