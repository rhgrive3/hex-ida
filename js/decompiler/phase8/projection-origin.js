/** Bounded data snapshot of an existing producer's projection. No evaluation,
 * proof minting or AST semantics live here. Issuance belongs to pipeline.js. */
import { ownDataEntries, PROJECTION_LIMITS, captureProjectionIrData } from '../../core/identity/live-data.js';
import { readDominanceViewInputs } from '../../controlflow.js';
export { PROJECTION_LIMITS, captureProjectionIrData } from '../../core/identity/live-data.js';

// Dominance uses native Sets or the control-flow producer's issued lazy views.
// Observe their backing data; never convert or recompute the canonical facts.
export function captureRecoveryDominators(value, shouldAbort = null) {
  if (value == null) return { edges:0, matches:() => true };
  if (!Array.isArray(value)) throw new TypeError('recovery-dominators-array-required');
  const entries = ownDataEntries(value, PROJECTION_LIMITS.nodes), length = value.length;
  const size = Object.getOwnPropertyDescriptor(Set.prototype, 'size').get;
  let edges = entries.length;
  const nativeSets = new Map(), roots = [];
  const captureSet = set => {
    if (nativeSets.has(set)) return;
    if (Object.getPrototypeOf(set) !== Set.prototype || Reflect.ownKeys(set).length) throw new TypeError('recovery-dominator-set-required');
    edges += size.call(set);
    if (edges > PROJECTION_LIMITS.edges) throw new TypeError('recovery-dominators-budget');
    const members = [...Set.prototype.values.call(set)];
    if (members.some(member => !Number.isSafeInteger(member) || member < 0)) throw new TypeError('recovery-dominator-index-required');
    nativeSets.set(set, members);
  };
  const sets = entries.map(([key, set]) => {
    if (shouldAbort?.()) throw new TypeError('recovery-dominators-cancelled');
    const view = readDominanceViewInputs(set);
    if (view) { captureSet(view.reachable); roots.push(view.idom, view.index); }
    else captureSet(set);
    return { key, set, view };
  });
  const data = captureProjectionIrData(roots, shouldAbort); edges += data.metrics.edges;
  if (edges > PROJECTION_LIMITS.edges) throw new TypeError('recovery-dominators-budget');
  return { edges, matches() {
    try {
      const current = ownDataEntries(value, PROJECTION_LIMITS.nodes);
      return value.length === length && current.length === entries.length && sets.every(({ key, set, view }, index) =>
        current[index][0] === key && current[index][1] === set
        && (!view || (() => { const now = readDominanceViewInputs(set); return now && Object.keys(view).every(key => now[key] === view[key]); })()))
        && [...nativeSets].every(([set, members]) => Object.getPrototypeOf(set) === Set.prototype && !Reflect.ownKeys(set).length
          && size.call(set) === members.length && members.every(member => Set.prototype.has.call(set, member))) && data.matches();
    } catch { return false; }
  } };
}


// Recovery depends on these canonical roots, not on envelope caches or Map
// indexes. Preserve their own-data descriptors so getters cannot replay a root.
export function captureRecoveryIrData(ir, extraRoots, shouldAbort = null) {
  const keys = ['instructions', 'values', 'blocks', 'idom', 'dominators'];
  const prototype = Object.getPrototypeOf(ir);
  const descriptors = keys.map(key => Object.getOwnPropertyDescriptor(ir, key));
  if (descriptors.some(descriptor => descriptor && (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable))) {
    throw new TypeError('recovery-ir-data-roots-required');
  }
  const dominance = captureRecoveryDominators(descriptors.at(-1)?.value, shouldAbort);
  const observation = captureProjectionIrData([...descriptors.slice(0, -1).map(descriptor => descriptor?.value), ...extraRoots], shouldAbort);
  const edges = observation.metrics.edges + dominance.edges;
  if (edges > PROJECTION_LIMITS.edges) throw new TypeError('recovery-binding-budget');
  return Object.freeze({ metrics:Object.freeze({ ...observation.metrics, edges }), matches() {
    try {
      return Object.getPrototypeOf(ir) === prototype && keys.every((key, index) => {
        const current = Object.getOwnPropertyDescriptor(ir, key), prior = descriptors[index];
        return prior ? !!current && Object.hasOwn(current, 'value') && current.enumerable
          && Object.is(current.value, prior.value) : current === undefined;
      }) && dominance.matches() && observation.matches();
    } catch { return false; }
  } });
}

