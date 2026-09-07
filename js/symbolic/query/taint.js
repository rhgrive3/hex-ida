import {queryRecord} from '../memory/data-input.js';
import { symbolicExecute } from '../executor.js';
import { createTaintFlow } from '../taint/flow.js';
import { QueryFailure, sameMemoryIdentity, monotonicNow, boundedLimit } from '../memory/query-state.js';
import { projectTaint } from '../projection/taint.js';
import { isExecutionResult } from '../memory/execution-snapshot.js';
const issued=new WeakMap();
export function isTaintQueryResult(result,identity,modelIdentity) {
  const state=issued.get(result);
  if(!state)return false;
  if(identity === undefined) identity = result.identity;if(modelIdentity === undefined) modelIdentity = result.modelIdentity;
  if(!sameMemoryIdentity(result.identity,identity)||result.modelIdentity!==modelIdentity) return false;
  try {
    const valid=!state.signal?.aborted && !state.isCancelled?.()
      && (!state.getCurrentModelIdentity || result.modelIdentity === state.getCurrentModelIdentity())
      && (!state.getCurrentIdentity || sameMemoryIdentity(result.identity,state.getCurrentIdentity()))
      && isExecutionResult(state.execution,result.identity,state.ir);
    return valid && !state.signal?.aborted;
  } catch { return false; }
}
/** Run first-class taint through the real bounded executor and its byte memory. */
export function queryTaint(ir,inputOptions={}) {
  const start=monotonicNow();let flow,execution,options={};
  try {
    const submitted=queryRecord(inputOptions,null,128);
    options=Object.freeze({...submitted,
      ...(submitted.memory!=null?{memory:queryRecord(submitted.memory)}:{}),
      ...(submitted.execution!=null?{execution:queryRecord(submitted.execution)}:{})});
    flow=createTaintFlow(options);
    const checkModel=()=> { try { if(options.getCurrentModelIdentity && options.getCurrentModelIdentity()!==options.models.modelIdentity) throw new QueryFailure('stale-model'); } catch {throw new QueryFailure('stale-model');} };
    checkModel();
    // All phases share the outer allowance; executor/byte-memory sublimits may
    // narrow it, but must not restart a fresh 250ms clock during preflight.
    const remaining = Math.floor(flow.remainingMilliseconds());
    const memoryTimeout = Math.min(remaining, boundedLimit(options.memory?.timeoutMs, 250, 5000, 'memory.timeoutMs'));
    const executionTimeout = Math.min(remaining, boundedLimit(options.execution?.timeoutMs, 250, 5000, 'execution.timeoutMs'));
    execution=symbolicExecute(ir,{...options.execution,timeoutMs:executionTimeout,memoryObservations:options.memoryObservations??options.execution?.memoryObservations,captureValues:true,signal:options.signal,isCancelled:options.isCancelled,
      byteMemory:{...options.memory,timeoutMs:memoryTimeout,now:options.now,identity:options.identity,signal:options.signal,isCancelled:options.isCancelled,
        getCurrentIdentity:options.getCurrentIdentity,labelDomain:flow.labels},_taint:flow});
    flow.check(); checkModel();
    if(execution.status!=='complete' && /budget|deadline|cancel|stale/.test(execution.reason ?? '')) throw new QueryFailure(execution.reason);
    const data=flow.solve({partial:execution.status!=='complete'});
    const result=Object.freeze({schemaVersion:'hex-taint-query/v1',identity:flow.identity,
      modelIdentity:options.models.modelIdentity,models:options.models,
      status:execution.status==='complete'?'complete':'partial',reason:execution.reason,
      ...data,execution,metrics:Object.freeze({...flow.metrics(),queryMilliseconds:monotonicNow()-start})});
    const lifecycle={ir,execution,getCurrentIdentity:options.getCurrentIdentity,getCurrentModelIdentity:options.getCurrentModelIdentity,signal:options.signal,isCancelled:options.isCancelled};
    issued.set(result,lifecycle);
    const projection=projectTaint(result);
    flow.check(); checkModel();
    const final=Object.freeze({...result,evidence:projection.evidence,graph:projection.graph,
      metrics:Object.freeze({...flow.metrics(),queryMilliseconds:monotonicNow()-start})});
    // Final metrics may invoke the clock. No capability is published after
    // cancellation, model drift or IR mutation at that observer boundary.
    checkModel(); flow.check();
    if(!isExecutionResult(execution,flow.identity,ir) || options.signal?.aborted) throw new QueryFailure('stale-or-cancelled-publication');
    issued.set(final,lifecycle);return final;
  } catch(error) {
    if(!(error instanceof QueryFailure)) throw error;
    return Object.freeze({schemaVersion:'hex-taint-query/v1',identity:flow?.identity??null,
      modelIdentity:options.models?.modelIdentity??null,status:'partial',reason:error.reason,
      sinks:Object.freeze([]),values:Object.freeze([]),edges:Object.freeze([]),evidence:null,graph:null,
      metrics:Object.freeze({...flow?.metrics(),queryMilliseconds:monotonicNow()-start})});
  }
}
