'use strict';

importScripts('./capstone-structured.js', '../../../../capstone.js');

const MAX_DECODE_BYTES = 1024 * 1024;
let decoderPromise = null;
let semanticModulePromise = null;
let provenanceModulePromise = null;
let processing = false;
const queue = [];
const cancelledIds = new Set();

function exactAddress(value, code) {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(?:0[xX][0-9a-fA-F]+|0|[1-9]\d*)$/.test(value)) {
    const parsed = BigInt(value);
    if (parsed >= 0n) return parsed;
  }
  throw new TypeError(code);
}

function exactLength(row) {
  const value = row.length ?? row.size;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 15) {
    throw new TypeError('x86-semantic-function-decoder-revalidation-length-invalid');
  }
  return value;
}

function serializedRows(input) {
  const source = input?.instructions;
  if (!Array.isArray(source) || source.length === 0) {
    throw new TypeError('x86-semantic-function-decoder-revalidation-instructions-required');
  }
  const rows = [];
  let totalBytes = 0;
  for (const row of source) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new TypeError('x86-semantic-function-decoder-revalidation-row-required');
    }
    const address = exactAddress(row.address, 'x86-semantic-function-decoder-revalidation-address-invalid');
    const bytes = row.rawBytes instanceof Uint8Array ? row.rawBytes.slice() : null;
    const length = exactLength(row);
    if (!bytes || bytes.length !== length) {
      throw new TypeError('x86-semantic-function-decoder-revalidation-bytes-invalid');
    }
    totalBytes += length;
    if (totalBytes > MAX_DECODE_BYTES) throw new RangeError('x86-semantic-function-decoder-revalidation-too-large');
    rows.push(Object.freeze({ address, length, bytes, origin:row.origin ?? null }));
  }
  return Object.freeze({ rows:Object.freeze(rows), totalBytes });
}

async function decoder() {
  if (!decoderPromise) decoderPromise = (async () => {
    const M = await MCapstone({
      locateFile:(path) => new URL('../../../../' + path, self.location.href).href,
      print:() => {},
      printErr:() => {},
    });
    globalThis.HexX86CapstoneStructured.verifyVersion(M);
    const handlePointer = M._malloc(4);
    let outputPointer = 0;
    try {
      const rc = M.ccall('cs_open', 'number', ['number','number','pointer'], [
        M.ARCH_X86,
        M.MODE_64 | M.MODE_LITTLE_ENDIAN,
        handlePointer,
      ]);
      if (rc !== 0) throw new Error(`x86-semantic-function-capstone-open:${rc}`);
      const handle = M.getValue(handlePointer, 'i32');
      M.ccall('cs_option', 'number', ['number','number','number'], [handle, M.OPT_SKIPDATA, M.OPT_ON]);
      const detailRc = M.ccall('cs_option', 'number', ['number','number','number'], [handle, M.OPT_DETAIL, M.OPT_ON]);
      if (detailRc !== 0) throw new Error(`x86-semantic-function-capstone-detail:${detailRc}`);
      outputPointer = M._malloc(4);
      return Object.freeze({ M, handle, handlePointer, outputPointer });
    } catch (error) {
      if (outputPointer) M._free(outputPointer);
      try { M.ccall('cs_close', 'number', ['pointer'], [handlePointer]); } catch { /* preserve initialization failure */ }
      M._free(handlePointer);
      throw error;
    }
  })();
  return decoderPromise;
}

function sameBytes(left, right) {
  if (!(left instanceof Uint8Array) || left.length !== right.length) return false;
  for (let index = 0; index < right.length; index++) if (left[index] !== right[index]) return false;
  return true;
}

async function revalidateAndAnalyze(message) {
  const architecture = message?.input?.architecture ?? 'x86_64';
  if (architecture !== 'x86_64') {
    throw new TypeError('x86-semantic-function-decoder-revalidation-architecture-mismatch');
  }
  const serialized = serializedRows(message.input);
  const { M, handle, outputPointer } = await decoder();
  provenanceModulePromise ||= import('./runtime-provenance.js');
  const { markReceiverRevalidatedX86Row } = await provenanceModulePromise;
  if (cancelledIds.has(message.id)) return null;
  const buffer = M._malloc(15);
  const instructions = [];
  try {
    for (const expected of serialized.rows) {
      if (cancelledIds.has(message.id)) return null;
      M.writeArrayToMemory(expected.bytes, buffer);
      const count = M.ccall('cs_disasm', 'number', ['number','number','number','number','number','number'], [
        handle, buffer, expected.bytes.length, expected.address, 1, outputPointer,
      ]);
      const base = count ? M.getValue(outputPointer, 'i32') : 0;
      try {
        if (count !== 1 || !base) {
          throw new Error('x86-semantic-function-decoder-revalidation-incomplete');
        }
        const size = M.getValue(base + 16, 'i16');
        if (size !== expected.length) {
          throw new Error('x86-semantic-function-decoder-revalidation-boundary-mismatch');
        }
        const decoded = globalThis.HexX86CapstoneStructured.parseInstruction(M, handle, base, {
          address:expected.address,
          mode:'long-64',
          origin:expected.origin,
        });
        if (!sameBytes(decoded.rawBytes, expected.bytes)) {
          throw new Error('x86-semantic-function-decoder-revalidation-byte-mismatch');
        }
        instructions.push(markReceiverRevalidatedX86Row(decoded));
      } finally {
        if (base) M.ccall('cs_free', 'void', ['number','number'], [base, count]);
      }
    }
  } finally {
    M._free(buffer);
  }
  if (instructions.length !== serialized.rows.length) {
    throw new Error('x86-semantic-function-decoder-revalidation-incomplete');
  }
  if (cancelledIds.has(message.id)) return null;
  semanticModulePromise ||= import('./semantic-function.js');
  const { analyzeDecodedSemanticFunction } = await semanticModulePromise;
  if (cancelledIds.has(message.id)) return null;
  return await analyzeDecodedSemanticFunction({
    ...message.input,
    architecture:'x86_64',
    decoderSemanticVersion:'capstone-5-x86-structured-v2',
    instructions,
  });
}

async function run(message) {
  try {
    const result = await revalidateAndAnalyze(message);
    if (cancelledIds.delete(message.id) || result == null) return;
    self.postMessage({ id:message.id, ok:true, result });
  } catch (error) {
    if (cancelledIds.delete(message.id)) return;
    self.postMessage({ id:message.id, ok:false, error:error?.message || String(error) });
  }
}

async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    while (queue.length) {
      const message = queue.shift();
      if (cancelledIds.delete(message.id)) continue;
      await run(message);
    }
  } finally {
    processing = false;
  }
}

self.onmessage = (event) => {
  const message = event.data;
  if (!message) return;
  if (message.t === 'cancel') {
    if (message.id != null) {
      cancelledIds.add(message.id);
      const index = queue.findIndex((queued) => queued.id === message.id);
      if (index >= 0) queue.splice(index, 1);
    }
    return;
  }
  if (message.t !== 'semanticFunction') {
    self.postMessage({ id:message.id, ok:false, error:'x86-semantic-function-decoder-revalidation-message-invalid' });
    return;
  }
  queue.push(message);
  processQueue();
};
