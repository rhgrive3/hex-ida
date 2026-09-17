/**
 * Finite-trace byte memory, lowered to the canonical Bool/BV DAG (NOT Array sort).
 * Initial reads implement a single arbitrary function: r_i = ite(a_i=a_j,r_j,...,fresh_i).
 * Ordered byte writes implement read-over-write. Thus equal addresses cannot acquire
 * independent initial values, even across forks. The shared arena contains only the
 * initial function and the query-wide budget; mutable stores are path-local.
 */
import {
  bvSort, createBv, createBool, createFreshSymbol, createCompare, createBinary,
  createIte, createExtract, createConcat,
} from '../expr/index.js';
import { inspectMemoryExpressions as collectSymbols } from './expression-contract.js';
import { createQueryGuard, QueryFailure, boundedLimit, sameMemoryIdentity } from './query-state.js';

const LIMITS = Object.freeze({ concreteMemoryBytes: 65536, symbolicMemoryCells: 4096,
  storeHistoryEntries: 4096, aliasForks: 16, workItems: 250000,
  expressionNodes: 100000, allocationUnits: 1000000, memoryObservationRecords: 4096 });
const states = new WeakMap();
const noLabels = Object.freeze({ clean: null, unknown: null, join: () => null });
const sizes = new Set([1, 2, 4, 8]);
function primitiveInteger(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new QueryFailure('unsafe-integer');
}
// Structural equality, not a name/string/hash/solver-boolean alias heuristic.
// Calls are bounded by the validated term size and the query work budget.
function children(expr) {
  if (['unary','extract','cast'].includes(expr.kind)) return [expr.arg];
  if (['binary','compare','concat'].includes(expr.kind)) return [expr.left,expr.right];
  if (expr.kind === 'connective') return expr.args;
  if (expr.kind === 'ite') return [expr.cond,expr.thenExpr,expr.elseExpr];
  return [];
}
export function assertMemoryExpr(expr, guard, width = null) {
  const available=guard.limits.workItems-guard.metrics().workItems;
  if(available<1) guard.fail('budget:workItems');
  const validated=collectSymbols([expr],{maxExprNodes:available,maxExprDepth:128,guard});
  if(validated.limitExceeded) guard.fail('budget:workItems');
  if(validated.unsupportedReason||validated.depthExceeded) throw new QueryFailure(validated.unsupportedReason??'expression-depth');
  const work = [[expr,0]], seen = new Set();
  while (work.length) {
    guard.take('workItems');
    const [node,depth] = work.pop();
    if (!node || !Object.isFrozen(node) || !Object.isFrozen(node.sort) || depth > 128 ||
        !['const','fresh_symbol','unary','binary','compare','connective','ite','extract','concat','cast'].includes(node.kind) ||
        !['bool','bv'].includes(node.sort?.kind)) throw new QueryFailure('unsupported-expression');
    if (node.sort.kind === 'bv' && (!Number.isSafeInteger(node.sort.width) || node.sort.width < 1 || node.sort.width > 64)) throw new QueryFailure('unsupported-width');
    if (node.kind==='fresh_symbol' && (typeof node.symbolId!=='string'||!node.symbolId)) throw new QueryFailure('missing-canonical-symbol-id');
    if (seen.has(node)) continue;
    seen.add(node);
    for (const child of children(node)) work.push([child,depth+1]);
  }
  if (width != null && (expr.sort.kind !== 'bv' || expr.sort.width !== width)) throw new QueryFailure('width-mismatch');
  return expr;
}
function sameTerm(a,b,guard) {
  const work=[[a,b]],seen=new Map();
  while(work.length) {
    guard.take('workItems');
    const [x,y]=work.pop();if(x===y) continue;
    if(x.kind!==y.kind||x.sort.kind!==y.sort.kind||x.sort.width!==y.sort.width) return false;
    if(x.kind==='fresh_symbol') {if(x.symbolId!==y.symbolId) return false;continue;}
    if(['value','op','high','low','targetWidth'].some(k=>x[k]!==y[k])) return false;
    if(seen.get(x)?.has(y)) continue;
    if(!seen.has(x)) seen.set(x,new Set());seen.get(x).add(y);
    const xs=children(x),ys=children(y);if(xs.length!==ys.length) return false;
    for(let i=0;i<xs.length;i++) work.push([xs[i],ys[i]]);
  }
  return true;
}
function makeState(arena, copy = null) {
  const state = { arena, current: new Map(copy?.current ?? []), history: copy?.history.slice() ?? [],
    mode: copy?.mode ?? 'concrete', symbolicWrites: copy?.symbolicWrites ?? false,
    parents: copy?.parents ?? null, depth: copy?.depth ?? 0, barrier: copy?.barrier ?? null };
  const { guard, bits, endian, labels } = arena;
  const node = (fn) => { guard.take('expressionNodes'); return fn(); };
  function eq(a,b) {
    guard.take('workItems');
    if (a === b || sameTerm(a,b,guard)) return createBool(true);
    if (a.kind === 'const' && b.kind === 'const') return createBool(a.value === b.value);
    return node(()=>createCompare('eq',a,b));
  }
  function choose(condition, yes, no) {
    if (condition.kind === 'const') return condition.value ? yes : no;
    return Object.freeze({ expression: node(()=>createIte(condition,yes.expression,no.expression)),
      label: labels.join(yes.label,no.label) });
  }
  function address(value) {
    if (value && typeof value === 'object') return assertMemoryExpr(value,guard,bits);
    const n=primitiveInteger(value);
    if (n<0n || n >= (1n<<BigInt(bits))) throw new QueryFailure('address-out-of-range');
    return createBv(bits,n);
  }
  function access(value,size,options={}) {
    guard.check(options.identity ?? arena.identity);
    if (state.barrier) throw new QueryFailure(state.barrier);
    if (!sizes.has(size)) throw new QueryFailure('unsupported-access-width');
    if (options.addressSpace != null && options.addressSpace !== arena.identity.addressSpace) throw new QueryFailure('address-space-mismatch');
    if (options.volatile != null && options.volatile !== false || options.atomic != null && options.atomic !== false) {
      state.barrier=options.volatile ? 'volatile-barrier' : 'atomic-barrier';
      throw new QueryFailure(state.barrier);
    }
    const a=address(value);
    if (arena.alignment === 'natural' && size>1 && (a.kind!=='const' || a.value%BigInt(size)!==0n)) throw new QueryFailure('alignment-unproved');
    if (arena.wrapping === 'reject' && size>1 && (a.kind!=='const' || a.value+BigInt(size)>(1n<<BigInt(bits)))) throw new QueryFailure('address-wrap-unproved');
    guard.take('allocationUnits',size);
    return Array.from({length:size},(_,i)=> {
      if (!i) return a;
      return a.kind==='const' ? createBv(bits,a.value+BigInt(i)) : node(()=>createBinary('add',a,createBv(bits,BigInt(i))));
    });
  }
  function initialByte(a) {
    guard.take('workItems');
    if (a.kind==='const' && arena.initial.has(a.value)) return arena.initial.get(a.value);
    for (const prior of arena.reads) {
      guard.take('workItems');
      if (a === prior.address || sameTerm(a,prior.address,guard)) return prior.byte;
    }
    guard.take('symbolicMemoryCells'); guard.take('allocationUnits',2);
    const expression=node(()=>createFreshSymbol(bvSort(8),`mem_${arena.reads.length}`,{queryId:arena.identity.queryId,source:'initial-byte'}));
    arena.initialSymbols.add(expression);
    let byte=Object.freeze({expression,label:labels.unknown});
    // Every earlier read participates, including expressions observed by sibling paths.
    for (const prior of arena.reads) byte=choose(eq(a,prior.address),prior.byte,byte);
    for (const [key,known] of arena.initial) byte=choose(eq(a,createBv(bits,key)),known,byte);
    arena.reads.push(Object.freeze({address:a,byte}));
    return byte;
  }
  function readByte(a, currentState=state) {
    guard.take('workItems');
    if (currentState.barrier) throw new QueryFailure(currentState.barrier);
    if (!currentState.symbolicWrites && !currentState.parents && a.kind==='const' && currentState.current.has(a.value)) return currentState.current.get(a.value);
    // Check exact last writes before constructing an unnecessary unknown base.
    let lastExact=-1;
    for (let i=currentState.history.length-1;i>=0;i--) {
      const c=eq(a,currentState.history[i].address);
      if (c.kind==='const' && c.value) { lastExact=i;break; }
    }
    let byte;
    if (lastExact>=0) byte=currentState.history[lastExact].byte;
    else if (currentState.parents) {
      const p=currentState.parents;
      byte=choose(p.condition,readByte(a,p.yes),readByte(a,p.no));
      byte=Object.freeze({...byte,label:labels.join(byte.label,p.label)});
    } else byte=initialByte(a);
    for (let i=lastExact+1;i<currentState.history.length;i++) {
      const store=currentState.history[i]; byte=choose(eq(a,store.address),store.byte,byte);
    }
    return byte;
  }
  function outcome(action) {
    try { const result=action();guard.check();return Object.freeze({...result,identity:arena.identity,mode:state.mode}); }
    catch(error) {
      if (!(error instanceof QueryFailure)) throw error;
      // An unsupported access cannot be followed by an exact observation of stale memory.
      state.barrier ||= error.reason;
      return Object.freeze({status:'unknown',reason:error.reason,expression:null,label:labels.unknown,identity:arena.identity,mode:state.mode});
    }
  }
  const api=Object.freeze({
    identity:arena.identity, addressBits:bits, endian, wrapping:arena.wrapping,
    load(value,size,options={}) { return outcome(()=> {
      const addresses=access(value,size,options);
      if (addresses.some(a=>a.kind!=='const')) state.mode='bounded-bv';
      const bytes=addresses.map(a=>readByte(a));
      const ordered=endian==='little' ? bytes.slice().reverse() : bytes;
      let expression;
      if (ordered.every(b=>b.expression.kind==='const')) {
        expression=createBv(size*8,ordered.reduce((n,b)=>(n<<8n)|b.expression.value,0n));
      } else expression=ordered.map(b=>b.expression).reduce((left,right)=>node(()=>createConcat(left,right)));
      assertMemoryExpr(expression,guard,size*8);
      const label=bytes.map(b=>b.label).reduce((a,b)=>labels.join(a,b),labels.clean);
      return {status:expression.kind==='const'?'concrete':'symbolic',expression,label,bytes:Object.freeze(bytes)};
    }); },
    store(value,size,stored,options={}) { return outcome(()=> {
      const addresses=access(value,size,options);
      const expression=stored && typeof stored==='object' ? assertMemoryExpr(stored,guard,size*8) : createBv(size*8,primitiveInteger(stored));
      guard.take('storeHistoryEntries',size); guard.take('allocationUnits',size);
      const symbolic=addresses.some(a=>a.kind!=='const');
      const added=new Set(addresses.filter(a=>a.kind==='const'&&!state.current.has(a.value)).map(a=>a.value));
      guard.take('concreteMemoryBytes',added.size);
      if (symbolic || expression.kind!=='const') guard.take('symbolicMemoryCells',size);
      if (symbolic) { state.mode='bounded-bv';state.symbolicWrites=true; }
      for(let i=0;i<size;i++) {
        const lane=endian==='little'?i:size-1-i;
        const byte=Object.freeze({expression:expression.kind==='const'?createBv(8,expression.value>>BigInt(lane*8)):node(()=>createExtract(expression,lane*8+7,lane*8)),label:options.label ?? labels.unknown});
        state.history.push(Object.freeze({address:addresses[i],byte}));
        if(addresses[i].kind==='const') state.current.set(addresses[i].value,byte);
      }
      return {status:'stored'};
    }); },
    barrier(reason='unknown-clobber') {
      guard.check();
      // Invalidation is irreversible for this state, including malformed labels.
      const code = typeof reason === 'string' && reason.trim() && reason.length <= 1024
        ? reason : 'unknown-clobber';
      state.barrier ||= code;
      return Object.freeze({status:'unknown',reason:state.barrier});
    },
    fork() {
      guard.check();guard.take('aliasForks');guard.take('allocationUnits',state.current.size+state.history.length);
      return makeState(arena,state);
    },
    check(current) { guard.check(current); if(state.barrier) throw new QueryFailure(state.barrier); },
    // Executor/translation work shares this query's prechecked resource authority.
    validateExpression(expression, width = null) { guard.check(); return assertMemoryExpr(expression, guard, width); },
    chargeExecution(work = 1, allocation = 0) { guard.take('workItems', work); guard.take('allocationUnits', allocation); },
    chargeMemoryObservations() { guard.take('memoryObservationRecords'); },
    metrics:guard.metrics,
  });
  states.set(api,state);return api;
}
export function createByteMemory(options={}) {
  const guard=createQueryGuard(options,LIMITS);
  const bits=boundedLimit(options.addressBits,64,64,'addressBits');
  if(bits<1) throw new TypeError('addressBits must be positive');
  const endian=options.endian ?? 'little',wrapping=options.wrapping ?? 'reject',alignment=options.alignment ?? 'unaligned';
  if(!['little','big'].includes(endian)||!['reject','modular'].includes(wrapping)||!['unaligned','natural'].includes(alignment)) throw new TypeError('invalid memory geometry');
  const labels=options.labelDomain ?? noLabels;
  const initial=new Map();
  const entries=options.initialBytes ?? [];
  if(!Array.isArray(entries)) throw new TypeError('initialBytes must be [address,byte] pairs');
  // Reserve before walking/allocating a potentially huge caller array.
  guard.take('concreteMemoryBytes',entries.length);guard.take('allocationUnits',entries.length);
  for(const entry of entries) {
    guard.take('workItems');
    if(!Array.isArray(entry)||entry.length!==2) throw new TypeError('invalid initial byte');
    const a=primitiveInteger(entry[0]),b=primitiveInteger(entry[1]);
    if(a<0n||a>=(1n<<BigInt(bits))||b<0n||b>255n||initial.has(a)) throw new TypeError('invalid/duplicate initial byte');
    initial.set(a,Object.freeze({expression:createBv(8,b),label:labels.clean}));
  }
  const arena={guard,identity:guard.identity,bits,endian,wrapping,alignment,initial,labels,reads:[],initialSymbols:new WeakSet(),lifecycle:Object.freeze({signal:options.signal,isCancelled:options.isCancelled,getCurrentIdentity:options.getCurrentIdentity,now:options.now})};
  return makeState(arena);
}
export function joinByteMemory(condition,yes,no,label=null) {
  const a=states.get(yes),b=states.get(no);
  if(!a||!b||a.arena!==b.arena) throw new QueryFailure('unrelated-memory-states');
  const {guard}=a.arena;
  assertMemoryExpr(condition,guard);
  if(condition.sort.kind!=='bool') throw new QueryFailure('join-condition-sort');
  guard.take('aliasForks');guard.take('allocationUnits',a.current.size+a.history.length+b.current.size+b.history.length);
  if(Math.max(a.depth,b.depth)>=16) guard.fail('budget:merge-depth');
  // Capture independent states; later writes in either parent cannot mutate the join.
  const capture=s=>({...s,current:new Map(s.current),history:s.history.slice()});
  return makeState(a.arena,{current:[],history:[],mode:'bounded-bv',symbolicWrites:true,depth:Math.max(a.depth,b.depth)+1,
    parents:Object.freeze({condition,yes:capture(a),no:capture(b),label}),barrier:a.barrier||b.barrier});
}

