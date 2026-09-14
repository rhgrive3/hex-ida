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
function attachQueryStatus(rows, result) {
  for (const [key, value] of Object.entries({
    completeness: result?.completeness ?? result?.status?.completeness ?? 'partial',
    queryStatus: result?.status ?? null,
    queryPage: result?.page ?? null,
  })) Object.defineProperty(rows, key, { value, enumerable:false, configurable:true });
  return rows;
}

export async function queryFunctions(app, query, { signal, limit = 200 } = {}) {
  if (!app?.analysisQueries) return [];
  const q = String(query || '').trim().toLowerCase();
  if (signal?.aborted) throw abortError();
  const snapshot = await app.analysisQueries.snapshot({ signal });
  const addressMatch = /^sub_?([0-9a-f]+)$/i.exec(q);
  const filter = addressMatch ? { address:BigInt('0x' + addressMatch[1]) } : (q ? { text:q } : {});
  const result = await app.analysisQueries.functions(snapshot, filter, { offset:0, limit }, { signal });
  const rows = (result?.value || []).map((row) => {
    const addr = BigInt(row.address ?? row.startAddress ?? row.start ?? row.id);
    return { addr, name:row.name || `sub_${addr.toString(16).toUpperCase()}` };
  });
  rows.sort((a, b) => a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0);
  return attachQueryStatus(rows, result);
}

function stringIndexState(rows) {
  let state = stringCache.get(rows);
  if (!state) { state = { records:[], normalized:0, heapBytes:0 }; stringCache.set(rows, state); }
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
  return { normalizedRows:state?.normalized || 0, estimatedHeapBytes:state?.heapBytes || 0 };
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
  for (const key of ['complete','truncated','truncationReason','scannedBytes','unscannedRegions']) {
    if (key in sourceRows) Object.defineProperty(out, key, { value:sourceRows[key], enumerable:false, configurable:true });
  }
  out.queryIndexStats = { normalizedRows:state.normalized, estimatedHeapBytes:state.heapBytes };
  return out;
}
