/** Issued terminal-path values. This is a query-local capability, not a static
 * MemorySSA fact and not a proof of a whole function's memory/effect behavior.
 * IR remains caller-owned: we compare the execution-relevant object graph both
 * before publication and on consumption rather than freezing or mutating it.
 */
import { concreteMemoryWriteFootprint, symbolicMemoryWriteFootprint } from './byte-memory.js';
import { queryArray } from './data-input.js';
import { semanticValueIdentity } from './value-identity.js';
import { QueryFailure, sameMemoryIdentity } from './query-state.js';
import { createUnknownSemantic, createBv, bvSort } from '../expr/index.js';
import { createAssumption, createCompleteness, ASSUMPTION_TRUST } from '../translate/support-matrix.js';

const issued = new WeakMap();
const executions = new WeakMap();
const SHAPES = Object.freeze({
  ir: {entry:null,blocks:'blocks',instructions:'insts',values:'values',functionId:null,semanticIrVersion:null,truncated:null,architecture:null,arch:null,abiId:null,semanticsVersion:null,snapshotId:null,binaryId:null},
  block: {index:null,insts:'insts',phis:'insts',succ:'scalars'},
  inst: {id:null,op:null,sub:null,subOp:null,name:null,args:'args',dst:'value',incoming:'incoming',cond:'inst',signed:null,float:null,bits:null,conditionValue:'value',row:null,address:null,addr:'addr',loc:'loc',extra:'extra',volatile:null,atomic:null,value:null},
  value: {id:null,bits:null,kind:null,const:null,float:null,floatConst:null,constKind:null,reg:null,index:null,def:'inst',semanticValueId:null,semanticSsaValueId:null,machineType:'machineType'},
  machineType: {kind:null,widthBits:null},
  argument: {value:'value',bits:null}, incomingItem: {from:null,value:'value'},
  addr: {base:'value',index:'value',disp:null,size:null,widthBits:null,precise:null,addressSpace:null},
  loc: {kind:null,key:null,address:null,size:null,disp:null,addressSpace:null,volatile:null,atomic:null},
  extra: {stateWrite:null,value:null,constKind:null,kind:null,bit:null,target:null,size:null,widthBits:null,memoryAccess:'descriptor',signed:null,float:null,sourceBits:null,targetBits:null,lsb:null,width:null,toward:null,bitfieldKind:null,volatile:null,atomic:null,addressPrecise:null,addressSemantic:null,completeness:null,attributes:'attributes'},
  attributes: {float:null,machineAddressExpression:'expression',machineEffects:'machineEffects'},
  machineEffects: {bundleCompleteness:null,operationMetadata:'operationMetadata'},
  operationMetadata: {divisionByZero:null,signedOverflow:null,widthBits:null},
  expression: {kind:null,widthBits:null,left:'expression',right:'expression',value:'expression',amount:null,fromBits:null,toBits:null,temporaryId:null},
  descriptor: {faults:'scalars',alignment:null,widthBits:null,addressSpace:null,endian:null,atomic:null,volatility:null,ordering:null,addressExpr:'addressExpr'},
  addressExpr: {valueId:null},
});
const ARRAYS = {blocks:'block',insts:'inst',values:'value',args:'argument',incoming:'incomingItem',scalars:null};
function property(object,key) {
  const descriptor=Object.getOwnPropertyDescriptor(object,key);
  if (descriptor && !Object.hasOwn(descriptor,'value')) throw new QueryFailure('ir-accessor');
  if (!descriptor && key in object) throw new QueryFailure('inherited-ir-property');
  return {present:!!descriptor,value:descriptor?.value};
}
function captureContract(ir,memory) {
  const pending=[[ir,'ir']],seen=new Map(),records=[];
  while(pending.length) {
    memory.chargeExecution();
    const [object,mode]=pending.pop();
    if(object==null || typeof object!=='object') continue;
    if(seen.get(object)?.has(mode)) continue;
    const arrayMode=Object.hasOwn(ARRAYS,mode);
    if(arrayMode && !Array.isArray(object)) throw new QueryFailure('invalid-ir-array');
    const proto=Object.getPrototypeOf(object);
    if(!arrayMode && proto!==Object.prototype && proto!==null) throw new QueryFailure('non-data-ir-object');
    const keys=arrayMode ? null : Object.keys(SHAPES[mode]);
    const size=arrayMode?object.length:keys.length;
    memory.chargeExecution(size+1,size+1);
    if(!seen.has(object)) seen.set(object,new Set());seen.get(object).add(mode);
    const entries=[];
    for(let i=0;i<size;i++) {
      const key=arrayMode?String(i):keys[i];
      const value=property(object,key);
      entries.push([key,value]);
      const childMode=arrayMode?ARRAYS[mode]:SHAPES[mode][key];
      if(childMode && value.value!=null && typeof value.value==='object') pending.push([value.value,childMode]);
    }
    records.push({object,proto,entries,length:arrayMode?size:null});
  }
  // The number of comparisons is fixed and was charged before capture. Accesses
  // cannot become an unbounded traversal when a caller replaces a subtree.
  const work=records.reduce((sum,record)=>sum+record.entries.length+1,0);
  return {work,check:() => {
    for(const record of records) {
      if(Object.getPrototypeOf(record.object)!==record.proto || record.length!=null && record.object.length!==record.length) throw new QueryFailure('stale-ir');
      for(const [key,before] of record.entries) {
        const after=property(record.object,key);
        if(before.present!==after.present || !Object.is(before.value,after.value)) throw new QueryFailure('stale-ir');
      }
    }
  }};
}
export function createExecutionCapture(ir,memory,options={}) {
  const contract=captureContract(ir,memory);
  const identity=memory.identity;
  const signal=options.signal ?? options.byteMemory?.signal;
  const cancelled=options.isCancelled ?? options.byteMemory?.isCancelled;
  const getCurrentIdentity=options.byteMemory?.getCurrentIdentity;
  const check=()=>{
    if(signal?.aborted) throw new QueryFailure('cancelled');
    const stopped=cancelled?.();if(stopped || signal?.aborted) throw new QueryFailure('cancelled');
    if(getCurrentIdentity && !sameMemoryIdentity(identity,getCurrentIdentity())) throw new QueryFailure('stale-identity');
    if(signal?.aborted) throw new QueryFailure('cancelled');
    const stoppedAfter=cancelled?.();if(stoppedAfter || signal?.aborted) throw new QueryFailure('cancelled');
    // Observers are allowed to revoke state. Validate data after their final call.
    contract.check();
    if(signal?.aborted) throw new QueryFailure('cancelled');
  };
  const checkActive=()=>{memory.chargeExecution(contract.work);check();memory.chargeExecution(0);};
  return Object.freeze({
    check:checkActive,
    publish(result) { checkActive();executions.set(result,{ir,check});return result; },
    capture(state,pathIndex,memoryObservations=Object.freeze([])) {
      memory.check();checkActive();
      memory.chargeExecution(state.values.size+state.scalarCache.size,state.values.size+state.scalarCache.size);
      const values=new Map([...state.scalarCache,...state.values]);
      const byTarget=new Map(),publicValues=[];
      for(const [rawId,expression] of values) {
        const entry=state.valueIdentities.get(rawId);
        if(!entry) throw new QueryFailure('unregistered-executed-value');
        memory.validateExpression(expression);
        byTarget.set(entry.value,expression);
        if(entry.value.def) byTarget.set(entry.value.def,expression);
        publicValues.push(Object.freeze({valueId:entry.id,bits:entry.bits,expression}));
      }
      const snapshot=Object.freeze({schemaVersion:'hex-execution-snapshot/v1',identity,pathIndex,
        values:Object.freeze(publicValues),memoryObservations,assumptions:Object.freeze([...(options.memoryAssumptions?.values() ?? [])]),constraints:Object.freeze(state.constraints.slice())});
      issued.set(snapshot,{ir,byTarget,check,memory:state.byteMemory});
      return snapshot;
    },
  });
}
export function isExecutionResult(result,identity,ir=null) {
  const record=executions.get(result);
  if(!record)return false;
  if(identity === undefined) identity = result.identity;
  if(!sameMemoryIdentity(result.identity,identity) || ir && ir!==record.ir) return false;
  try { record.check();return true; } catch {return false;}
}
export function isExecutionSnapshot(snapshot,identity,ir=null) {
  const record=issued.get(snapshot);
  if(!record)return false;
  if(identity === undefined) identity = snapshot.identity;
  if(!sameMemoryIdentity(snapshot.identity,identity) || ir && record.ir!==ir) return false;
  try { record.check();return true; } catch {return false;}
}
/** Called from the existing translateSemanticIR entrypoint. No fallback on an
 * invalid supplied capability: static translation must not redeem stale state.
 */