/** Share only a genuine query arena; mutable store histories are independently forked.
 * Used for paired executions, not restoration from a serialized memory object.
 */
export function forkByteMemoryForExecution(memory, options) {
  const state = states.get(memory);
  if (!state || !sameMemoryIdentity(options.identity, state.arena.identity)) throw new QueryFailure('unissued-or-unrelated-memory-state');
  for (const [key, actual] of [['addressBits',state.arena.bits],['endian',state.arena.endian],
    ['wrapping',state.arena.wrapping],['alignment',state.arena.alignment]]) {
    if (options[key] != null && options[key] !== actual) throw new QueryFailure('initial-memory-geometry-mismatch');
  }
  for (const key of ['signal','isCancelled','getCurrentIdentity','now']) {
    if (options[key] != null && options[key] !== state.arena.lifecycle[key]) throw new QueryFailure('initial-memory-lifecycle-conflict');
  }
  if (options.limits != null) throw new QueryFailure('initial-memory-budget-override');
  if (options.timeoutMs != null && options.timeoutMs < state.arena.guard.remainingMilliseconds()) throw new QueryFailure('initial-memory-deadline-conflict');
  if (options.initialBytes != null || options.labelDomain != null) throw new QueryFailure('initial-memory-options-conflict');
  return memory.fork();
}

