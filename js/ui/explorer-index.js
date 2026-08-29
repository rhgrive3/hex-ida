const functionCache = new WeakMap();
const stringCache = new WeakMap();
const YIELD_EVERY = 4096;

function abortError() {
  const error = new Error('Explorer query aborted');
  error.name = 'AbortError';
  return error;
}

async function yieldControl(signal) {
  if (signal?.aborted) throw abortError();
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (signal?.aborted) throw abortError();
}

async function buildFunctionIndex(sym, signal) {
  const cached = functionCache.get(sym);
  if (cached && cached.gen === sym.gen) return cached;
  const records = [];
  const prefix = new Map();
  const names = Array.isArray(sym.names) ? sym.names : [];
  const addrs = sym.addrs || [];
  const funcs = sym.funcs || [];
  let si = 0;
  for (let fi = 0; fi < funcs.length; fi++) {
    const addr = funcs[fi];
    while (si < addrs.length && addrs[si] < addr) si++;
    let name = null;
    if (si < addrs.length && addrs[si] === addr) name = String(names[si] || '');
    const manual = sym.renamedAt?.(addr);
    if (manual) name = manual;
    if (name) {
      const lower = name.toLowerCase();
      const record = { addr, name, lower };
      records.push(record);
      const key = lower.slice(0, 3);
      if (key) {
        const bucket = prefix.get(key) || [];
        bucket.push(record); prefix.set(key, bucket);
      }
    }
    if ((fi & (YIELD_EVERY - 1)) === 0) await yieldControl(signal);
  }
  for (const [rawAddr, manual] of sym.renames || []) {
    let addr;
    try { addr = BigInt(rawAddr); } catch { continue; }
    if (!sym.isFunctionStart?.(addr) || records.some((r) => r.addr === addr)) continue;
    const name = String(manual || '');
    if (!name) continue;
    const lower = name.toLowerCase();
    const record = { addr, name, lower };
    records.push(record);
    const key = lower.slice(0, 3);
    const bucket = prefix.get(key) || [];
    bucket.push(record); prefix.set(key, bucket);
  }
  const built = { gen: sym.gen, records, prefix };
  functionCache.set(sym, built);
  return built;
}

function inRegion(addr, region) {
  return !region || (addr >= region.vmAddr && addr < region.vmAddr + region.size);
}

export async function queryFunctions(app, query, { signal, limit = 200 } = {}) {
  const sym = app?.symbols;
  if (!sym) return [];
  const q = String(query || '').trim().toLowerCase();
  const region = app.codeRegion?.() || app.store?.get?.('currentRegion') || null;
  if (!q) return [];
  const address = /^sub_?([0-9a-f]+)$/i.exec(q);
  if (address) {
    try {
      const addr = BigInt('0x' + address[1]);
      if (sym.isFunctionStart?.(addr) && inRegion(addr, region)) return [{ addr, name: sym.nameAt?.(addr) || `sub_${addr.toString(16).toUpperCase()}` }];
    } catch { /* malformed address */ }
  }
  const index = await buildFunctionIndex(sym, signal);
  const prefixSource = q.length >= 3 ? (index.prefix.get(q.slice(0, 3)) || []) : index.records;
  const out = [];
  const seen = new Set();
  const collect = async (source, prefixOnly) => {
    for (let i = 0; i < source.length && out.length < limit; i++) {
      if ((i & (YIELD_EVERY - 1)) === 0) await yieldControl(signal);
      const row = source[i];
      if (!inRegion(row.addr, region)) continue;
      const hit = prefixOnly ? row.lower.startsWith(q) : row.lower.includes(q);
      if (!hit || seen.has(row.addr.toString())) continue;
      seen.add(row.addr.toString()); out.push({ addr: row.addr, name: row.name });
    }
  };
  await collect(prefixSource, true);
  if (out.length < limit) await collect(index.records, false);
  out.sort((a, b) => a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0);
  return out;
}

function stringIndexState(rows) {
  let state = stringCache.get(rows);
  if (!state) {
    state = { records:[], normalized:0, heapBytes:0 };
    stringCache.set(rows, state);
  }
  return state;
}

async function normalizedStringRecord(rows, state, index, signal) {
  if (index < state.normalized) return state.records[index];
  for (let i = state.normalized; i <= index; i++) {
    if (signal?.aborted) throw abortError();
    if ((i & (YIELD_EVERY - 1)) === 0) await yieldControl(signal);
    if (signal?.aborted) throw abortError();
    const text = String(rows[i]?.text || '');
    const lower = text.toLowerCase();
    state.records[i] = { row:rows[i], lower };
    state.heapBytes += (lower.length * 2) + 64;
    state.normalized = i + 1;
  }
  return state.records[index];
}

export function stringQueryIndexStats(rows) {
  const state = stringCache.get(rows || []);
  return {
    normalizedRows: state?.normalized || 0,
    estimatedHeapBytes: state?.heapBytes || 0,
  };
}

export async function queryStrings(rows, query, { signal, limit = 200 } = {}) {
  const sourceRows = rows || [];
  const q = String(query || '').trim().toLowerCase();
  if (!q) return sourceRows;
  const state = stringIndexState(sourceRows);
  const out = [];
  for (let i = 0; i < sourceRows.length && out.length < limit; i++) {
    if (signal?.aborted) throw abortError();
    const record = await normalizedStringRecord(sourceRows, state, i, signal);
    if (record.lower.includes(q)) out.push(record.row);
  }
  for (const key of ['complete', 'truncated', 'truncationReason', 'scannedBytes', 'unscannedRegions']) {
    if (key in sourceRows) Object.defineProperty(out, key, { value: sourceRows[key], enumerable: false, configurable: true });
  }
  out.queryIndexStats = {
    normalizedRows: state.normalized,
    estimatedHeapBytes: state.heapBytes,
  };
  return out;
}
