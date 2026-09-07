import { stableDigest } from '../../core/identity/index.js';
import { expr, mergeSource } from '../ast/nodes.js';

export const EGRAPH_LIMITS = Object.freeze({
  inputNodes:2048, eNodes:4096, eClasses:2048, saturationIterations:8,
  ruleApplications:8192, workItems:50000, extractedCandidates:32, milliseconds:150,
});
const WIDTHS = new Set([8,16,32,64]);
const OPS = new Set(['add','xor','and','or','shl','lshr','ashr']);
const ISSUED = new WeakSet();
const NODE_FIELDS = new Set(['kind','op','bits','signed','effect','name','ssaId','value','left','right','source','floating','volatile']);
export function isEGraphCandidate(candidate) { return ISSUED.has(candidate); }

/** Bounded equality saturation. The result is a proposal, never rewrite authority. */
export function generateEGraphCandidates(root, options = {}) {
  const started = performance.now();
  const metrics = {inputNodes:0,eNodes:0,eClasses:0,saturationIterations:0,ruleApplications:0,workItems:0,extractedCandidates:0};
  const limits = {...EGRAPH_LIMITS};
  const stop = reason => { throw new Error(reason); };
  const result = (status,candidates=[],reason=null) => Object.freeze({status,reason,
    candidates:Object.freeze(candidates),metrics:Object.freeze({...metrics,elapsedMs:performance.now()-started})});
  try {
    for(const key of Object.keys(limits)) {
      if(options.limits?.[key] == null) continue;
      const value=options.limits[key];
      if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>limits[key]
          ||(key!=='milliseconds'&&!Number.isSafeInteger(value))) stop('invalid-limit');
      limits[key]=value;
    }
    const check = () => {
      if(options.shouldAbort != null && (typeof options.shouldAbort!=='function'||options.shouldAbort()===true)) stop('cancelled');
      if(metrics.workItems>=limits.workItems || performance.now()-started>limits.milliseconds) stop('budget');
      metrics.workItems++;
    };
    check();
    const nodes=[], parent=[], memo=new Map(), seen=new WeakMap(), active=new WeakSet();
    const find = id => { while(parent[id]!==id) { check();parent[id]=parent[parent[id]];id=parent[id]; }return id; };
    const key = n => JSON.stringify([n.kind,n.op,n.bits,n.signed,n.name,n.ssaId,n.binding,
      n.value==null?null:String(n.value),...(n.children||[]).map(find)]);
    const add = n => {
      check();const k=key(n);if(memo.has(k)) return find(memo.get(k));
      if(nodes.length>=limits.eNodes || metrics.eClasses>=limits.eClasses) stop('budget');
      const id=nodes.length;nodes.push(n);parent.push(id);memo.set(k,id);
      metrics.eNodes=nodes.length;metrics.eClasses++;return id;
    };
    // Copy bounded data before merging/freezing provenance; never freeze caller data.
    const copyData = (value, activeData = new WeakSet(), depth = 0) => {
      check();
      if(value == null || ['string','boolean','bigint'].includes(typeof value)) return value;
      if(typeof value === 'number' && Number.isFinite(value)) return value;
      if(typeof value !== 'object' || depth > 32 || activeData.has(value)) stop('unsupported-provenance');
      const proto=Object.getPrototypeOf(value);
      if(![null,Object.prototype,Array.prototype].includes(proto)) stop('unsupported-provenance');
      activeData.add(value);
      const out=Array.isArray(value)?[]:Object.create(null);
      for(const name of Reflect.ownKeys(value)) {
        check();if(name==='length' && Array.isArray(value)) continue;
        if(typeof name!=='string') stop('unsupported-provenance');
        const descriptor=Object.getOwnPropertyDescriptor(value,name);
        if(!descriptor || !('value' in descriptor)) stop('accessor-provenance');
        Object.defineProperty(out,name,{value:copyData(descriptor.value,activeData,depth+1),enumerable:true,writable:true,configurable:true});
      }
      activeData.delete(value);return out;
    };
    const read = node => {
      if(!node||typeof node!=='object'||Array.isArray(node)) stop('unsupported-node');
      const out={};
      for(const name of Reflect.ownKeys(node)) if(!NODE_FIELDS.has(name)) stop('unsupported-semantics');
      for(const name of NODE_FIELDS) {
        const descriptor=Object.getOwnPropertyDescriptor(node,name);
        if(descriptor && !('value' in descriptor)) stop('accessor-node');
        out[name]=descriptor?.value;
      }
      out.source=copyData(out.source);
      for(const field of ['addresses','address','rows','row','ir','irId','ssaDefs','ssaDef','ssaUses','ssaUse']) {
        const value=out.source?.[field];
        if(value!=null && (Array.isArray(value)?value:[value]).some(x=>!['string','number','bigint'].includes(typeof x))) stop('unsupported-provenance');
      }
      return out;
    };
    const visit = (raw,depth=0) => {
      check();if(depth>256||active.has(raw)) stop('cyclic-or-deep-input');
      if(seen.has(raw))return seen.get(raw);
      if(metrics.inputNodes>=limits.inputNodes)stop('budget');
      metrics.inputNodes++;
      const n=read(raw);if(!WIDTHS.has(n.bits)||n.effect!=='pure'||n.floating===true||n.volatile===true)stop('unsupported-semantics');
      if(n.signed!=null&&typeof n.signed!=='boolean')stop('unsupported-signedness');
      n.signed??=null;active.add(raw);
      if(n.kind==='const') { if(typeof n.value!=='bigint')stop('noncanonical-constant');n.value=BigInt.asUintN(n.bits,n.value); }
      else if(n.kind==='var') {
        if(typeof n.name!=='string'||!n.name)stop('variable-identity-required');
        if(n.ssaId!=null && !(typeof n.ssaId==='string' || Number.isSafeInteger(n.ssaId)))stop('variable-identity-required');
        n.binding=n.source?.ssaDefs??n.source?.ssaDef??null;
      } else if(n.kind==='binary'&&OPS.has(n.op)) {
        n.children=[visit(n.left,depth+1),visit(n.right,depth+1)];
        if(n.children.some(id=>nodes[id].bits!==n.bits))stop('width-mismatch');
      } else stop('unsupported-semantics');
      const id=add(n);seen.set(raw,id);active.delete(raw);return id;
    };
    const rootId=visit(root);
    const inputDigest=stableDigest(nodes.map(n=>[key(n),n.source??null]));
    const origins=mergeSource(...nodes.map(n=>n.source));
    if(!origins.ir.length&&!origins.addresses.length&&!origins.rows.length)stop('origin-required');
    const union = (a,b) => {
      check();a=find(a);b=find(b);if(a===b)return false;
      if(nodes[a].bits!==nodes[b].bits||nodes[a].signed!==nodes[b].signed)return false;
      if(metrics.ruleApplications>=limits.ruleApplications)stop('budget');
      metrics.ruleApplications++;
      parent[Math.max(a,b)]=Math.min(a,b);metrics.eClasses--;return true;
    };
    const constant = (id,value) => nodes.some((n,index)=>{
      check();return n.kind==='const'&&find(index)===find(id)&&n.value===value;
    });
    let converged=false;
    for(let iteration=0;iteration<limits.saturationIterations;iteration++) {
      check();metrics.saturationIterations++;let changed=false;
      for(const [id,n] of [...nodes.entries()]) {
        check();if(n.kind!=='binary')continue;
        const [a,b]=n.children.map(find);
        if((n.op==='add'||n.op==='or'||n.op==='xor')&&constant(b,0n))changed=union(id,a)||changed;
        if((n.op==='add'||n.op==='or'||n.op==='xor')&&constant(a,0n))changed=union(id,b)||changed;
        if(n.op==='and'&&constant(b,(1n<<BigInt(n.bits))-1n))changed=union(id,a)||changed;
        if(n.op==='and'&&constant(a,(1n<<BigInt(n.bits))-1n))changed=union(id,b)||changed;
        if(n.op==='xor'&&a===b)changed=union(id,add({kind:'const',bits:n.bits,signed:n.signed,value:0n,source:n.source}))||changed;
        if(['shl','lshr','ashr'].includes(n.op)&&constant(b,0n))changed=union(id,a)||changed;
      }
      // Restore congruence after unions, including equivalent parent expressions.
      memo.clear();
      for(const [id,n] of nodes.entries()) {check();const k=key(n);if(memo.has(k))changed=union(id,memo.get(k))||changed;else memo.set(k,id);}
      if(!changed){converged=true;break;}
    }
    if(!converged)stop('budget');
    const best=new Map();
    for(let iteration=0;iteration<nodes.length;iteration++) {
      check();let changed=false;
      for(const [id,n] of nodes.entries()) {
        check();const children=(n.children||[]).map(child=>best.get(find(child)));
        if(children.some(child=>!child))continue;
        const cost=1+children.reduce((sum,child)=>sum+child.cost,0), owner=find(id);
        if(best.has(owner)&&best.get(owner).cost<=cost)continue;
        let expression;
        if(n.kind==='const')expression=expr.constant(n.value,n.bits,n.signed,origins);
        else if(n.kind==='var')expression=expr.variable(n.name,n.bits,n.signed,n.source,{ssaId:n.ssaId});
        else expression=expr.binary(n.op,children[0].expression,children[1].expression,n.bits,n.signed,origins);
        best.set(owner,{cost,expression});changed=true;
      }
      if(!changed)break;
    }
    const extracted=best.get(find(rootId));
    if(!extracted||extracted.cost>=metrics.inputNodes)return result('complete');
    if(limits.extractedCandidates<1)stop('budget');
    check();
    const freeze = n => {if(!n||typeof n!=='object'||Object.isFrozen(n))return n;for(const value of Object.values(n))freeze(value);return Object.freeze(n);};
    const candidate=Object.freeze({expression:freeze(extracted.expression),origin:freeze(origins),inputDigest,proofRequired:true});
    ISSUED.add(candidate);metrics.extractedCandidates=1;
    return result('complete',[candidate]);
  } catch(error) {
    const reason=error?.message??'unsupported';
    return result(reason==='cancelled'?'cancelled':reason==='budget'?'budget':'unsupported',[],reason);
  }
}