/** Complete concrete write set from an issued state, not from supplied IR labels.
 * This is a trace summary, not an alias/reaching-definition analysis. */
export function concreteMemoryWriteFootprint(memory) {
  const state=states.get(memory);
  if(!state)throw new QueryFailure('unissued-memory-state');
  memory.check();
  if(state.symbolicWrites||state.parents)throw new QueryFailure('symbolic-write-footprint');
  memory.chargeExecution(state.history.length,state.history.length);
  const addresses=new Set();
  for(const write of state.history) {
    if(write.address.kind!=='const')throw new QueryFailure('symbolic-write-footprint');
    addresses.add(write.address.value);
  }
  memory.check();
  return Object.freeze([...addresses].sort((a,b)=>a<b?-1:a>b?1:0));
}

/** Every byte address written by an issued finite trace, including symbolic
 * addresses. This is a cover of writes, NOT a guessed alias/NoAlias relation.
 * Duplicates are safe; only identical Expr objects are deduplicated here.
 * A merged state includes both captured parents so no possible write is lost.
 */
export function symbolicMemoryWriteFootprint(memory) {
  const state = states.get(memory);
  if (!state) throw new QueryFailure('unissued-memory-state');
  memory.check();
  memory.chargeExecution(1, 1);
  const pending = [state], visited = new Set(), addresses = new Set();
  while (pending.length) {
    memory.chargeExecution();
    const current = pending.pop();
    if (visited.has(current)) continue;
    if (current.barrier) throw new QueryFailure(current.barrier);
    memory.chargeExecution(1, 1);
    visited.add(current);
    for (const write of current.history) {
      memory.chargeExecution();
      if (!addresses.has(write.address)) {
        memory.chargeExecution(1, 1);
        addresses.add(write.address);
      }
    }
    if (current.parents) {
      memory.chargeExecution(2, 2);
      pending.push(current.parents.yes, current.parents.no);
    }
  }
  memory.chargeExecution(addresses.size, addresses.size);
  memory.check();
  return Object.freeze([...addresses]);
}

/** The metadata string `source:initial-byte` is not an authority token. */
export function isMemoryInitialSymbol(memory, symbol) {
  const state = states.get(memory);
  return !!state && state.arena.initialSymbols.has(symbol);
}
