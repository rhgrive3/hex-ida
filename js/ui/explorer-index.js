const stringCache = new WeakMap();
const functionSearchCache = new WeakMap();
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

export async function queryFunctions(app, query, { signal, offset = 0, limit = 200 } = {}) {
  if (!app?.analysisQueries) return [];
  const q = String(query || '').trim().toLowerCase();
  if (signal?.aborted) throw abortError();
  const addressMatch = /^sub_?([0-9a-f]+)$/i.exec(q);
  const filter = addressMatch ? { address:BigInt('0x' + addressMatch[1]) } : (q ? { text:q } : {});
  let result;
  // Lazy function discovery can advance the canonical identity during the
  // first query. Re-snapshot once; never display or accept the stale result.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) throw abortError();
    const snapshot = await app.analysisQueries.snapshot({ signal });
    if (signal?.aborted) throw abortError();
    try {
      result = await app.analysisQueries.functions(snapshot, filter, { offset, limit }, { signal });
      if (signal?.aborted) throw abortError();
      break;
    } catch (error) {
      if (signal?.aborted) throw abortError();
      const isStale = error?.code === 'ANALYSIS_SNAPSHOT_STALE' || error?.code === 'analysis-snapshot-stale' || error?.name === 'AnalysisSnapshotStaleError';
      if (attempt || !isStale) throw error;
    }
  }
  const rows = (result?.value || []).map((row) => {
    const addr = BigInt(row.address ?? row.startAddress ?? row.start ?? row.id);
    return { addr, name:row.name || `sub_${addr.toString(16).toUpperCase()}`, size:row.size ?? null };
  });
  let alreadySorted = true;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i - 1].addr > rows[i].addr) { alreadySorted = false; break; }
  }
  if (!alreadySorted) {
    rows.sort((a, b) => (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0));
  }
  return attachQueryStatus(rows, result);
}

function getFunctionSearchIndex(symbols) {
  const gen = symbols.gen ?? 0;
  const cached = functionSearchCache.get(symbols);
  if (cached && cached.gen === gen) return cached.entries;

  const funcs = symbols.funcs;
  const n = funcs.length;
  const addrs = symbols.addrs || [];
  const symNames = symbols.names || [];
  const m = addrs.length;
  const renames = symbols.renames instanceof Map ? symbols.renames : null;
  const hasRenames = Boolean(renames && renames.size > 0);
  const hasFnEnd = typeof symbols._functionEnd === 'function';
  const funcEnds = symbols.funcEnds || null;

  const entries = new Array(n);
  let symIdx = 0;
  for (let i = 0; i < n; i++) {
    const addr = typeof funcs[i] === 'bigint' ? funcs[i] : BigInt(funcs[i]);
    const hexLower = addr.toString(16);
    let name = hasRenames ? (renames.get(addr.toString()) || null) : null;
    while (symIdx < m && addrs[symIdx] < addr) symIdx++;
    if (!name && symIdx < m && addrs[symIdx] === addr) {
      name = symNames[symIdx] || null;
    }
    if (!name) name = `sub_${hexLower.toUpperCase()}`;
    let end = null;
    if (hasFnEnd) {
      end = symbols._functionEnd(i);
    } else if (funcEnds && i < funcEnds.length && funcEnds[i] != null && funcEnds[i] > addr) {
      end = funcEnds[i];
    }
    const size = end != null && end > addr ? end - addr : null;
    entries[i] = {
      addr,
      name,
      nameLower: name.toLowerCase(),
      hexLower,
      size,
    };
  }
  functionSearchCache.set(symbols, { gen, entries });
  return entries;
}

function setHasAddr(set, addr) {
  if (!set || typeof set.has !== 'function') return false;
  return set.has(addr) || set.has(addr.toString());
}

function matchRank(nameLower, hexLower, q, hexQuery) {
  if (!q) return 0;
  if (nameLower === q || (hexQuery != null && hexLower === hexQuery) || hexLower === q) return 0;
  if (nameLower.startsWith(q) || (hexQuery != null && hexLower.startsWith(hexQuery)) || hexLower.startsWith(q)) return 1;
  if (nameLower.includes(q) || hexLower.includes(hexQuery ?? q)) return 2;
  return -1;
}

function compareAddrBig(a, b) {
  return a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0;
}

function sortMatchedEntries(matched, { sort, hasQuery, prioritySet, savedSet, editedSet }) {
  const useSplitPriority = Boolean(savedSet || editedSet);
  const priorityScoreOf = (addr) => {
    if (useSplitPriority) {
      return (setHasAddr(savedSet, addr) ? 1000 : 0) + (setHasAddr(editedSet, addr) ? 500 : 0);
    }
    return setHasAddr(prioritySet, addr) ? 1000 : 0;
  };

  if (sort === 'name') {
    matched.sort((a, b) => {
      if (hasQuery && a.rank !== b.rank) return a.rank - b.rank;
      return a.nameLower.localeCompare(b.nameLower) || compareAddrBig(a, b);
    });
  } else if (sort === 'size') {
    matched.sort((a, b) => {
      const sa = a.size != null ? BigInt(a.size) : -1n;
      const sb = b.size != null ? BigInt(b.size) : -1n;
      if (sa !== sb) return sa > sb ? -1 : 1;
      if (hasQuery && a.rank !== b.rank) return a.rank - b.rank;
      return compareAddrBig(a, b);
    });
  } else if (sort === 'priority') {
    matched.sort((a, b) => {
      const pa = priorityScoreOf(a.addr);
      const pb = priorityScoreOf(b.addr);
      if (pa !== pb) return pb - pa;
      if (hasQuery && a.rank !== b.rank) return a.rank - b.rank;
      return compareAddrBig(a, b);
    });
  } else if (hasQuery) {
    matched.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : compareAddrBig(a, b)));
  }
}

