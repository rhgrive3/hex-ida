/** Bounded data snapshot of an existing producer's projection. No evaluation,
 * proof minting or AST semantics live here. Issuance belongs to pipeline.js. */
import { ownDataEntries, PROJECTION_LIMITS, captureProjectionIrData, createProjectionIrObserver } from '../../core/identity/live-data.js';
import { readDominanceViewInputs } from '../../controlflow.js';
export { PROJECTION_LIMITS, captureProjectionIrData } from '../../core/identity/live-data.js';

// A frozen plain object or frozen Array whose own data entries have already
// passed `ownDataEntries` cannot have its prototype, own keys, array length,
// or own data property descriptors mutated. Cache its verified shallow
// metadata so repeated projection captures and `matches()` checks do not
// re-enumerate `Reflect.ownKeys` and property descriptors for immutable nodes.
const frozenObjectEntriesCache = new WeakMap();

function cachedOwnDataEntries(value, maxEntries) {
  if (value !== null && typeof value === 'object') {
    const cached = frozenObjectEntriesCache.get(value);
    if (cached !== undefined) {
      if (cached.entries.length > maxEntries) throw new TypeError('data-entry-budget-exceeded');
      return cached.entries;
    }
  }
  const entries = ownDataEntries(value, maxEntries);
  if (value !== null && typeof value === 'object' && Object.isFrozen(value)) {
    frozenObjectEntriesCache.set(value, {
      prototype: Object.getPrototypeOf(value),
      arrayLength: Array.isArray(value) ? value.length : null,
      entries,
    });
  }
  return entries;
}

// Dominance uses native Sets or the control-flow producer's issued lazy views.
// Observe their backing data; never convert or recompute the canonical facts.
export function captureRecoveryDominators(value, shouldAbort = null) {
  if (value == null) return { edges:0, matches:() => true };
  if (!Array.isArray(value)) throw new TypeError('recovery-dominators-array-required');
  const entries = cachedOwnDataEntries(value, PROJECTION_LIMITS.nodes), length = value.length;
  const arrayFrozen = Object.isFrozen(value);
  const size = Object.getOwnPropertyDescriptor(Set.prototype, 'size').get;
  let edges = entries.length;
  const nativeSets = new Map(), seenIdoms = new Set(), seenViews = new Map(), roots = [];
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
    let view;
    if (seenViews.has(set)) {
      view = seenViews.get(set);
    } else {
      view = readDominanceViewInputs(set);
      seenViews.set(set, view);
      if (view) {
        captureSet(view.reachable);
        if (!seenIdoms.has(view.idom)) {
          seenIdoms.add(view.idom);
          roots.push(view.idom);
        }
        roots.push(view.index);
      } else {
        captureSet(set);
      }
    }
    return { key, set, view, viewKeys: view ? Object.keys(view) : null };
  });
  const data = captureProjectionIrData(roots, shouldAbort); edges += data.metrics.edges;
  if (edges > PROJECTION_LIMITS.edges) throw new TypeError('recovery-dominators-budget');
  return { edges, matches() {
    try {
      const current = arrayFrozen ? entries : cachedOwnDataEntries(value, PROJECTION_LIMITS.nodes);
      if (!arrayFrozen && (value.length !== length || current.length !== entries.length)) return false;
      const checkedViews = new Map();
      for (let index = 0; index < sets.length; index++) {
        const { key, set, view, viewKeys } = sets[index];
        if (current[index][0] !== key || current[index][1] !== set) return false;
        if (view) {
          let ok = checkedViews.get(set);
          if (ok === undefined) {
            const now = readDominanceViewInputs(set);
            ok = !!now && viewKeys.every(k => now[k] === view[k]);
            checkedViews.set(set, ok);
          }
          if (!ok) return false;
        }
      }
      for (const [set, members] of nativeSets) {
        if (Object.getPrototypeOf(set) !== Set.prototype || Reflect.ownKeys(set).length
          || size.call(set) !== members.length || !members.every(member => Set.prototype.has.call(set, member))) {
          return false;
        }
      }
      return data.matches();
    } catch { return false; }
  } };
}


// Recovery depends on these canonical roots, not on envelope caches or Map
// indexes. Preserve their own-data descriptors so getters cannot replay a root.
export function captureRecoveryIrData(ir, extraRoots, shouldAbort = null) {
  const keys = ['instructions', 'values', 'blocks', 'idom', 'dominators'];
  const irFrozen = ir !== null && typeof ir === 'object' && Object.isFrozen(ir);
  const prototype = Object.getPrototypeOf(ir);
  const descriptors = keys.map(key => Object.getOwnPropertyDescriptor(ir, key));
  if (descriptors.some(descriptor => descriptor && (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable))) {
    throw new TypeError('recovery-ir-data-roots-required');
  }
  const dominance = captureRecoveryDominators(descriptors.at(-1)?.value, shouldAbort);
  // Canonical IR lists already enumerate the cyclic graph's vertices. Fresh
  // root-distance observation preserves all fields and bounds without treating
  // the traversal order of a def/use cycle as nested metadata depth.
  // Canonical origin payloads are independently certified immutable data;
  // their exact envelopes remain bound alongside every mutable input.
  const observation = createProjectionIrObserver().captureCertifiedDataGraph([...descriptors.slice(0, -1).map(descriptor => descriptor?.value), ...extraRoots], shouldAbort);
  const edges = observation.metrics.edges + dominance.edges;
  if (edges > PROJECTION_LIMITS.edges) throw new TypeError('recovery-binding-budget');
  return Object.freeze({ metrics:Object.freeze({ ...observation.metrics, edges }), matches() {
    try {
      return (irFrozen || (Object.getPrototypeOf(ir) === prototype && keys.every((key, index) => {
        const current = Object.getOwnPropertyDescriptor(ir, key), prior = descriptors[index];
        return prior ? !!current && Object.hasOwn(current, 'value') && current.enumerable
          && Object.is(current.value, prior.value) : current === undefined;
      }))) && dominance.matches() && observation.matches();
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
  // Node, edge, depth, string, and expanded-unit caps below are the safety
  // boundary. This snapshot participates in producer proof bindings, so its
  // availability must not depend on an elapsed-host-time cutoff.
  function check() {
    if (shouldAbort?.()) throw new TypeError('projection-capture-cancelled');
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
    const entries = cachedOwnDataEntries(value,PROJECTION_LIMITS.edges-edges);
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
    if (!frozenObjectEntriesCache.has(value)) {
      records.push({value,prototype:Object.getPrototypeOf(value),entries,arrayLength:Array.isArray(value)?value.length:null,verifiedFrozen:false});
    }
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
      for (const record of records) {
        if (record.verifiedFrozen) continue;
        const {value,prototype,entries,arrayLength} = record;
        if (Object.getPrototypeOf(value)!==prototype || arrayLength!=null && value.length!==arrayLength) return false;
        const keys=Reflect.ownKeys(value);
        if(keys.length!==entries.length+(arrayLength!=null?1:0)) return false;
        for(const [key,previous] of entries) {
          const descriptor=Object.getOwnPropertyDescriptor(value,key);
          if(!descriptor || !Object.hasOwn(descriptor,'value') || !descriptor.enumerable || !Object.is(descriptor.value,previous)) return false;
        }
        if (Object.isFrozen(value)) record.verifiedFrozen = true;
      }
      return true;
    } catch { return false; }
  }});
}
