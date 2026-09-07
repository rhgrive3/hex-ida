/** Pure expression adoption eligibility, NOT a decompiler transaction.
 * The existing verification judge/session/evidence remain the only proof engine.
 * Memory/effect transformations fail closed: this input judge does not prove
 * their deltas. The judge itself is deliberately left unchanged.
 */
import { queryRecord, queryArray } from '../memory/data-input.js';
import { stableDigest } from '../../core/identity/index.js';
import { createQueryGuard, QueryFailure, sameMemoryIdentity } from '../memory/query-state.js';
import { assertMemoryExpr } from '../memory/byte-memory.js';
import { TieredBvBackend } from '../solver/tiered-backend.js';
import { ExhaustiveBvBackend } from '../solver/exhaustive-backend.js';
import { inspectMemoryExpressions as collectSymbols, boundedExpressionEvaluationCost } from '../memory/expression-contract.js';
import { computeStructuralHash } from '../expr/hash.js';
import { verifyBoundedEquivalence } from '../verify/equivalence.js';
import { isProvedEvidence } from '../evidence/symbolic-evidence.js';
import { isTaintQueryResult } from '../query/taint.js';
const receipts=new WeakMap();
function reject(reason,proof=null) {
  return Object.freeze({eligible:false,scope:'pure-expression-only',reason,verdict:proof?.verdict??'unknown',
    evidence:proof?.evidence??null,counterexample:proof?.evidence?.witnessModel??null});
}
function expressionNodes(roots,guard) {
  const work=roots.slice(),seen=new Set(),out=[];
  while(work.length) {
    guard.take('workItems');const n=work.pop();if(seen.has(n)) continue;seen.add(n);out.push(n);
    for(const key of ['arg','left','right','cond','thenExpr','elseExpr']) if(n[key]) work.push(n[key]);
    if(n.args) for(const child of n.args) work.push(child);
  }
  return out;
}
export async function verifyDeobfuscationCandidate(candidate={}) {
  // Retain the submitted lifecycle observers across the asynchronous judge call.
  // Reassigning the caller's options cannot replace cancellation or freshness.
  try { candidate = queryRecord(candidate); }
  catch (error) { if (error instanceof QueryFailure) return reject(error.reason); throw error; }
  const {before,after,identity,preconditions:providedPreconditions=[],correspondence={inputs:[]},memoryObservables,effectObservables,taintResult}=candidate;
  if(['verified','proof','solverResult','session','backend'].some(key=>Object.hasOwn(candidate,key))) return reject('external-proof-not-accepted');
  if(Object.hasOwn(candidate,'executionSnapshot')) return reject('execution-path-proof-handoff');
  if(!before||!after) return reject('missing-target');
  if(!Array.isArray(memoryObservables)||!Array.isArray(effectObservables)) return reject('missing-memory-effect-observables');
  if(memoryObservables.length||effectObservables.length) return reject('memory-effect-judge-handoff');
  if(!['candidateId','beforeValueId','afterValueId'].every(k=>typeof candidate[k]==='string'&&candidate[k].length>0&&candidate[k].length<=1024)) return reject('missing-candidate-value-identity');
  if(!Array.isArray(providedPreconditions)||providedPreconditions.length>4096||!Array.isArray(correspondence?.inputs)||correspondence.inputs.length>4096) return reject('invalid-precondition-correspondence');
  // The solver, scope and receipt must all bind the very same submitted list.
  let preconditions, submittedInputs;
  try {
    preconditions = queryArray(providedPreconditions);
  } catch (error) { if (error instanceof QueryFailure) return reject(error.reason); throw error; }
  try {
    const inputScope = queryRecord(correspondence);
    submittedInputs = queryArray(inputScope.inputs).map(pair => queryRecord(pair));
  } catch (error) { if (error instanceof QueryFailure) return reject('invalid-input-correspondence'); throw error; }
  if(taintResult && (!isTaintQueryResult(taintResult,identity)||taintResult.status!=='complete'||taintResult.unknownSanitizers.length||taintResult.sinks.some(sink=>sink.taint.kind==='top'))) return reject('incomplete-or-stale-taint');
  const guard=createQueryGuard({...candidate,timeoutMs:candidate.timeoutMs??120},{workItems:100000,reservedEvaluations:2000000});
  let session;
  try {
    guard.check();
    const roots=[before,after,...preconditions];
    for(const expr of roots) assertMemoryExpr(expr,guard);
    if(before.sort.kind!==after.sort.kind||before.sort.width!==after.sort.width) return reject('sort-width-mismatch');
    if(preconditions.some(p=>p.sort.kind!=='bool')) return reject('precondition-sort');
    const nodes=expressionNodes(roots,guard);
    if(nodes.some(n=>n.kind==='fresh_symbol'&&n.meta?.source==='initial-byte')) return reject('memory-effect-judge-handoff');
    const collected=collectSymbols(roots,{maxExprNodes:100000,maxExprDepth:128});
    if(collected.unsupportedReason||collected.limitExceeded||collected.depthExceeded) return reject('unsupported-or-budgeted-expression');
    // The shared judge has a name fallback during substitution. Distinct symbols
    // with equal names must not reach it, even when symbolIds differ.
    const names=new Map();
    for(const symbol of collected.symbols) {
      if(names.has(symbol.name)&&names.get(symbol.name)!==symbol.symbolId) return reject('ambiguous-symbol-name-handoff');
      names.set(symbol.name,symbol.symbolId);
    }
    const beforeSymbols=new Set(collectSymbols([before]).symbols.map(s=>s.symbolId));
    const afterSymbols=new Set(collectSymbols([after]).symbols.map(s=>s.symbolId));
    const mapped=new Set();const inputs=[];
    for(const pair of submittedInputs) {
      guard.take('workItems');
      if(!pair||typeof pair!=='object'||!beforeSymbols.has(pair.before)||!afterSymbols.has(pair.after)||mapped.has(pair.after)) return reject('invalid-input-correspondence');
      mapped.add(pair.after);inputs.push(Object.freeze({before:pair.before,after:pair.after}));
    }
    if([...afterSymbols].some(id=>!beforeSymbols.has(id)&&!mapped.has(id))) return reject('missing-input-correspondence');
    // Nodes/depth/cycles have already been checked by the canonical validator.
    // Use the existing memoized hash implementation, not a second hash authority.
    guard.take('workItems',nodes.length);
    const hashes={hashes:roots.map(computeStructuralHash)};
    const scope=Object.freeze({kind:'pure-expression-only',identity:guard.identity,candidateId:candidate.candidateId,
      beforeValueId:candidate.beforeValueId,afterValueId:candidate.afterValueId,
      beforeHash:hashes.hashes[0],afterHash:hashes.hashes[1],preconditionHashes:Object.freeze(hashes.hashes.slice(2)),
      correspondence:Object.freeze(inputs),memoryObservables:Object.freeze([]),effectObservables:Object.freeze([]),
      taint:taintResult?Object.freeze({modelIdentity:taintResult.modelIdentity,queryHash:taintResult.evidence.queryHash}):null});
    if(candidate.backendTier!=null && !['exhaustive','tiered'].includes(candidate.backendTier)) return reject('unsupported-backend');
    const symbolBits=collected.symbols.reduce((sum,symbol)=>sum+(symbol.sort.kind==='bool'?1:symbol.sort.width),0);
    const wide=candidate.backendTier==='tiered';
    if(!wide && symbolBits>12) return reject('budget:solver-assignments');
    // Wide solving has separate, pre-checked CNF/search budgets; this counter
    // reserves expression validation work, not a fictional enumeration count.
    guard.take('reservedEvaluations',boundedExpressionEvaluationCost(roots,guard)*(wide?4:(2**symbolBits)*4));
    const backend=wide ? new TieredBvBackend({maxExprNodes:4096,maxExprDepth:128,maxVariables:32768,maxClauses:131072,maxDecisions:8192,maxPropagations:500000}) : new ExhaustiveBvBackend({maxAssignments:4096});
    session=backend.createSession({timeoutMs:Math.max(1,Math.floor(guard.remainingMilliseconds())),signal:candidate.signal});
    const proof=await verifyBoundedEquivalence({beforeTarget:before,afterTarget:after,
      correspondence:{inputs},preconditions:preconditions.slice(),memoryRegions:[],session,
      options:{timeoutMs:Math.max(1,Math.floor(guard.remainingMilliseconds())),signal:candidate.signal,architecture:identity.architecture,
        bitWidth:before.sort.width??null,proofScope:scope}});
    guard.check();
    if(taintResult && !isTaintQueryResult(taintResult,guard.identity)) return reject('stale-taint');
    if(proof.verdict!=='proved'||!isProvedEvidence(proof.evidence)) return reject(proof.reasonCode??'proof-ineligible',proof);
    const result=Object.freeze({eligible:true,scope:'pure-expression-only',verdict:'proved',reason:'proved-equivalent',
      identity:guard.identity,binding:scope,bindingDigest:stableDigest(scope),before,after,evidence:proof.evidence});
    receipts.set(result,{scope,preconditions:Object.freeze(preconditions.slice()),taintResult,getCurrentIdentity:candidate.getCurrentIdentity,signal:candidate.signal,isCancelled:candidate.isCancelled});return result;
  } catch(error) {
    if(!(error instanceof QueryFailure)) throw error;
    return reject(error.reason);
  } finally { session?.dispose(); }
}
export function isAdoptableCandidate(result,scope={}) {
  const receipt=receipts.get(result);
  if(!receipt)return false;
  let identity,before,after,preconditions,correspondence;
  try {
    const fields=queryRecord(scope);
    identity=fields.identity === undefined ? result.identity : fields.identity;
    before=fields.before === undefined ? result.before : fields.before;
    after=fields.after === undefined ? result.after : fields.after;
    preconditions=fields.preconditions === undefined ? [] : fields.preconditions;
    correspondence=fields.correspondence === undefined ? {inputs:[]} : fields.correspondence;
  } catch {return false;}
  if(!receipt||!sameMemoryIdentity(identity,result.identity)||before!==result.before||after!==result.after) return false;
  // A proof under P and an input renaming is not an unconditional identity-
  // mapped rewrite. The consuming transaction must supply its current scope.
  // Compare issued Expr objects, not hashes or caller assertion flags.
  try {
    const conditions = queryArray(preconditions);
    if (conditions.length !== receipt.preconditions.length) return false;
    for (let index = 0; index < conditions.length; index++) {
      if (conditions[index] !== receipt.preconditions[index]) return false;
    }
    const inputScope = queryRecord(correspondence);
    const inputs = queryArray(inputScope.inputs);
    if (inputs.length !== receipt.scope.correspondence.length) return false;
    for (let index = 0; index < inputs.length; index++) {
      const pair = queryRecord(inputs[index]);
      if (pair.before !== receipt.scope.correspondence[index].before || pair.after !== receipt.scope.correspondence[index].after) return false;
    }
    const current = !receipt.signal?.aborted && !receipt.isCancelled?.() && (!receipt.getCurrentIdentity || sameMemoryIdentity(identity,receipt.getCurrentIdentity()))
      && (!receipt.taintResult || isTaintQueryResult(receipt.taintResult,identity));
    return current && !receipt.signal?.aborted;
  } catch { return false; }
}
