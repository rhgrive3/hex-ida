/** One monotone taint graph over semantic value IDs; memory transports graph handles.
 * A fixed point is computed only after the bounded executor has supplied actual
 * byte-flow dependencies. No second alias/reaching-definition engine is involved.
 */
import { createQueryGuard, QueryFailure, boundedLimit } from '../memory/query-state.js';
import { UNTAINTED, TAINT_TOP, sourceTaint, joinTaint, sameTaint, filterTaint } from './lattice.js';
import { isTaintModels } from './models.js';
const CEILINGS=Object.freeze({latticeValues:100000,flowEdges:200000,workItems:1000000,
  sources:4096,sinks:4096,emittedRecords:100000});
export function createTaintFlow(options) {
  if(!isTaintModels(options.models)) throw new TypeError('registered immutable taint models required');
  const guard=createQueryGuard({...options,timeoutMs:options.timeoutMs??120},CEILINGS);
  const maxUpdates=boundedLimit(options.maxUpdates,8,8,'updatesPerValue');
  const sourceLimit=boundedLimit(options.sourceLimit,4096,4096,'sourceLimit');
  const nodes=new Map(), edges=[], handles=new WeakMap(), interned=new Map(), internedPairs=new Map();
  const modelSinks=[...options.models.sinks,...options.models.memorySinks];
  const sanitizers=new Map(options.models.sanitizers.map(x=>[x.valueId,x]));
  let joinCounter=0, maxActualUpdates=0,widened=false;
  function join(a,b) {
    guard.take('workItems',1+(a.sources?.length??0)+(b.sources?.length??0));
    return joinTaint(a,b,sourceLimit);
  }
  function ensureKey(key,semanticId=null) {
    if(nodes.has(key)) return nodes.get(key);
    guard.take('latticeValues');
    const handle=Object.freeze({key});handles.set(handle,key);
    const n={key,semanticId,handle,inputs:new Set(),outputs:new Set(),inputNodes:[],outputNodes:[],inQueue:false,seed:UNTAINTED,state:UNTAINTED,updates:0,defined:false,sanitizer:sanitizers.get(semanticId)};
    nodes.set(key,n);return n;
  }
  const clean=ensureKey('constant:clean');clean.defined=true;
  const top=ensureKey('constant:top');top.defined=true;top.seed=TAINT_TOP;
  function resolve(value) {
    if(value==null) return clean;
    if(typeof value==='object') {
      const key=handles.get(value);if(!key) throw new QueryFailure('foreign-taint-handle');return nodes.get(key);
    }
    if(typeof value!=='string'||!value||value.length>1024) throw new QueryFailure('invalid-semantic-value-id');
    return ensureKey(`value:${value}`,value);
  }
  function edge(input,output,kind) {
    guard.take('workItems');
    if(output.inputs.has(input.key)) return;
    guard.take('flowEdges');
    output.inputs.add(input.key);input.outputs.add(output.key);
    output.inputNodes.push(input);input.outputNodes.push(output);
    edges.push(Object.freeze({from:input.key,to:output.key,kind}));
  }
  function value(id,inputs,kind,{unknown=false,control=null}={}) {
    guard.check();
    if (!Array.isArray(inputs)) throw new QueryFailure('invalid-flow-inputs');
    // Reserve even for absent dependencies; skipping null entries must not
    // create an unbounded loop or manufacture an untainted value.
    guard.take('workItems', inputs.length);
    const out=resolve(id);out.defined=true;
    if(unknown) out.seed=TAINT_TOP;
    for (const input of inputs) {
      if (input == null) out.seed = TAINT_TOP;
      else edge(resolve(input), out, kind);
    }
    if(control!=null) edge(resolve(control),out,'control');
    return out.handle;
  }
  function internPair(first, second) {
    let bySecond=internedPairs.get(first.key);
    if(bySecond && bySecond.has(second.key)) return bySecond.get(second.key);
    const out=ensureKey(`memory:${joinCounter++}`);out.defined=true;
    edge(first,out,'memory/control-join');
    edge(second,out,'memory/control-join');
    if(!bySecond){bySecond=new Map();internedPairs.set(first.key,bySecond);}
    bySecond.set(second.key,out.handle);
    return out.handle;
  }
  function joinHandles(...items) {
    guard.take('workItems', items.length);
    if(items.length===2) {
      const raw0=items[0], raw1=items[1];
      if(raw0==null && raw1==null) return clean.handle;
      if(raw0==null) return resolve(raw1).handle;
      if(raw1==null) return resolve(raw0).handle;
      const n0=resolve(raw0), n1=resolve(raw1);
      if(n0.key===n1.key) return n0.handle;
      return n0.key<n1.key ? internPair(n0,n1) : internPair(n1,n0);
    }
    const inputs=items.filter(x=>x!=null).map(resolve);
    if(!inputs.length) return clean.handle;
    const unique=[...new Map(inputs.map(n=>[n.key,n])).values()].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
    if(unique.length===1) return unique[0].handle;
    if(unique.length===2) return internPair(unique[0],unique[1]);
    const key=JSON.stringify(unique.map(n=>n.key));
    if(interned.has(key)) return interned.get(key);
    const out=ensureKey(`memory:${joinCounter++}`);out.defined=true;
    for(const input of unique) edge(input,out,'memory/control-join');
    interned.set(key,out.handle);return out.handle;
  }
  guard.take('sources',options.models.sources.length);guard.take('sinks',modelSinks.length);
  for(const source of options.models.sources) {
    const n=resolve(source.valueId);n.seed=join(n.seed,sourceTaint(source.id));n.defined=true;
  }
  for(const sink of modelSinks) {
    if(sink.observationId!=null) ensureKey(`observation:${sink.observationId}`);
    else resolve(sink.valueId);
  }
  for(const sanitizer of options.models.sanitizers) resolve(sanitizer.valueId);
  function observeMemory(id,inputs,control=null) {
    const node=ensureKey(`observation:${id}`);
    node.observationId=id;
    return value(node.handle,inputs,'terminal-memory',{control});
  }
  function solve({partial=false}={}) {
    guard.check();
    for(const n of nodes.values()) if(!n.defined||partial) n.seed=TAINT_TOP;
    guard.take('workItems',nodes.size); // Reserve the initial work-list before allocation.
    const queue=[];
    for(const n of nodes.values()) { n.inQueue=true; queue.push(n); }
    let head=0;
    while(head<queue.length) {
      guard.take('workItems');
      const n=queue[head++];n.inQueue=false;
      let next=UNTAINTED;
      const inNodes=n.inputNodes;
      for(let i=0;i<inNodes.length;i++) {guard.take('workItems');next=join(next,inNodes[i].state);}
      if(n.sanitizer?.scope==='value') {
        guard.take('workItems',n.sanitizer.removeSources.length+(next.sources?.length??0));
        next=filterTaint(next,n.sanitizer.removeSources);
      }
      next=join(n.state,join(n.seed,next)); // Widened TOP is absorbing; a fixed point never narrows.
      guard.take('workItems',1+(n.state.sources?.length??0)+(next.sources?.length??0));
      if(sameTaint(n.state,next)) continue;
      if(n.updates>=maxUpdates) guard.fail('budget:updatesPerValue');
      // Widen on the last available update, retaining a conservative upper bound.
      if(n.updates===maxUpdates-1 && next.kind!=='top') {next=TAINT_TOP;widened=true;}
      n.state=next;n.updates++;maxActualUpdates=Math.max(maxActualUpdates,n.updates);
      const outNodes=n.outputNodes;
      for(let i=0;i<outNodes.length;i++) {
        const out=outNodes[i];
        if(!out.inQueue) {
          // Queue allocation is charged before append, including duplicate revisits.
          guard.take('workItems');queue.push(out);out.inQueue=true;
        }
      }
    }
    guard.take('emittedRecords',nodes.size+edges.length+modelSinks.length+1+2*(options.models.sources.length+modelSinks.length+options.models.sanitizers.length)); // Includes the summary evidence record.
    const values=Object.freeze([...nodes.values()].map(n=>Object.freeze({id:n.key,valueId:n.semanticId,...(n.observationId!=null?{observationId:n.observationId}:{}),taint:n.state})));
    const sinks=Object.freeze(modelSinks.map(s=>Object.freeze({...s,taint:s.observationId!=null?nodes.get(`observation:${s.observationId}`).state:resolve(s.valueId).state})));
    guard.check();
    return Object.freeze({values,edges:Object.freeze(edges.slice()),sinks,widened,
      unknownSanitizers:Object.freeze(options.models.sanitizers.filter(s=>s.scope!=='value').map(s=>s.id))});
  }
  return Object.freeze({identity:guard.identity,value,joinHandles,observeMemory,solve,check:guard.check,
    labels:Object.freeze({clean:clean.handle,unknown:top.handle,join:(a,b)=>joinHandles(a,b)}),
    remainingMilliseconds:guard.remainingMilliseconds,
    metrics:()=>Object.freeze({...guard.metrics(),updatesPerValue:maxActualUpdates})});
}
