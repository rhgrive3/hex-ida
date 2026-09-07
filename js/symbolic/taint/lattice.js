/** Finite source-set lattice: bottom (untainted), finite sets, and explicit TOP. */
const issued=new WeakSet();
const issue=value=>{issued.add(value);return value;};
export const UNTAINTED=issue(Object.freeze({kind:'untainted',sources:Object.freeze([])}));
export const TAINT_TOP=issue(Object.freeze({kind:'top',sources:Object.freeze([])}));
export function sourceTaint(source) {
  if(typeof source!=='string'||!source||source.length>1024) throw new TypeError('taint source ID required');
  return issue(Object.freeze({kind:'sources',sources:Object.freeze([source])}));
}
export function joinTaint(a,b,maxSources=4096) {
  if(!Number.isSafeInteger(maxSources)||maxSources<0||maxSources>4096) throw new TypeError('invalid taint source limit');
  if(!issued.has(a)||!issued.has(b)||a.kind==='top'||b.kind==='top') return TAINT_TOP;
  if(a.sources.length>maxSources || b.sources.length>maxSources) return TAINT_TOP;
  const sources=new Set(a.sources);
  for(const id of b.sources) { sources.add(id);if(sources.size>maxSources) return TAINT_TOP; }
  if(sources.size>maxSources) return TAINT_TOP;
  if(!sources.size) return UNTAINTED;
  return issue(Object.freeze({kind:'sources',sources:Object.freeze([...sources].sort())}));
}
export function sameTaint(a,b) {
  return issued.has(a) && issued.has(b) && (a===b || a.kind===b.kind && a.sources.length===b.sources.length && a.sources.every((s,i)=>s===b.sources[i]));
}
// Filtering is a transfer, never an equivalence certificate. Only a registered
// value-scoped model calls it; unknown/TOP cannot be sanitized into clean.
export function filterTaint(value,declaredSources) {
  if(!issued.has(value)||value.kind==='top') return TAINT_TOP;
  if(!Array.isArray(declaredSources)||declaredSources.length>4096) return TAINT_TOP;
  const removed=new Set(declaredSources);
  const sources=value.sources.filter(s=>!removed.has(s));
  return sources.length?issue(Object.freeze({kind:'sources',sources:Object.freeze(sources)})):UNTAINTED;
}