export function translateExecutedTarget(target,options) {
  const snapshot=options.executionSnapshot, record=issued.get(snapshot);
  let reason='stale-or-unissued-execution-snapshot';
  const expression=record?.byTarget.get(target);
  if(record && isExecutionSnapshot(snapshot,options.identity,options.ir) && options.ir===record.ir && options.identity) {
    if(Object.hasOwn(options,'symbolicArgs') || options.fromBlock!=null) reason='execution-options-conflict';
    else if(!expression) reason='target-not-executed-in-snapshot';
    else if(options.bitWidth!=null && expression.sort.kind==='bv' && options.bitWidth!==expression.sort.width) reason='execution-width-mismatch';
    else {
      const value=target?.dst ?? target;
      const assumption=createAssumption({id:`execution:${snapshot.pathIndex}:${semanticValueIdentity(value)}`,kind:'bounded-execution-snapshot',
        statement:'Value of this terminal path only; initial byte function, identity and path constraints are part of the scope.',
        source:'symbolic-executor',originIds:[semanticValueIdentity(value)],trust:ASSUMPTION_TRUST.QUERY_SCOPE});
      return Object.freeze({status:'exact_with_assumptions',expression,assumptions:Object.freeze([assumption]),
        pathConstraints:snapshot.constraints,memoryAssumptions:snapshot.assumptions,identity:snapshot.identity,executionSnapshot:snapshot,
        semanticUnknowns:0,unsupportedEntities:Object.freeze([]),originMap:Object.freeze({}),
        completeness:createCompleteness({pathCoverage:'partial',queryScope:'partial'})});
    }
  }
  const width=Number.isSafeInteger(options.bitWidth) && options.bitWidth>0 && options.bitWidth<=64 ? options.bitWidth : 64;
  return Object.freeze({status:'unsupported',expression:createUnknownSemantic(bvSort(width),reason),reason,
    semanticUnknowns:1,assumptions:Object.freeze([]),unsupportedEntities:Object.freeze([Object.freeze({reason})]),originMap:Object.freeze({}),
    completeness:createCompleteness({translation:'unsupported',memoryEffects:'partial',controlFlow:'partial',pathCoverage:'partial',queryScope:'partial'})});
}