export function captureProjectionData(roots, shouldAbort = null) {
  const records = [], memo = new WeakMap(), active = new WeakSet();
  let edges = 0, nodes = 0;
  const structuralTokens = new Map();
  function scalarToken(value) {
    return typeof value === 'number' && Object.is(value,-0) ? 'number:-0' : `${typeof value}:${String(value)}`;
  }
  const started = performance.now();
  function check() {
    if (performance.now()-started >= 250 || shouldAbort?.()) throw new TypeError('projection-capture-cancelled-or-deadline');
  }
  function visit(value, depth) {
    check();
    if (value == null || typeof value === 'boolean') return {cost:1,height:0,token:scalarToken(value)};
    if (typeof value === 'bigint') {
      if (value >= (1n<<1024n) || value <= -(1n<<1024n)) throw new TypeError('projection-bigint-budget');
      return {cost:128,height:0,token:scalarToken(value)};
    }
    if (typeof value === 'number' && Number.isFinite(value)) return {cost:1,height:0,token:scalarToken(value)};
    if (typeof value === 'string') {
      if (value.length > PROJECTION_LIMITS.string) throw new TypeError('projection-string-budget');
      return {cost:value.length+1,height:0,token:scalarToken(value)};
    }
    if (typeof value !== 'object') throw new TypeError('projection-non-data');
    if (depth > PROJECTION_LIMITS.depth || active.has(value)) throw new TypeError('projection-depth-or-cycle');
    if (memo.has(value)) {
      const entry = memo.get(value);
      if (depth+entry.height-1 > PROJECTION_LIMITS.depth) throw new TypeError('projection-depth-budget');
      return entry;
    }
    if (nodes >= PROJECTION_LIMITS.nodes) throw new TypeError('projection-node-budget');
    nodes++; active.add(value);
    const entries = ownDataEntries(value,PROJECTION_LIMITS.edges-edges);
    edges += entries.length;
    let cost = 1, height = 1; const fields=[];
    for (const [key,child] of entries) {
      if (key.length > PROJECTION_LIMITS.string) throw new TypeError('projection-key-budget');
      const observation = visit(child,depth+1);
      fields.push([key,observation.token]);
      cost += key.length + observation.cost + 1;
      if (cost > PROJECTION_LIMITS.expandedUnits) throw new TypeError('projection-expansion-budget');
      height = Math.max(height,observation.height+1);
    }
    // Exact typed data interning, not a digest or variable-name inference.
    // Only complete producer-issued nodes with identical fields AND origins
    // share a token; cloned render expressions retain their source binding.
    const signature = JSON.stringify([Array.isArray(value)?'array':Object.getPrototypeOf(value)===null?'null-object':'object',fields.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0)]);
    if (!structuralTokens.has(signature)) structuralTokens.set(signature,structuralTokens.size);
    const entry = {cost,height,token:`node:${structuralTokens.get(signature)}`}; memo.set(value,entry); active.delete(value);
    records.push({value,prototype:Object.getPrototypeOf(value),entries,arrayLength:Array.isArray(value)?value.length:null});
    return entry;
  }
  let expandedUnits=0;
  if (!Array.isArray(roots)) throw new TypeError('projection-roots-array-required');
  for (const [,root] of ownDataEntries(roots,2)) {
    expandedUnits += visit(root,1).cost;
    if (expandedUnits > PROJECTION_LIMITS.expandedUnits) throw new TypeError('projection-expansion-budget');
  }
  check();
  return Object.freeze({metrics:Object.freeze({nodes,edges,expandedUnits}),tokenOf(value) { return memo.get(value)?.token ?? null; },matches() {
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
