/** Read-only bridge from a private async-model owner to ALREADY CAPTURED
 * canonical RuntimeEvents. No provider start, instrumentation, or execution.
 * The payload is an explicit versioned mapping premise, not runtime semantics. */
import { RuntimeModuleBindingTable } from './provider-identity.js';
import { createRuntimeEvent } from './events.js';
import { assertScopedAnalysisWork } from '../core/budgets/scoped-work.js';
import { assertWorldScope, assertAssumptionSet } from '../core/identity/world.js';
import { deepFreeze, stableStringify, stableDigest, lossyTypeWitness } from '../core/identity/index.js';
import { snapshotContractData, recordFields, exactString, exactInteger, contractFail } from '../core/identity/structured.js';
export const CAPTURED_ASYNC_SOURCE_SCHEMA = 'scpa-runtime-async-source/v1';
export const CAPTURED_ASYNC_EVENT_SCHEMA = 'scpa-async-event-capture/v1';
const same = (a,b) => stableStringify([a,lossyTypeWitness(a)]) === stableStringify([b,lossyTypeWitness(b)]);
export async function bindCapturedAsyncEvents(captureInput, sourceInput, sourceBinding, { world, assumptions, snapshotId, work, getContext, isCurrent } = {}) {
  assertWorldScope(world); assertAssumptionSet(assumptions,world); assertScopedAnalysisWork(work); work.checkpoint();
  const capture=snapshotContractData(captureInput,{maxBytes:8192,maxNodes:128});
  recordFields(capture,['schema','moduleBindingKey','moduleGeneration','providerSchemaVersion'],'captured-async-source-fields');
  const base={schema:'scpa-captured-async-binding/v1',exact:false,semanticProof:false,runtimeExecutionRequested:false};
  if(capture.schema!==CAPTURED_ASYNC_SOURCE_SCHEMA || capture.providerSchemaVersion!==CAPTURED_ASYNC_EVENT_SCHEMA) return {
    ...base,status:'unsupported',reason:'captured-async-schema-unqualified'};
  exactString(capture.moduleBindingKey,'captured-async-module-key');exactInteger(capture.moduleGeneration,'captured-async-module-generation',{min:1});
  const source=snapshotContractData(sourceInput,{maxBytes:1048576,maxNodes:32768});
  if(!Array.isArray(source.events)||!source.events.length||source.events.length>128) contractFail('captured-async-event-bound');
  const ids=new Set();for(const event of source.events){exactString(event.id,'captured-async-event-id');if(ids.has(event.id))contractFail('captured-async-duplicate-event');ids.add(event.id);}
  if(typeof getContext!=='function') return {...base,status:'unsupported',reason:'captured-runtime-evidence-owner-unbound'};
  const context=await work.await(signal=>getContext(sourceBinding.runtimeSessionId,{world,assumptions,snapshotId,signal,work}));
  if(!context) return {...base,status:'unsupported',reason:'captured-runtime-session-unavailable'};
  if(!(context.modules instanceof RuntimeModuleBindingTable)||context.modules.runtimeSessionId!==sourceBinding.runtimeSessionId
    ||typeof context.getObservation!=='function'||typeof context.isCurrent!=='function') contractFail('captured-async-owner-contract');
  const binding=snapshotContractData(context.binding,{maxBytes:8192,maxNodes:128});
  recordFields(binding,['worldId','assumptionsId','snapshotId','runtimeSessionId','providerId','providerVersion','sessionEpoch'],'captured-async-binding-fields');
  if(binding.worldId!==world.id||binding.assumptionsId!==assumptions.id||binding.snapshotId!==snapshotId
    ||binding.runtimeSessionId!==sourceBinding.runtimeSessionId||binding.sessionEpoch!==sourceBinding.epoch
    ||sourceBinding.moduleGeneration!==String(capture.moduleGeneration)) contractFail('captured-async-scope-mismatch');
  exactString(binding.providerId,'captured-async-provider');exactString(binding.providerVersion,'captured-async-provider-version');
  exactInteger(binding.sessionEpoch,'captured-async-epoch',{min:1});
  const active=context.modules.active();if(active.length>4096)contractFail('captured-async-module-bound');
  const pinned=new Map(active.map(module=>[module.bindingKey,module]));
  work.charge('workUnits',active.length);work.charge('residentBytes',active.length*128);
  const current=()=>{
    work.checkpoint();if(isCurrent?.()!==true||context.isCurrent()!==true)contractFail('captured-async-owner-stale');
    const now=context.modules.active();if(now.length!==pinned.size)contractFail('captured-async-module-membership-changed');
    for(const module of now){work.charge('workUnits');if(pinned.get(module.bindingKey)!==module)contractFail('captured-async-module-generation-changed');}
  };
  current();const module=pinned.get(capture.moduleBindingKey);
  if(!module||module.generation!==capture.moduleGeneration||module.identityState!=='exact'||module.buildIdentity==null
    ||!module.identityEvidenceIds.length||!world.binarySet.some(b=>b.binaryId===module.binaryId&&b.sliceId===module.sliceId)) {
    return {...base,status:'unknown',reason:'captured-async-current-image-unqualified'};
  }
  const observations=[],missing=[];
  for(const proposed of source.events){
    current();const raw=await work.await(signal=>context.getObservation(proposed.id,{role:'async-event',signal,work}));current();
    if(!raw){missing.push({eventId:proposed.id,reason:'captured-event-unavailable'});continue;}
    const supplied=snapshotContractData(raw,{maxBytes:65536,maxNodes:4096});
    recordFields(supplied,['event','address'],'captured-async-observation-fields');
    work.charge('residentBytes',stableStringify(supplied).length*2);
    const event=createRuntimeEvent(supplied.event,{maxBytes:65536});
    if(!same(event,supplied.event)||event.eventId!==proposed.id||event.runtimeSessionId!==binding.runtimeSessionId
      ||event.providerId!==binding.providerId||event.providerVersion!==binding.providerVersion||event.sessionEpoch!==binding.sessionEpoch) {
      contractFail('captured-async-event-binding');
    }
    let reason=event.moduleBindingKey!==module.bindingKey||event.moduleGeneration!==module.generation ? 'captured-event-historical-module'
      :event.observationMode!=='observed'||event.interventionIds.length ? 'captured-event-not-natural-mode'
      :!['trace-marker','instrumentation-observation'].includes(event.kind)||event.completeness!=='complete' ? 'captured-event-record-incomplete' : null;
    const payload=event.payload.scpaAsync;
    if(!reason&&(payload?.schema!==capture.providerSchemaVersion||!same(payload.event,proposed)))reason='captured-async-payload-mismatch';
    if(reason){missing.push({eventId:proposed.id,reason});continue;}
    observations.push({eventId:event.eventId,eventDigest:stableDigest({event,typed:lossyTypeWitness(event)}),
      observationMode:event.observationMode,providerSchemaVersion:capture.providerSchemaVersion,
      moduleBindingKey:module.bindingKey,moduleGeneration:module.generation});
    await work.yieldIfNeeded();
  }
  current();return deepFreeze({...base,status:missing.length?'unknown':'bound',binding,
    counts:{declared:source.events.length,bound:observations.length,missing:missing.length},observations,missing,
    sourceBinding:'current-source-owned-records; event-mapping-and-capture-adequacy-unproved',
    remaining:['runtime-payload-mapping-is-a-provider-premise','capture-completeness-and-natural-reachability-unproved',
      'ObjC-capture-and-Swift-lifetime-semantics-unqualified','no-universal-lifetime-or-order-proof']});
}
