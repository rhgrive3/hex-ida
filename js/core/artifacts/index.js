export * from './contracts.js';
export * from './hot-cache.js';
export * from './backends.js';
export * from './store.js';

export const PAGED_ARTIFACT_QUERY_VERSION = 'hex-paged-artifact-query-v1';

function nonNegativeSafeInteger(value, code) {
  if (typeof value !== 'number') throw new RangeError(code);
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(code);
  return value;
}

function nonNegativeOffset(value) {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new RangeError('artifact-page-offset-invalid');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('artifact-page-offset-invalid');
    return BigInt(value);
  }
  if (typeof value !== 'string' || !value.trim()) throw new RangeError('artifact-page-offset-invalid');
  let offset;
  try { offset = BigInt(value.trim()); }
  catch { throw new RangeError('artifact-page-offset-invalid'); }
  if (offset < 0n) throw new RangeError('artifact-page-offset-invalid');
  return offset;
}

export async function readArtifactPage(source, {
  offset = 0n,
  length,
  maxPageBytes = 256 * 1024,
  signal = null,
  budget = null,
} = {}) {
  const max = nonNegativeSafeInteger(maxPageBytes, 'artifact-page-max-size-invalid');
  const n = nonNegativeSafeInteger(length, 'artifact-page-size-invalid');
  if (n > max) throw new RangeError('artifact-page-size-invalid');
  const normalizedOffset = nonNegativeOffset(offset);
  budget?.consume?.('pagesFetched', 1);
  budget?.consume?.('bytesRead', n);
  budget?.checkCancelled?.();
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  const bytes = await source.readExactly(normalizedOffset, n, { signal });
  budget?.checkCancelled?.();
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  return Object.freeze({ offset:normalizedOffset, length:bytes.byteLength, bytes });
}