export async function queryFunctionsFast(
  app,
  query,
  { signal, offset = 0, limit = 120, sort = 'address', filterSet = null, prioritySet = null, savedSet = null, editedSet = null } = {},
) {
  if (signal?.aborted) throw abortError();
  const q = String(query || '').trim().toLowerCase();
  const hexQuery = q.startsWith('0x') ? (q.slice(2) || null) : (q.startsWith('sub_') ? (q.slice(4) || null) : null);
  const start = Math.max(0, Number.isSafeInteger(offset) ? offset : 0);
  const count = Math.max(0, Number.isSafeInteger(limit) ? limit : 120);

  const symbols = app?.symbols;
  if (!symbols || !symbols.funcs) {
    const needsPostProcess = Boolean(filterSet || sort !== 'address' || q);
    const fetchOffset = needsPostProcess ? 0 : start;
    const fetchLimit = needsPostProcess ? Math.max(start + count, 2000) : count;
    const rows = await queryFunctions(app, query, { signal, offset: fetchOffset, limit: fetchLimit });
    if (signal?.aborted) throw abortError();
    const rawList = Array.isArray(rows) ? rows : [];
    const matched = [];
    for (let i = 0; i < rawList.length; i++) {
      const row = rawList[i];
      const addr = typeof row.addr === 'bigint' ? row.addr : BigInt(row.addr);
      if (filterSet && !setHasAddr(filterSet, addr)) continue;
      const name = String(row.name || `sub_${addr.toString(16).toUpperCase()}`);
      const nameLower = name.toLowerCase();
      const hexLower = addr.toString(16);
      const rank = q ? matchRank(nameLower, hexLower, q, hexQuery) : 0;
      if (q && rank < 0) continue;
      matched.push({ addr, name, nameLower, hexLower, size: row.size ?? null, rank });
    }
    if (needsPostProcess) {
      sortMatchedEntries(matched, { sort, hasQuery: Boolean(q), prioritySet, savedSet, editedSet });
      const items = matched.slice(start, start + count).map(({ addr, name, size }) => ({ addr, name, size }));
      return {
        items,
        total: matched.length,
        complete: rows?.completeness ? rows.completeness === 'complete' : true,
      };
    }
    const items = matched.map(({ addr, name, size }) => ({ addr, name, size }));
    return {
      items,
      total: rows?.queryPage?.total ?? items.length,
      complete: rows?.completeness ? rows.completeness === 'complete' : true,
    };
  }

  const entries = getFunctionSearchIndex(symbols);
  let matched;
  if (!q && !filterSet) {
    matched = sort === 'address' ? entries : entries.slice();
  } else {
    matched = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (filterSet && !setHasAddr(filterSet, entry.addr)) continue;
      if (q) {
        const rank = matchRank(entry.nameLower, entry.hexLower, q, hexQuery);
        if (rank < 0) continue;
        matched.push({ ...entry, rank });
      } else {
        matched.push(entry);
      }
    }
  }

  sortMatchedEntries(matched, { sort, hasQuery: Boolean(q), prioritySet, savedSet, editedSet });

  const total = matched.length;
  const items = matched.slice(start, start + count).map(({ addr, name, size }) => ({ addr, name, size }));
  return { items, total, complete: true };
}

function stringIndexState(rows) {
  let state = stringCache.get(rows);
  if (!state) { state = { records:[], normalized:0, heapBytes:0 }; stringCache.set(rows, state); }
  return state;
}
async function normalizedStringRecord(rows, state, index, signal) {
  if (index < state.normalized) return state.records[index];
  for (let i = state.normalized; i <= index; i++) {
    if (i < state.normalized) { i = state.normalized - 1; continue; }
    if (signal?.aborted) throw abortError();
    if ((i & (YIELD_EVERY - 1)) === 0) {
      await yieldControl(signal);
      if (i < state.normalized) { i = state.normalized - 1; continue; }
    }
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
export async function queryStrings(rows, query, { signal, offset = 0, limit = 200 } = {}) {
  if (signal?.aborted) throw abortError();
  const sourceRows = rows || [];
  const q = String(query || '').trim().toLowerCase();
  if (!q) return sourceRows;
  const state = stringIndexState(sourceRows);
  const out = [];
  let matched = 0;
  let scanned = 0;
  for (let i = 0; i < sourceRows.length && out.length < limit; i++) {
    if (signal?.aborted) throw abortError();
    const record = await normalizedStringRecord(sourceRows, state, i, signal);
    scanned = i + 1;
    if (!record.lower.includes(q)) continue;
    if (matched++ < offset) continue;
    out.push(record.row);
  }
  const hasMore = scanned < sourceRows.length;
  Object.defineProperty(out, 'queryPage', { value:{ offset, limit, returned:out.length,
    total:hasMore || sourceRows.complete === false ? null : matched,
    next:hasMore ? offset + out.length : null }, configurable:true });
  for (const key of ['complete','truncated','truncationReason','scannedBytes','unscannedRegions']) {
    if (key in sourceRows) Object.defineProperty(out, key, { value:sourceRows[key], enumerable:false, configurable:true });
  }
  out.queryIndexStats = { normalizedRows:state.normalized, estimatedHeapBytes:state.heapBytes };
  return out;
}