/** Exact target-object membership, not a name/ID-derived proof authority. */
export function isExecutionSnapshotTarget(snapshot,target,identity=snapshot?.identity,ir=null) {
  return isExecutionSnapshot(snapshot,identity,ir) && issued.get(snapshot).byTarget.has(target);
}

/** Internal proof consumer bridge: only a genuine, current terminal snapshot
 * can expose the complete write footprint or read its private final memory. */
export function executionWriteFootprint(snapshot, identity, ir) {
  if(!isExecutionSnapshot(snapshot,identity,ir))throw new QueryFailure('stale-execution');
  return concreteMemoryWriteFootprint(issued.get(snapshot).memory);
}
export function executionSymbolicWriteFootprint(snapshot, identity, ir) {
  if (!isExecutionSnapshot(snapshot,identity,ir)) throw new QueryFailure('stale-execution');
  return symbolicMemoryWriteFootprint(issued.get(snapshot).memory);
}
export function observeExecutionBytes(snapshot, addresses, identity, ir) {
  if(!isExecutionSnapshot(snapshot,identity,ir))throw new QueryFailure('stale-execution');
  const memory=issued.get(snapshot).memory;
  if(!Array.isArray(addresses)||addresses.length>4096)throw new QueryFailure('observation-budget');
  memory.chargeExecution(addresses.length,addresses.length * 2);
  const entries=queryArray(addresses);
  const output=[];
  for(const address of entries) {
    memory.chargeMemoryObservations();
    const result=memory.load(address,1);
    if(!result.expression)throw new QueryFailure(result.reason);
    // The write-cover proof supplies every symbolic address in the issued
    // trace. Preserve its canonical Expr rather than coercing it into an
    // integer or confusing a symbolic write with a concrete footprint.
    const pointer = address && typeof address === 'object'
      ? memory.validateExpression(address, memory.addressBits) : createBv(memory.addressBits,address);
    output.push(Object.freeze({id:pointer.kind==='const'?`byte:${pointer.value}`:`symbolic-byte:${output.length}`,
      address:pointer,expression:result.expression}));
  }
  memory.check();
  return Object.freeze(output);
}
