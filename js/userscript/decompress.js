import { toExactArrayBuffer } from './array-buffer.js';

export async function decompressGzipExact(bytes) {
  if (typeof DecompressionStream !== 'function') throw new Error('The protected runtime compression format is unsupported.');
  const exact = toExactArrayBuffer(bytes);
  try {
    return await decompressWithChunk(exact);
  } catch (error) {
    if (!isChunkTypeError(error)) throw error;
    return decompressWithChunk(new Uint8Array(exact));
  }
}

async function decompressWithChunk(chunk) {
  const stream = new DecompressionStream('gzip');
  const output = new Response(stream.readable).arrayBuffer().then(
    (buffer) => ({ ok: true, buffer }),
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
  return new Uint8Array(settled.buffer);
}

function isChunkTypeError(error) {
  const message = String(error?.message || error || '');
  return error instanceof TypeError || /arraybuffer|typedarray|dataview|chunk|invalid type/i.test(message);
}
