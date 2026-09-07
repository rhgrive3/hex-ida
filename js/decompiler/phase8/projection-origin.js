/** Bounded data snapshot of an existing producer's projection. No evaluation,
 * proof minting or AST semantics live here. Issuance belongs to pipeline.js. */
import { ownDataEntries } from '../../symbolic/expr/data-boundary.js';

export const PROJECTION_LIMITS = Object.freeze({nodes:10000,edges:100000,depth:96,expandedUnits:2000000,string:65536});
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
  return Object.freeze({metrics:Object.freeze({nodes,edges,expandedUnits}),tokenOf(value) { return memo.get(value)?.token ?? null; }, matches() {
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
