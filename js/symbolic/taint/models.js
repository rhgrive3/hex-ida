import { stableDigest } from '../../core/identity/index.js';
const issued=new WeakSet();
function text(value,name) {
  if(typeof value!=='string'||!value.trim()||value.length>1024) throw new TypeError(`invalid model ${name}`);
  return value;
}
export function createTaintModels({id,version,provenance,sources=[],sinks=[],sanitizers=[],memorySinks=[]}={}) {
  text(id,'id');text(version,'version');text(provenance,'provenance');
  let sanitizerMemberships=0;
  const normalize=(items,kind)=> {
    if(!Array.isArray(items)||items.length>4096) throw new TypeError(`model ${kind} limit`);
    const seen=new Set();
    return Object.freeze(items.map(item=> {
      text(item.id,'entry ID');
      if(kind==='memorySinks') text(item.observationId,'observation ID');
      else text(item.valueId,'value ID');
      if(seen.has(item.id)) throw new TypeError('duplicate model entry ID');seen.add(item.id);
      const out={id:item.id,...(kind==='memorySinks'?{observationId:item.observationId}:{valueId:item.valueId}),version:text(item.version??version,'version'),provenance:text(item.provenance??provenance,'provenance')};
      if(kind==='sanitizers') {
        out.scope=item.scope==='value'?'value':'unknown';
        const remove=item.removeSources??[];
        if(!Array.isArray(remove)||remove.length>4096) throw new TypeError('invalid sanitizer source scope');
        sanitizerMemberships+=remove.length;
        if(sanitizerMemberships>100000) throw new TypeError('sanitizer source membership limit');
        out.removeSources=Object.freeze([...new Set(remove.map(s=>text(s,'source scope')))].sort());
      }
      return Object.freeze(out);
    }));
  };
  const body={id,version,provenance,sources:normalize(sources,'sources'),sinks:normalize(sinks,'sinks'),sanitizers:normalize(sanitizers,'sanitizers'),memorySinks:normalize(memorySinks,'memorySinks')};
  if(body.sinks.length+body.memorySinks.length>4096) throw new TypeError('model sinks limit');
  const sinkIds=new Set(body.sinks.map(s=>s.id));
  for(const sink of body.memorySinks) {
    if(sinkIds.has(sink.id)) throw new TypeError('duplicate model sink ID');
    sinkIds.add(sink.id);
  }
  const values=new Set();
  for(const entry of body.sanitizers) {
    if(values.has(entry.valueId)) throw new TypeError('ambiguous sanitizer value binding');values.add(entry.valueId);
  }
  const result=Object.freeze({...body,modelIdentity:stableDigest(body)});issued.add(result);return result;
}
export function isTaintModels(value) { return issued.has(value); }
