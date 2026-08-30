import { fingerprintFunction, FUNCTION_FINGERPRINT_VERSION } from '../fingerprint/index.js';

export const SYMMETRIC_CODE_PROFILE = `canonical-code-evidence/v${FUNCTION_FINGERPRINT_VERSION}`;
const DEFAULT_CHUNK_BYTES = 2 * 1024 * 1024;

function abortError(signal) {
  const error = signal?.reason instanceof Error ? signal.reason : new Error('Binary diff fingerprinting aborted');
  if (!error.name || error.name === 'Error') error.name = 'AbortError';
  if (!error.code) error.code = 'ABORT_ERR';
  return error;
}
function throwIfAborted(signal) { if (signal?.aborted) throw abortError(signal); }
function requestWithSignal(request, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      fn(value);
    };
    const onAbort = () => {
      try { request?.cancel?.(); } catch { /* best effort */ }
      finish(reject, abortError(signal));
    };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener?.('abort', onAbort, { once:true });
    Promise.resolve(request).then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}
function executableRegions(regions) {
  return Array.from(regions || []).filter((region) => {
    try { return region?.exec === true && BigInt(region.size ?? 0) > 0n; } catch { return false; }
  }).sort((a, b) => BigInt(a.vmAddr) < BigInt(b.vmAddr) ? -1 : BigInt(a.vmAddr) > BigInt(b.vmAddr) ? 1 : 0);
}
function regionFor(regions, address) {
  let lo = 0, hi = regions.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const region = regions[mid];
    const start = BigInt(region.vmAddr), end = start + BigInt(region.size);
    if (address < start) hi = mid - 1;
    else if (address >= end) lo = mid + 1;
    else return region;
  }
  return null;
}
function functionDescriptors(symbols, regions, architecture, limit) {
  const funcs = symbols?.funcs || [];
  const total = Number(funcs.length || 0);
  const count = Math.min(total, Math.max(0, Number(limit) || 0));
  const descriptors = [];
  for (let index = 0; index < count; index++) {
    const address = BigInt(funcs[index]);
    const region = regionFor(regions, address);
    if (!region) {
      descriptors.push({ index, address, name:symbols?.nameAt?.(address) || null, size:0, architecture, region:null, end:address, parts:[], missing:true });
      continue;
    }
    const regionEnd = BigInt(region.vmAddr) + BigInt(region.size);
    const next = index + 1 < funcs.length ? BigInt(funcs[index + 1]) : regionEnd;
    const end = next > address && next <= regionEnd ? next : regionEnd;
    descriptors.push({ index, address, name:symbols?.nameAt?.(address) || null, size:Number(end - address), architecture, region, end, parts:[], missing:false });
  }
  return { descriptors, total, count };
}
function concat(parts, length) {
  if (!parts.length) return new Uint8Array(0);
  if (parts.length === 1 && parts[0].length === length) return parts[0];
  const out = new Uint8Array(length);
  let cursor = 0;
  for (const part of parts) { out.set(part, cursor); cursor += part.length; }
  return cursor === length ? out : out.subarray(0, cursor);
}
function finalize(descriptor, output) {
  const bytes = descriptor.missing ? null : concat(descriptor.parts, descriptor.size);
  const fingerprint = fingerprintFunction({
    address:descriptor.address,
    name:descriptor.name,
    size:descriptor.size,
    architecture:descriptor.architecture,
    bytes,
  });
  output[descriptor.index] = Object.freeze({
    ...fingerprint,
    evidenceProfile:SYMMETRIC_CODE_PROFILE,
    evidenceCompleteness:descriptor.missing ? 'partial' : 'complete',
    missingComponents:descriptor.missing ? Object.freeze(['bytes']) : Object.freeze([]),
  });
  descriptor.parts = null;
}

export async function createSymmetricCodeFunctionSet({
  backend,
  symbols,
  regions:rawRegions,
  architecture = 'unknown',
  limit = 350000,
  signal = null,
  onProgress = null,
  chunkBytes = DEFAULT_CHUNK_BYTES,
} = {}) {
  if (!backend?.readAt) throw new TypeError('diff-fingerprint-backend-read-required');
  const regions = executableRegions(rawRegions);
  const arch = String(architecture || 'unknown').toLowerCase();
  const { descriptors, total, count } = functionDescriptors(symbols, regions, arch, limit);
  const output = new Array(count);
  const byRegion = new Map();
  let missing = 0;
  for (const descriptor of descriptors) {
    if (!descriptor.region || descriptor.size <= 0) {
      descriptor.missing = true;
      missing++;
      finalize(descriptor, output);
      continue;
    }
    let rows = byRegion.get(descriptor.region);
    if (!rows) byRegion.set(descriptor.region, rows = []);
    rows.push(descriptor);
  }

  let completed = output.filter(Boolean).length;
  const normalizedChunk = Math.max(64 * 1024, Math.min(8 * 1024 * 1024, Number(chunkBytes) || DEFAULT_CHUNK_BYTES));
  for (const [region, rows] of byRegion) {
    rows.sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
    const start = BigInt(region.vmAddr);
    const lastEnd = rows.reduce((end, row) => row.end > end ? row.end : end, start);
    let cursor = start;
    let rowIndex = 0;
    while (cursor < lastEnd) {
      throwIfAborted(signal);
      const remaining = lastEnd - cursor;
      const length = Number(remaining > BigInt(normalizedChunk) ? BigInt(normalizedChunk) : remaining);
      const request = backend.readAt(cursor, length);
      let response = null;
      try { response = await requestWithSignal(request, signal); }
      catch (error) { if (signal?.aborted || error?.name === 'AbortError') throw error; }
      const chunkEnd = cursor + BigInt(length);
      const bytes = response?.found && response?.bytes ? response.bytes : null;

      while (rowIndex < rows.length && rows[rowIndex].end <= cursor) rowIndex++;
      for (let index = rowIndex; index < rows.length; index++) {
        const row = rows[index];
        if (row.address >= chunkEnd) break;
        const overlapStart = row.address > cursor ? row.address : cursor;
        const overlapEnd = row.end < chunkEnd ? row.end : chunkEnd;
        if (overlapEnd <= overlapStart) continue;
        if (!bytes) row.missing = true;
        else {
          const from = Number(overlapStart - cursor), to = Number(overlapEnd - cursor);
          row.parts.push(bytes.subarray ? bytes.subarray(from, to) : new Uint8Array(bytes).subarray(from, to));
        }
        if (row.end <= chunkEnd && !output[row.index]) {
          if (row.missing) missing++;
          finalize(row, output);
          completed++;
          try { onProgress?.({ phase:'diff-fingerprint', done:completed, all:count, region:region.id }); } catch { /* observer only */ }
        }
      }
      cursor = chunkEnd;
    }
  }

  for (const descriptor of descriptors) {
    if (output[descriptor.index]) continue;
    descriptor.missing = true;
    missing++;
    finalize(descriptor, output);
  }
  const complete = count === total && symbols?.functionStartsComplete === true && missing === 0;
  Object.assign(output, {
    evidenceProfile:SYMMETRIC_CODE_PROFILE,
    fingerprintVersion:FUNCTION_FINGERPRINT_VERSION,
    complete,
    total,
    scanned:count,
    missingEvidence:missing,
    truncationReason:count < total ? 'function-budget' : symbols?.functionStartsComplete !== true ? 'function-discovery-incomplete' : missing ? 'function-bytes-unavailable' : null,
  });
  return output;
}
