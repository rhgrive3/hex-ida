/** Shared bounded plain-data observation. No semantic evaluation or proof issuance.
 * Existing solver/decompiler entry points re-export these exact implementations. */
export function ownDataEntries(value, maxEntries = 40000) {
  if (!value || typeof value !== 'object') throw new TypeError('noncanonical-data-object');
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('noncanonical-data-prototype');
  }
  if (array && value.length > maxEntries) throw new TypeError('data-entry-budget-exceeded');
  const keys = Reflect.ownKeys(value);
  if (keys.length > maxEntries + (array ? 1 : 0)) throw new TypeError('data-entry-budget-exceeded');
  const entries = [];
  for (const key of keys) {
    if (array && key === 'length') continue;
    if (typeof key !== 'string') throw new TypeError('symbol-keyed-data');
    if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) throw new TypeError('noncanonical-data-array');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('accessor-data');
    if (!descriptor.enumerable) throw new TypeError('non-enumerable-data');
    entries.push([key, descriptor.value]);
  }
  if (array && entries.length !== value.length) throw new TypeError('sparse-data-array');
  return entries;
}

export const PROJECTION_LIMITS = Object.freeze({nodes:10000,edges:100000,depth:96,expandedUnits:2000000,string:65536});

/**
 * Bounded live-object observation for the SSA/definition graph behind a
 * producer-issued projection. Canonical IR is cyclic (`value.def.dst === value`),
 * so this guard records each plain object once rather than treating cycles as a
 * serialization error. It issues no token and carries no proof authority: its
 * only operation is an exact mutation check over the producer-owned objects.
 */
export function captureProjectionIrData(roots, shouldAbort = null) {
  if (!Array.isArray(roots)) throw new TypeError('projection-ir-roots-array-required');
  const records = [], seen = new WeakSet();
  let edges = 0, nodes = 0, expandedUnits = 0;
  const started = performance.now();
  function check() {
    if (performance.now()-started >= 250 || shouldAbort?.()) throw new TypeError('projection-capture-cancelled-or-deadline');
  }
  function scalarCost(value) {
    if (value == null || typeof value === 'boolean') return 1;
    if (typeof value === 'bigint') {
      if (value >= (1n<<1024n) || value <= -(1n<<1024n)) throw new TypeError('projection-bigint-budget');
      return 128;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return 1;
    if (typeof value === 'string') {
      if (value.length > PROJECTION_LIMITS.string) throw new TypeError('projection-string-budget');
      return value.length+1;
    }
    if (typeof value !== 'object') throw new TypeError('projection-non-data');
    return null;
  }
  function visit(value, depth) {
    check();
    const primitive = scalarCost(value);
    if (primitive != null) return primitive;
    if (depth > PROJECTION_LIMITS.depth) throw new TypeError('projection-depth-budget');
    if (seen.has(value)) return 1;
    if (nodes >= PROJECTION_LIMITS.nodes) throw new TypeError('projection-node-budget');
    nodes++; seen.add(value);
    const entries = ownDataEntries(value,PROJECTION_LIMITS.edges-edges);
    edges += entries.length;
    records.push({value,prototype:Object.getPrototypeOf(value),entries,arrayLength:Array.isArray(value)?value.length:null});
    let cost = 1;
    for (const [key,child] of entries) {
      if (key.length > PROJECTION_LIMITS.string) throw new TypeError('projection-key-budget');
      // `uses` is the reverse SSA index, not execution semantics. Keep its
      // field identity bound without recursively pulling unrelated users into
      // the producer expression's graph.
      const childCost = key === 'uses' ? 1 : visit(child,depth+1);
      cost += key.length + childCost + 1;
      if (cost > PROJECTION_LIMITS.expandedUnits) throw new TypeError('projection-expansion-budget');
    }
    return cost;
  }
  for (const root of roots) {
    expandedUnits += visit(root,1);
    if (expandedUnits > PROJECTION_LIMITS.expandedUnits) throw new TypeError('projection-expansion-budget');
  }
  check();
  return Object.freeze({metrics:Object.freeze({nodes,edges,expandedUnits}),matches() {
    try {
      for (const {value,prototype,entries,arrayLength} of records) {
        if (Object.getPrototypeOf(value)!==prototype || arrayLength!=null && value.length!==arrayLength) return false;
        const keys=Reflect.ownKeys(value);
        if(keys.length!==entries.length+(arrayLength!=null?1:0)) return false;
        for(const [key,previous] of entries) {
          const descriptor=Object.getOwnPropertyDescriptor(value,key);
          if(!descriptor || !Object.hasOwn(descriptor,'value') || !descriptor.enumerable || !Object.is(descriptor.value,previous)) return false;
        }
      }
      return true;
    } catch { return false; }
  }});
}
