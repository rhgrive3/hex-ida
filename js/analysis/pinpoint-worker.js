/**
 * Dedicated ESM Worker for Pinpoint function IR / semantic analysis offload.
 *
 * Receives pre-fetched instruction chunks (or raw row arrays) with native
 * BigInt addresses over structured clone, runs `analyzeFunction` off the main
 * thread, strips the non-cloneable `model.blockOfRow` closure, and posts back
 * `{ id, ok: true, result }` or `{ id, ok: false, error }`.
 *
 * Because the host owns the per-function timeout and AbortSignal, runaway
 * synchronous IR / constant-propagation work can be hard-killed via
 * `worker.terminate()` without blocking the main thread.
 */

import { analyzeFunction } from '../analyze.js';
import { CHUNK_ROWS } from '../backend.js';

function stripNonCloneableModelFields(res) {
  if (!res || typeof res !== 'object') return res;
  const model = res.model;
  if (!model || typeof model !== 'object' || typeof model.blockOfRow !== 'function') {
    return res;
  }
  const { blockOfRow: _blockOfRow, ...cloneableModel } = model;
  return { ...res, model: cloneableModel };
}

function buildWorkerBackendAndRange(addr, rows) {
  if (Array.isArray(rows)) {
    const startAddr = BigInt(addr ?? 0n);
    const total = rows.length;
    const chunkMap = new Map();
    for (let i = 0; i < total; i += CHUNK_ROWS) {
      const c = Math.floor(i / CHUNK_ROWS);
      const slice = rows.slice(i, i + CHUNK_ROWS);
      const mn = slice.map((r) => String(r?.mn ?? r?.mnemonic ?? ''));
      const ops = slice.map((r) => String(r?.ops ?? r?.operands ?? ''));
      const bytes = new Uint8Array(slice.length * 4);
      for (let j = 0; j < slice.length; j++) {
        const b = slice[j]?.bytes;
        if (b && b.length >= 4) {
          bytes[j * 4] = b[0];
          bytes[j * 4 + 1] = b[1];
          bytes[j * 4 + 2] = b[2];
          bytes[j * 4 + 3] = b[3];
        } else if (typeof slice[j]?.word === 'number') {
          const w = slice[j].word >>> 0;
          bytes[j * 4] = w & 0xff;
          bytes[j * 4 + 1] = (w >>> 8) & 0xff;
          bytes[j * 4 + 2] = (w >>> 16) & 0xff;
          bytes[j * 4 + 3] = (w >>> 24) & 0xff;
        }
      }
      chunkMap.set(c, { mn, ops, bytes });
    }
    const region = { id: 'pinpoint-worker', vmAddr: startAddr, size: BigInt(total * 4) };
    const backend = {
      async fetchChunk(_regionId, c) {
        return chunkMap.get(c) || { mn: [], ops: [], bytes: null };
      },
    };
    return { backend, region, startRow: 0, endRow: total - 1, symbols: null };
  }

  if (!rows || typeof rows !== 'object' || !rows.region) {
    throw new Error('pinpoint-worker-invalid-rows');
  }

  const chunkMap = new Map(Array.isArray(rows.chunks) ? rows.chunks : []);
  const backend = {
    async fetchChunk(_regionId, c) {
      return chunkMap.get(c) || { mn: [], ops: [], bytes: null };
    },
  };

  let symbols = null;
  if (rows.symbols && typeof rows.symbols === 'object') {
    const nameMap = new Map(Array.isArray(rows.symbols.names) ? rows.symbols.names : []);
    const labelMap = new Map(Array.isArray(rows.symbols.labels) ? rows.symbols.labels : []);
    symbols = {
      gen: rows.symbols.gen ?? 0,
      nameAt: (a) => nameMap.get(a) || null,
      label: (a) => labelMap.get(a) || null,
    };
  }

  return {
    backend,
    region: rows.region,
    startRow: Number(rows.startRow),
    endRow: Number(rows.endRow),
    symbols,
  };
}

export async function handlePinpointWorkerMessage(payload) {
  const { id, addr, rows, options } = payload || {};
  try {
    const { backend, region, startRow, endRow, symbols } = buildWorkerBackendAndRange(addr, rows);
    const analyzeOpts = { ...(options && typeof options === 'object' ? options : {}), texts: false };
    const rawResult = await analyzeFunction(backend, region, startRow, endRow, symbols, null, analyzeOpts);
    const result = stripNonCloneableModelFields(rawResult);
    return { id, ok: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err ?? 'Pinpoint worker analysis failed');
    return { id, ok: false, error: message };
  }
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = async (event) => {
    const response = await handlePinpointWorkerMessage(event?.data);
    self.postMessage(response);
  };
}
