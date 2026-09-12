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
    (buffer) => ({ buffer }),
    (error) => ({ error }),
  );
  const writer = stream.writable.getWriter();
  let writeError;
  try {
    await writer.write(chunk);
    await writer.close();
  } catch (error) {
    writeError = error;
  }
  const settled = await output;
  if (writeError) throw writeError;
  if (settled.error) throw settled.error;
  return new Uint8Array(settled.buffer);
}

function isChunkTypeError(error) {
  const message = String(error?.message || error || '');
  return error instanceof TypeError || /arraybuffer|typedarray|dataview|chunk|invalid type/i.test(message);
}
