import { toExactArrayBuffer } from './array-buffer.js';

export const DEFAULT_MAX_PLAINTEXT_BYTES = 64 * 1024 * 1024;

export async function decompressGzipExact(bytes, maxOutputBytes = DEFAULT_MAX_PLAINTEXT_BYTES) {
  if (typeof DecompressionStream !== 'function') throw new Error('The protected runtime compression format is unsupported.');
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) throw new TypeError('The decompression output budget must be a positive safe integer.');
  const exact = toExactArrayBuffer(bytes);
  try {
    return await decompressWithChunk(exact, maxOutputBytes);
  } catch (error) {
    if (!isChunkTypeError(error)) throw error;
    return decompressWithChunk(new Uint8Array(exact), maxOutputBytes);
  }
}

async function decompressWithChunk(chunk, maxOutputBytes) {
  const stream = new DecompressionStream('gzip');
  const output = collectCappedOutput(stream.readable, maxOutputBytes).then(
    (bytes) => ({ ok: true, bytes }),
    (error) => ({ ok: false, error }),
  );
  const writer = stream.writable.getWriter();
  try {
    await writer.write(chunk);
    await writer.close();
  } catch (error) {
    // Observe abort/readable failures without waiting for an open readable to settle.
    // A rejected chunk can leave the stream open while the caller retries its type.
    try { Promise.resolve(writer.abort?.(error)).catch(() => {}); } catch {}
    throw error;
  }
  const settled = await output;
  if (!settled.ok) throw settled.error;
  return settled.bytes;
}

async function collectCappedOutput(readable, maxOutputBytes) {
  const reader = readable.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxOutputBytes) throw new RangeError('The protected runtime exceeded its decompression byte budget.');
      chunks.push(value);
    }
  } catch (error) {
    try { await reader.cancel(error); } catch { /* best effort */ }
    for (const chunk of chunks) chunk.fill(0);
    chunks.length = 0;
    throw error;
  }
  try { reader.releaseLock(); } catch { /* best effort */ }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

function isChunkTypeError(error) {
  const message = String(error?.message || error || '');
  return error instanceof TypeError || /arraybuffer|typedarray|dataview|chunk|invalid type/i.test(message);
}
