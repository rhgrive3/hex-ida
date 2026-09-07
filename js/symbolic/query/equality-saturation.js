/** C4-05: bounded e-graph candidates with independent existing proof authority. */
import * as E from '../expr/index.js';
import { queryRecord, queryArray } from '../memory/data-input.js';
import { assertMemoryExpr } from '../memory/byte-memory.js';
import { createQueryGuard, QueryFailure } from '../memory/query-state.js';
import { saturatePureExpression, EGRAPH_LIMITS } from '../egraph/graph.js';
import { EQUALITY_RULESET_VERSION } from '../egraph/rules.js';
import { verifyDeobfuscationCandidate } from '../taint/proof-consumer.js';

export async function queryEqualitySaturation(options={}) {
  // Snapshot request fields without invoking accessors or overridden iterators.
  let submitted,identity,guard;
  try {
    submitted=queryRecord(options);
    identity=queryRecord(submitted.identity);
    guard=createQueryGuard({...submitted,identity,timeoutMs:submitted.timeoutMs??250,
      limits:submitted.limits?queryRecord(submitted.limits):undefined},EGRAPH_LIMITS);
  } catch(error) {
    if(!(error instanceof QueryFailure) && !(error instanceof TypeError))throw error;
    return Object.freeze({schemaVersion:'hex-equality-saturation/v1',status:'partial',
      reason:error instanceof QueryFailure?error.reason:'invalid-query-options',identity:null,
      candidates:Object.freeze([]),metrics:null});
  }
  let verificationQueries=0;
  const result=(status,reason,candidates=[],search=null)=>Object.freeze({
    schemaVersion:'hex-equality-saturation/v1',status,reason,identity:guard.identity,
    scope:'pure-expression-candidates-only',rulesetVersion:EQUALITY_RULESET_VERSION,
    saturated:search?.saturated??false,optimality:search?.optimality??null,
    candidates:Object.freeze(candidates),rules:search?.rules??Object.freeze([]),
    metrics:Object.freeze({...guard.metrics(),verificationQueries}),
  });
  try {
    guard.check();
    if(['verified','proof','solverResult','session','backend','rules'].some(key=>Object.hasOwn(submitted,key)))throw new QueryFailure('external-proof-or-rules-not-accepted');
    if(Object.hasOwn(submitted,'executionSnapshot'))throw new QueryFailure('execution-path-proof-handoff');
    const memory=queryArray(submitted.memoryObservables,guard),effects=queryArray(submitted.effectObservables,guard);
    if(memory.length || effects.length || queryArray(submitted.memoryRegions ?? [],guard).length)throw new QueryFailure('memory-effect-judge-handoff');
    const valueId=submitted.valueId;
    if(typeof valueId!=='string' || !valueId || valueId.length>512)throw new QueryFailure('invalid-semantic-value-id');
    const preconditions=queryArray(submitted.preconditions??[],guard);
    const inputScope=queryRecord(submitted.correspondence??{inputs:[]},guard);
    const inputs=queryArray(inputScope.inputs,guard).map(value=>queryRecord(value,guard));
    guard.take('allocationUnits',inputs.length+preconditions.length);
    const correspondence=Object.freeze({inputs:Object.freeze(inputs)});
    const expression=submitted.expression;
    assertMemoryExpr(expression,guard);
    for(const condition of preconditions){assertMemoryExpr(condition,guard);if(condition.sort.kind!=='bool')throw new QueryFailure('precondition-sort-mismatch');}
    const search=saturatePureExpression(expression,guard),beforeDigest=E.computeStructuralHash(expression),candidates=[];
    for(const choice of search.choices) {
      if(choice.digest===beforeDigest)continue; // ranking only, never a proof
      guard.take('candidates');guard.take('allocationUnits');guard.check();
      const candidateId=`egraph:${EQUALITY_RULESET_VERSION}:${choice.digest}`;
      verificationQueries++;
      const verification=await verifyDeobfuscationCandidate({
        before:expression,after:choice.expression,candidateId,beforeValueId:valueId,
        afterValueId:`${valueId}:eqs:${choice.digest}`,identity:guard.identity,
        preconditions,correspondence,memoryObservables:[],effectObservables:[],
        signal:submitted.signal,isCancelled:submitted.isCancelled,getCurrentIdentity:submitted.getCurrentIdentity,
        taintResult:submitted.taintResult,backendTier:submitted.backendTier??'tiered',
        timeoutMs:Math.max(0,Math.floor(guard.remainingMilliseconds())),
      });
      guard.check();
      if(!verification.eligible && /budget|timeout|deadline|cancel|stale/.test(verification.reason??''))throw new QueryFailure(verification.reason);
      candidates.push(Object.freeze({rule:'equality-saturation',rules:search.rules,rulesetVersion:EQUALITY_RULESET_VERSION,
        candidateId,before:expression,after:choice.expression,cost:choice.cost,eligible:verification.eligible,verification}));
    }
    guard.check();return result('complete',null,candidates,search);
  } catch(error) {
    if(!(error instanceof QueryFailure))throw error;
    // Never publish an earlier proof after the encompassing batch was stopped.
    return result('partial',error.reason);
  }
}
