export function createAttemptDeadline(deadlineMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(new Error('The network attempt exceeded its deadline.')); }, deadlineMs);
  let disposed = false;
  return Object.freeze({
    signal: controller.signal,
    dispose() {
      // Clearing the timer is all a completed attempt needs. Aborting after
      // success races Chromium's body-stream finalization (BodyStreamBuffer
      // was aborted), so the signal must survive a clean attempt.
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
    },
  });
}

export function parseContentLength(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : null;
}

export async function readBoundedBytes(response, { maxBytes, exactBytes = null, overBudgetMessage, mismatchMessage }) {
  const declared = parseContentLength(response.headers?.get?.('content-length') ?? null);
  const streamCeiling = exactBytes === null ? maxBytes : Math.min(maxBytes, exactBytes);
  if (declared !== null && (declared > maxBytes || (exactBytes !== null && declared !== exactBytes))) {
    await discardResponseBody(response);
    throw new Error(declared > maxBytes ? overBudgetMessage : mismatchMessage);
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    await discardResponseBody(response);
    throw new Error('A bounded response body stream is required.');
  }
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = value instanceof Uint8Array
        ? value
        : ArrayBuffer.isView(value)
          ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
          : new Uint8Array(value);
      if (total + bytes.byteLength > streamCeiling) {
        bytes.fill(0);
        zeroChunks(chunks);
        throw new Error(exactBytes !== null && streamCeiling === exactBytes ? mismatchMessage : overBudgetMessage);
      }
      total += bytes.byteLength;
      chunks.push(bytes);
    }
  } catch (error) {
    await cancelReader(reader, error);
    zeroChunks(chunks);
    throw error;
  }
  await cancelReader(reader, undefined);
  if (exactBytes !== null && total !== exactBytes) {
    zeroChunks(chunks);
    throw new Error(mismatchMessage);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  zeroChunks(chunks);
  return output;
}

export async function readBoundedText(response, options) {
  const bytes = await readBoundedBytes(response, options);
  const text = new TextDecoder().decode(bytes);
  bytes.fill(0);
  return text;
}

async function discardResponseBody(response) {
  try { await response.body?.cancel?.(); } catch { /* best effort */ }
  try { await response.arrayBuffer?.(); } catch { /* best effort */ }
}

async function cancelReader(reader, reason) {
  try { if (reason !== undefined) await reader.cancel(reason); } catch { /* best effort */ }
  try { reader.releaseLock(); } catch { /* best effort */ }
}

function zeroChunks(chunks) {
  for (const chunk of chunks) chunk.fill(0);
  chunks.length = 0;
}
