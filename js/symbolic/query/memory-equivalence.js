/** Exact finite-byte execution equivalence, not general SMT Array/effect theory.
 * The executor supplies both path sets. All bytes in a <=16-byte domain, or
 * every modified concrete byte, or every symbolic write-address expression,
 * plus returns form one Bool obligation. For each valuation the written bytes
 * are covered by these terms; outside that set both memories equal the SAME
 * initial byte function. This is exact over the full BV1..64 address space,
 * not finite sampling and not a claim of general Array-sort backend support.
 * The obligation is checked by the existing
 * judge/session/backend. No selected-byte omission or unproved hash receipt.
 */
import { queryRecord as plainCopy, queryArray as arrayCopy } from '../memory/data-input.js';
import { OP } from '../../ir-base.js';
import { stableDigest } from '../../core/identity/index.js';
import { createByteMemory, assertMemoryExpr, isMemoryInitialSymbol } from '../memory/byte-memory.js';
import { createQueryGuard, QueryFailure, boundedLimit, sameMemoryIdentity } from '../memory/query-state.js';
import { isExecutionResult, executionWriteFootprint, executionSymbolicWriteFootprint, observeExecutionBytes } from '../memory/execution-snapshot.js';
import { semanticValueIdentity } from '../memory/value-identity.js';
import { inspectMemoryExpressions, boundedExpressionEvaluationCost } from '../memory/expression-contract.js';
import { symbolicExecute } from '../executor.js';
import { createBool, createFreshSymbol, bvSort, createCompare, createConnective, computeStructuralHash, evaluateExpr } from '../expr/index.js';
import { TieredBvBackend } from '../solver/tiered-backend.js';
import { ExhaustiveBvBackend } from '../solver/exhaustive-backend.js';
import { verifyBoundedEquivalence } from '../verify/equivalence.js';
import { isProvedEvidence } from '../evidence/symbolic-evidence.js';
const receipts = new WeakMap();
const LIMITS = Object.freeze({workItems:250000,observedBytes:512,proofPairs:256,solverCalls:4,reservedEvaluations:2000000,symbolicAddresses:256,obligationNodes:25000});
const FORBIDDEN = ['backend','session','verified','proof','solverResult','memoryObservables','effectObservables','executionSnapshot'];
const conjunction = expressions => expressions.length ? createConnective('and',...expressions) : createBool(true);
const disjunction = expressions => expressions.length ? createConnective('or',...expressions) : createBool(false);
function equals(a,b,guard) {
  guard.take('workItems'); guard.take('obligationNodes');
  if(!a&&!b)return createBool(true);
  if(!a||!b||a.sort.kind!==b.sort.kind||a.sort.width!==b.sort.width)throw new QueryFailure('observable-sort-mismatch');
  if(a===b)return createBool(true);
  // Exact Boolean lowering, not an alias decision or an unproved rewrite:
  // ite(c,x,y)==y  iff  c -> x==y;  ite(c,x,y)==x iff c OR y==x.
  // Expose the controlling predicate instead of making bounded DPLL enumerate
  // irrelevant pointer bits before rediscovering this identity at the bit level.
  // Only object-identical canonical arms qualify; no names/hashes are trusted.
  if(a.kind==='ite'&&a.elseExpr===b)return createConnective('implies',a.cond,equals(a.thenExpr,b,guard));
  if(a.kind==='ite'&&a.thenExpr===b)return createConnective('or',a.cond,equals(a.elseExpr,b,guard));
  if(b.kind==='ite'&&b.elseExpr===a)return createConnective('implies',b.cond,equals(a,b.thenExpr,guard));
  if(b.kind==='ite'&&b.thenExpr===a)return createConnective('or',b.cond,equals(a,b.elseExpr,guard));
  return a.sort.kind==='bool'?createConnective('eq',a,b):createCompare('eq',a,b);
}
function checkEffects(ir,execution,guard) {
  if(execution.assumptions?.length)throw new QueryFailure('conditional-machine-effects-outside-proof-scope');
  for(const block of ir.blocks)for(const group of [block.phis ?? [], block.insts])for(const inst of group) {
    guard.take('workItems');
    // A generic scalar/byte program has no unobserved physical register or
    // architectural exception state. Machine programs need a wider effect model.
    if(inst.extra?.stateWrite!=null||inst.extra?.attributes?.machineEffects!=null
        ||inst.extra?.memoryAccess?.faults?.length)throw new QueryFailure('unmodeled-machine-effects');
    if([OP.CALL,OP.CLOBBER,OP.UNKNOWN].includes(inst.op))throw new QueryFailure('unmodeled-effects');
  }
}
function firstDivergence(before,after,model,guard) {
  const active=execution=>execution.paths.find(path=>path.constraints.every(expr=>evaluateExpr(expr,model).value===true));
  const left=active(before),right=active(after);
  if(!left||!right)return Object.freeze({kind:'path-coverage'});
  for(let i=0;i<left.memoryObservations.length;i++) {
    guard.take('workItems');
    const b=evaluateExpr(left.memoryObservations[i].expression,model),a=evaluateExpr(right.memoryObservations[i].expression,model);
    if(b.status==='value'&&a.status==='value'&&b.value!==a.value) {
      const address=evaluateExpr(left.memoryObservations[i].address,model);
      if(address.status!=='value'||typeof address.value!=='bigint')throw new QueryFailure('invalid-address-model');
      return Object.freeze({kind:'memory-byte',address:address.value,before:b.value,after:a.value});
    }
  }
  return Object.freeze({kind:'return-value',before:left.returnValue?evaluateExpr(left.returnValue,model).value:null,
    after:right.returnValue?evaluateExpr(right.returnValue,model).value:null});
}
export async function queryMemoryEquivalence(request={}) {
  let guard,memory,session,before,after,solverNodesEvaluated=0,scope=null;
  const stopped=reason=>Object.freeze({eligible:false,verdict:'unknown',reason,scope,evidence:null,firstDivergence:null,
    metrics:Object.freeze({...guard?.metrics(),memory:memory?.metrics()??null,solverNodesEvaluated})});
  try {
    request=plainCopy(request);
    if(FORBIDDEN.some(key=>Object.hasOwn(request,key)))return stopped('external-proof-or-selected-observables-not-accepted');
    // Snapshot nested public data before any guard reads it. Identity/limits
    // accessors must not run merely to construct a failure diagnostic.
    const identity=plainCopy(request.identity);
    const limits=request.limits==null?undefined:plainCopy(request.limits);
    guard=createQueryGuard({...request,identity,limits,timeoutMs:request.timeoutMs??250},LIMITS);guard.check();
    const wide=request.backendTier==='tiered';
    if(request.backendTier!=null && !['exhaustive','tiered'].includes(request.backendTier))throw new QueryFailure('unsupported-backend');
    const beforeIr=request.beforeIr,afterIr=request.afterIr;
    if(!beforeIr||!afterIr)throw new QueryFailure('missing-ir-pair');
    const supplied=plainCopy(request.memory??{},guard);
    const memoryLimits=supplied.limits==null?undefined:plainCopy(supplied.limits,guard);
    const execution = plainCopy(request.execution ?? {},guard);
    for (const key of Object.keys(execution)) {
      if (!['maxPaths','maxSteps','maxBranches','maxBlockVisits'].includes(key)) throw new QueryFailure('execution-authority-option-conflict');
    }
    const bits=boundedLimit(supplied.addressBits,1,64,'addressBits');
    if(bits<1)throw new QueryFailure('finite-address-bits-required');
    for(const field of Object.keys(supplied)) {
      if(!['addressBits','endian','wrapping','alignment','initialBytes','limits','proofMode'].includes(field)) {
        throw new QueryFailure('memory-authority-option-conflict');
      }
    }
    const initialBytes=arrayCopy(supplied.initialBytes??[],guard,512).map(pair=>arrayCopy(pair,guard,2));
    const initialInputs=arrayCopy(request.inputs??[],guard,64),preconditions=arrayCopy(request.preconditions??[],guard,256);
    const argumentExpressions=new Map(),inputRecords=[],inputBindings=[];
    for(let i=0;i<initialInputs.length;i++) {
      const pair=plainCopy(initialInputs[i],guard);
      const b=plainCopy(pair.before,guard),a=plainCopy(pair.after,guard);
      if(b.kind!=='arg'||a.kind!=='arg'||!Number.isSafeInteger(b.bits)||b.bits<1||b.bits>(wide?64:8)||b.bits!==a.bits
          ||argumentExpressions.has(pair.before)||argumentExpressions.has(pair.after))throw new QueryFailure('invalid-input-correspondence');
      const expression=pair.expression??createFreshSymbol(bvSort(b.bits),`finite_input_${i}`,{source:'argument',queryId:guard.identity.queryId});
      assertMemoryExpr(expression,guard,b.bits);
      if(expression.kind!=='fresh_symbol')throw new QueryFailure('non-symbolic-input-binding');
      argumentExpressions.set(pair.before,expression);argumentExpressions.set(pair.after,expression);
      inputBindings.push(Object.freeze({before:pair.before,after:pair.after,expression:pair.expression??null}));
      inputRecords.push(Object.freeze({beforeValueId:semanticValueIdentity(pair.before),afterValueId:semanticValueIdentity(pair.after),expression}));
    }
    for(const condition of preconditions) {assertMemoryExpr(condition,guard);if(condition.sort.kind!=='bool')throw new QueryFailure('precondition-sort');}
    const proofMode=supplied.proofMode??(bits<=4?'finite-domain':'concrete-writes');
    if(!['finite-domain','concrete-writes','symbolic-writes'].includes(proofMode)||proofMode==='finite-domain'&&bits>4)throw new QueryFailure('unsupported-memory-proof-mode');
    const domainBytes=proofMode==='finite-domain'?2**bits:null;
    const geometry=Object.freeze({addressBits:bits,endian:supplied.endian??'little',wrapping:supplied.wrapping??'modular',alignment:supplied.alignment??'unaligned'});
    // This model covers every byte of a finite modular address space. Reject
    // an alternate geometry rather than quietly proving a different machine.
    if(proofMode==='finite-domain'&&geometry.wrapping!=='modular')throw new QueryFailure('finite-proof-requires-modular-address-space');
    memory=createByteMemory({...geometry,initialBytes,identity:guard.identity,timeoutMs:request.timeoutMs??250,
      signal:request.signal,isCancelled:request.isCancelled,getCurrentIdentity:request.getCurrentIdentity,now:request.now,
      limits:memoryLimits});
    const observations=Object.freeze(Array.from({length:domainBytes??0},(_,address)=>Object.freeze({id:`byte:${address}`,address:BigInt(address),size:1})));
    const execute=ir=>symbolicExecute(ir,{...execution,timeoutMs:request.timeoutMs??250,signal:request.signal,isCancelled:request.isCancelled,
      argumentExpressions,captureValues:true,memoryObservations:observations,
      byteMemory:{...geometry,initialState:memory,identity:guard.identity,timeoutMs:request.timeoutMs??250,
        signal:request.signal,isCancelled:request.isCancelled,getCurrentIdentity:request.getCurrentIdentity,now:request.now}});
    before=execute(beforeIr);guard.check();
    if(before.status!=='complete'||!isExecutionResult(before,guard.identity,beforeIr))throw new QueryFailure(`before:${before.reason??'incomplete-execution'}`);
    after=execute(afterIr);guard.check();
    if(after.status!=='complete'||!isExecutionResult(after,guard.identity,afterIr))throw new QueryFailure(`after:${after.reason??'incomplete-execution'}`);
    checkEffects(beforeIr,before,guard);checkEffects(afterIr,after,guard);
    if(!before.paths.length||!after.paths.length)throw new QueryFailure('missing-terminal-path');
    let addresses;
    if(proofMode==='finite-domain')addresses=Object.freeze(Array.from({length:domainBytes},(_,i)=>BigInt(i)));
    else {
      const union=new Set();
      for(const [execution,ir]of [[before,beforeIr],[after,afterIr]])for(const path of execution.paths) {
        const writes=proofMode==='symbolic-writes'
          ?executionSymbolicWriteFootprint(path.snapshot,guard.identity,ir)
          :executionWriteFootprint(path.snapshot,guard.identity,ir);
        guard.take('workItems',writes.length);
        for(const address of writes) {
          if(!union.has(address)&&union.size>=256)throw new QueryFailure('budget:write-footprint');
          if (!union.has(address)) guard.take('symbolicAddresses');
          union.add(address);
        }
      }
      addresses=Object.freeze(proofMode==='symbolic-writes'?[...union]:[...union].sort((a,b)=>a<b?-1:a>b?1:0));
    }
    guard.take('observedBytes',addresses.length*(before.paths.length+after.paths.length));
    guard.take('proofPairs',before.paths.length*after.paths.length);
    const views=(execution,ir)=>execution.paths.map(path=>proofMode==='finite-domain'?path:
      Object.freeze({...path,memoryObservations:observeExecutionBytes(path.snapshot,addresses,guard.identity,ir)}));
    const beforePaths=views(before,beforeIr),afterPaths=views(after,afterIr);
    guard.take('obligationNodes',before.paths.length+after.paths.length+2);
    const pathGuardsB=before.paths.map(path=>conjunction(path.constraints));
    const pathGuardsA=after.paths.map(path=>conjunction(path.constraints));
    const obligations=[disjunction(pathGuardsB),disjunction(pathGuardsA)];
    for(let i=0;i<before.paths.length;i++)for(let j=0;j<after.paths.length;j++) {
      const b=beforePaths[i],a=afterPaths[j];
      if(b.memoryObservations.length!==addresses.length||a.memoryObservations.length!==addresses.length)throw new QueryFailure('missing-memory-observable');
      const equal=[equals(b.returnValue,a.returnValue,guard)];
      for(let k=0;k<addresses.length;k++) {guard.take('workItems');equal.push(equals(b.memoryObservations[k].expression,a.memoryObservations[k].expression,guard));}
      guard.take('obligationNodes',3);
      obligations.push(createConnective('implies',conjunction([pathGuardsB[i],pathGuardsA[j]]),conjunction(equal)));
    }
    guard.take('obligationNodes');
    const obligation=conjunction(obligations);
    const addressTerms=proofMode==='symbolic-writes'?addresses:[];
    // Simplifying a comparison cannot erase the state/input budget or the
    // binding checks for its operands. Inspect the original observations as
    // well as the final obligation, even when a byte compares equal to itself.
    let observationCount=0;
    for(const paths of [beforePaths,afterPaths])for(const path of paths) {
      observationCount+=path.memoryObservations.length+(path.returnValue?1:0);
    }
    guard.take('workItems',1+preconditions.length+addressTerms.length+observationCount);
    const inspectedRoots=[obligation,...preconditions,...addressTerms];
    for(const paths of [beforePaths,afterPaths])for(const path of paths) {
      if(path.returnValue)inspectedRoots.push(path.returnValue);
      for(const observation of path.memoryObservations)inspectedRoots.push(observation.expression);
    }
    const collected=inspectMemoryExpressions(inspectedRoots,{maxExprNodes:25000,maxExprDepth:128,guard});
    if(collected.unsupportedReason||collected.depthExceeded||collected.limitExceeded)throw new QueryFailure('unsupported-or-budgeted-expression');
    const allowed=new Set(inputRecords.map(input=>input.expression));
    const names=new Set();let symbolBits=0;
    for(const symbol of collected.symbols) {
      if(names.has(symbol.name))throw new QueryFailure('ambiguous-symbol-name');names.add(symbol.name);
      if(!isMemoryInitialSymbol(memory,symbol)&&!allowed.has(symbol))throw new QueryFailure('unbound-input-or-precondition');
      symbolBits+=symbol.sort.kind==='bool'?1:symbol.sort.width;
    }
    if(!wide && symbolBits>12)throw new QueryFailure('budget:solver-assignments');
    // Include exactly the same symbols in the tautology so the existing judge
    // can authenticate its input correspondence without name-based guesses.
    guard.take('obligationNodes',collected.symbols.length+1);
    const tautology=conjunction(collected.symbols.map(symbol=>symbol.sort.kind==='bool'
      ?createConnective('eq',symbol,symbol):createCompare('eq',symbol,symbol)));
    // Model validation and divergence evidence can evaluate unsimplified byte
    // values and address terms too. Reserve their expansion before the solver,
    // not just the cheaper Boolean obligation that survived simplification.
    guard.take('workItems',1+inspectedRoots.length+pathGuardsB.length+pathGuardsA.length);
    const roots=[tautology,...inspectedRoots,...pathGuardsB,...pathGuardsA];
    guard.take('reservedEvaluations',boundedExpressionEvaluationCost(roots,guard)*(wide?4:(2**symbolBits)*4));
    scope=Object.freeze({kind:'finite-byte-execution',version:proofMode==='symbolic-writes'?2:1,identity:guard.identity,geometry,domainBytes,proofMode,
      observedAddresses:proofMode==='symbolic-writes'?Object.freeze(addresses.filter(a=>a.kind==='const').map(a=>a.value)):addresses,
      observedAddressTerms:proofMode==='symbolic-writes'?addresses:Object.freeze([]),
      addressCoverage:proofMode==='symbolic-writes'?'all-addresses':(proofMode==='finite-domain'?'finite-domain':'concrete-write-footprint'),
      writeCoverEncoding:proofMode==='symbolic-writes'?'finite-trace-symbolic-byte-write-cover/v1':null,
      outsideFootprint:proofMode!=='finite-domain'?'unchanged-identical-initial-function':'entire-domain-observed',
      initialBytes:Object.freeze(initialBytes),inputs:Object.freeze(inputRecords),preconditions,
      beforePathCount:before.paths.length,afterPathCount:after.paths.length,
      effects:Object.freeze(['terminal-return','all-terminal-memory-bytes']),unmodeledEffects:'rejected',
      obligationHash:computeStructuralHash(obligation)});
    const backend=wide?new TieredBvBackend({maxExprNodes:25000,maxVariables:32768,maxClauses:131072,maxDecisions:8192,maxPropagations:500000}):new ExhaustiveBvBackend({maxAssignments:4096,maxExprNodes:25000});
    session=backend.createSession({timeoutMs:Math.max(1,Math.floor(guard.remainingMilliseconds())),signal:request.signal});
    const nativeCheck=session.check.bind(session);
    session.check=async(...args)=>{guard.take('solverCalls');const result=await nativeCheck(...args);solverNodesEvaluated+=result.stats?.nodesEvaluated??0;return result;};
    // The query identity is JSON-safe data, not a live Expr/IR object graph.
    // Address fields have an explicit width and decimal encoding. Expression
    // hashes are computed here from validated canonical Expr; callers cannot
    // submit them as proof. Actual objects remain bound by the private receipt.
    const solverScope={...scope,
      observedAddresses:proofMode==='symbolic-writes'?[]:addresses.map(address=>({kind:'address',width:bits,decimal:address.toString()})),
      observedAddressTerms:proofMode==='symbolic-writes'?addresses.map(expression=>({kind:'symbolic-address',width:bits,hash:computeStructuralHash(expression)})):[],
      initialBytes:initialBytes.map(([address,value])=>({address:{kind:'address',width:bits,decimal:BigInt(address).toString()},
        value:typeof value==='object'?{kind:'expr',hash:computeStructuralHash(value)}:{kind:'byte',decimal:BigInt(value).toString()}})),
      inputs:inputRecords.map(({beforeValueId,afterValueId,expression})=>({beforeValueId,afterValueId,symbolId:expression.symbolId,width:expression.sort.width,hash:computeStructuralHash(expression)})),
      preconditions:preconditions.map(expression=>({kind:'bool-expression',hash:computeStructuralHash(expression)})),
    };
    const proof=await verifyBoundedEquivalence({beforeTarget:tautology,afterTarget:obligation,preconditions,correspondence:{inputs:[]},memoryRegions:[],session,
      options:{proofScope:solverScope,architecture:guard.identity.architecture,timeoutMs:Math.max(1,Math.floor(guard.remainingMilliseconds())),signal:request.signal}});
    guard.check();
    if(!isExecutionResult(before,guard.identity,beforeIr)||!isExecutionResult(after,guard.identity,afterIr))throw new QueryFailure('stale-execution');
    if(proof.verdict!=='proved'&&proof.verdict!=='refuted')return stopped(proof.reasonCode??'proof-ineligible');
    if(proof.verdict==='proved'&&!isProvedEvidence(proof.evidence))return stopped('unissued-proof');
    const divergence=proof.verdict==='refuted'?firstDivergence({paths:beforePaths},{paths:afterPaths},proof.counterexample,guard):null;
    guard.check();
    const result=Object.freeze({eligible:proof.verdict==='proved',verdict:proof.verdict,reason:proof.reasonCode??'proved-finite-memory-equivalence',
      scope,evidence:proof.evidence,firstDivergence:divergence,bindingDigest:stableDigest(scope),
      metrics:Object.freeze({...guard.metrics(),memory:memory.metrics(),solverNodesEvaluated})});
    // Hashing/projection/metrics above may consume time or observe a caller's
    // clock hook. A cancellation or source change at that last boundary must
    // discard the fully assembled result as well, before issuing a receipt.
    guard.check();
    if(!isExecutionResult(before,guard.identity,beforeIr)||!isExecutionResult(after,guard.identity,afterIr))throw new QueryFailure('stale-execution');
    guard.check();
    if(result.eligible)receipts.set(result,{beforeIr,afterIr,before,after,identity:guard.identity,preconditions,geometry,proofMode,initialBytes,inputBindings:Object.freeze(inputBindings),
      signal:request.signal,isCancelled:request.isCancelled,getCurrentIdentity:request.getCurrentIdentity});
    return result;
  } catch(error) {
    if(!(error instanceof QueryFailure||error instanceof TypeError||error instanceof RangeError))throw error;
    return stopped(error instanceof QueryFailure?error.reason:'invalid-memory-equivalence-input');
  } finally {session?.dispose();}
}
/** Caller must present the current source, input mapping, initial memory and conditions. */
export function isAdoptableMemoryEquivalence(result,current={}) {
  const receipt=receipts.get(result);
  if (!receipt) return false;
  try {
    current = plainCopy(current);
    const identity=plainCopy(current.identity);
    if(receipt.beforeIr!==current.beforeIr||receipt.afterIr!==current.afterIr||!sameMemoryIdentity(identity,receipt.identity))return false;
    const memory=plainCopy(current.memory);
    for(const key of Object.keys(memory))if(!['addressBits','endian','wrapping','alignment','initialBytes','limits','proofMode'].includes(key))return false;
    for(const [key,fallback]of [['addressBits',1],['endian','little'],['wrapping','modular'],['alignment','unaligned']]) {
      if((memory[key]??fallback)!==receipt.geometry[key])return false;
    }
    if((memory.proofMode??(receipt.geometry.addressBits<=4?'finite-domain':'concrete-writes'))!==receipt.proofMode)return false;
    const bytes=arrayCopy(memory.initialBytes??[],null,512);
    if(bytes.length!==receipt.initialBytes.length)return false;
    for(let i=0;i<bytes.length;i++) {
      const pair=arrayCopy(bytes[i],null,2),prior=receipt.initialBytes[i];
      if(pair.length!==prior.length||pair.some((value,index)=>value!==prior[index]))return false;
    }
    const inputs=arrayCopy(current.inputs,null,64);
    if(inputs.length!==receipt.inputBindings.length)return false;
    for(let i=0;i<inputs.length;i++) {
      const pair=plainCopy(inputs[i]),prior=receipt.inputBindings[i];
      if(pair.before!==prior.before||pair.after!==prior.after||(pair.expression??null)!==prior.expression)return false;
    }
    const conditions=current.preconditions;
    if(!Array.isArray(conditions)||conditions.length!==receipt.preconditions.length)return false;
    for(let i=0;i<conditions.length;i++) {
      const descriptor=Object.getOwnPropertyDescriptor(conditions,String(i));
      if(!descriptor||!Object.hasOwn(descriptor,'value')||descriptor.value!==receipt.preconditions[i])return false;
    }
    return !receipt.signal?.aborted&&!receipt.isCancelled?.()
      &&(!receipt.getCurrentIdentity||sameMemoryIdentity(receipt.identity,receipt.getCurrentIdentity()))
      &&isExecutionResult(receipt.before,receipt.identity,receipt.beforeIr)&&isExecutionResult(receipt.after,receipt.identity,receipt.afterIr);
  } catch { return false; }
}
