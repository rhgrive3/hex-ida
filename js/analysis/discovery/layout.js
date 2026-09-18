/** HEX-X-03: original-byte-bound discovery layout, never rewrite authority.
 * Canonical discovery fusion remains the only start/extent decision owner.
 * Every losing extent, data/code hint and relocation expression is retained.
 * Materialization covers only the explicitly supplied file-backed mappings;
 * restoring these chunks is not a rebuild, relocation application or proof of
 * equivalent execution. The independent rebuild transaction stays mandatory.
 */
import {asByteSource, nonNegativeBigInt} from '../../binary/source.js';
import {deepFreeze, stableDigest, stableStringify, jsonSafe} from '../../core/identity/index.js';
import {ResourceBudget, BudgetExceededError} from '../../core/budgets/index.js';
import {EvidenceGraph} from '../../core/evidence/index.js';
import {createAnalysisStatus} from '../status.js';
import {DiscoveryProducerRegistry, fuseFunctionCandidates} from './fusion.js';
import {GENERIC_PRODUCERS} from './producers.js';

export const DISCOVERY_LAYOUT_SCHEMA = 'hex-discovery-byte-layout/v1';
export const DISCOVERY_LAYOUT_LIMITS = Object.freeze({maxBytes:65536,maxIntervals:1024,maxSegments:4096,maxCandidates:4096,maxWork:200000,maxResidentBytes:4194304,maxRecords:16384});
const issued = new WeakMap();
const ID_FIELDS = ['snapshotId','binaryId','architectureId','semanticsVersion','sourceRevision'];
const fail = reason => {throw new TypeError(reason);};
function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) fail('layout-record-required');
  const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);
  if(keys.length>64)fail('layout-record-budget');
  const out=Object.create(null);
  for(const key of keys){if(typeof key!=='string'||!descriptors[key].enumerable||!Object.hasOwn(descriptors[key],'value'))fail('layout-accessor-or-non-data');out[key]=descriptors[key].value;}
  return out;
}
function identityOf(value) {
  const input=record(value),out={};
  for(const field of ID_FIELDS){const v=input[field];if(typeof v!=='string'||!v.trim()||v.length>512)fail('layout-identity-required');out[field]=v;}
  return Object.freeze(out);
}
function equalIdentity(left,right){return ID_FIELDS.every(k=>left[k]===right[k]);}
function address(value) {
  if(typeof value==='string'){if(value.length>24||!/^(?:0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(value))fail('layout-address-invalid');value=BigInt(value);}
  const result=nonNegativeBigInt(value);if(result>(1n<<64n))fail('layout-address-width');return result;
}
function text(value){if(typeof value!=='string'||!value||value.length>1024)fail('layout-text-required');return value;}
function snapshotData(value,budget,active=new WeakSet(),depth=0) {
  budget.consume('workUnits');
  if(depth>32)fail('layout-input-depth-budget');
  if(value==null||typeof value==='boolean')return value;
  if(typeof value==='number'){if(!Number.isFinite(value)||!Number.isSafeInteger(value))fail('layout-input-number');return value;}
  if(typeof value==='bigint'){if(value.toString(16).length>32)fail('layout-input-integer-budget');return value;}
  if(typeof value==='string'){if(value.length>4096)fail('layout-input-string-budget');budget.consume('residentBytes',value.length*2);return value;}
  if(typeof value!=='object'||active.has(value))fail('layout-input-non-data-or-cycle');
  active.add(value);let out;
  if(Array.isArray(value)){
    if(value.length>4096||Object.getPrototypeOf(value)!==Array.prototype||Reflect.ownKeys(value).length!==value.length+1)fail('layout-input-array-budget');
    budget.consume('residentBytes',value.length*8);out=[];
    for(let i=0;i<value.length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!Object.hasOwn(d,'value'))fail('layout-input-accessor');out.push(snapshotData(d.value,budget,active,depth+1));}
  }else{
    const fields=record(value);budget.consume('residentBytes',Object.keys(fields).length*32);out=Object.create(null);
    for(const key of Object.keys(fields))out[key]=snapshotData(fields[key],budget,active,depth+1);
  }
  active.delete(value);return Object.freeze(out);
}
function list(value,budget,max){if(!Array.isArray(value)||value.length>max)fail('layout-list-budget');return snapshotData(value,budget);}
function status(snapshotId,completeness,reason=null){return createAnalysisStatus({snapshotId,analyzerId:'phase7.discovery.byte-layout',analyzerVersion:'1.0.0',completeness,stopReason:reason});}
function overlap(a,b){return a.start<b.end&&b.start<a.end;}

export async function queryDiscoveryLayout(options={}) {
  let budget,identity=null,started=performance.now(),controller,timer;
  const stopped=reason=>deepFreeze({schemaVersion:DISCOVERY_LAYOUT_SCHEMA,identity,status:status(identity?.snapshotId??'unbound-discovery-layout','partial',reason==='cancelled'?'cancelled':reason==='timeout'?'timeout':/budget/.test(reason)?'budget-exhausted':reason==='stale-identity'?'dependency-mismatch':'unsupported-input'),reason,
    canRewrite:false,byteCoverage:'unknown',classificationCompleteness:'partial',segments:[],candidates:[],relocations:[],unmapped:[],evidence:{nodes:[],edges:[]},metrics:{resources:budget?.snapshot()??null,elapsedMs:performance.now()-started}});
  try {
    const request=record(options);identity=identityOf(request.identity);
    const limits={...DISCOVERY_LAYOUT_LIMITS},provided=record(request.limits??{});
    for(const [key,value]of Object.entries(provided)){if(!Object.hasOwn(limits,key)||!Number.isSafeInteger(value)||value<0||value>Math.max(limits[key],1048576))fail('layout-limit-invalid');limits[key]=value;}
    const timeout=request.timeoutMs??1000;if(!Number.isSafeInteger(timeout)||timeout<0||timeout>10000)fail('layout-timeout-invalid');
    const signal=request.signal,current=request.getCurrentIdentity;
    if(current!=null&&typeof current!=='function')fail('layout-identity-provider-invalid');
    const check=()=>{if(signal?.aborted)fail('cancelled');if(performance.now()-started>=timeout)fail('timeout');if(current&&!equalIdentity(identity,identityOf(current())))fail('stale-identity');};
    budget=new ResourceBudget({workUnits:limits.maxWork,bytesRead:limits.maxBytes,residentBytes:limits.maxResidentBytes,artifactsMaterialized:limits.maxRecords});check();
    const take=(n=1)=>{check();budget.consume('workUnits',n);};
    const input=snapshotData(request.input??{},budget),mapped=list(request.mappedRegions,budget,limits.maxIntervals);
    if(!mapped.length)fail('layout-mappings-required');
    const source=asByteSource(request.source),mappings=[];let total=0;
    if(!Number.isSafeInteger(source.maxReadLength)||source.maxReadLength<1)fail('layout-source-read-limit-invalid');
    for(const raw of mapped){take();const item=record(raw),start=address(item.start),end=address(item.end),fileOffset=address(item.fileOffset);if(end<=start||end-start>BigInt(limits.maxBytes))fail('layout-byte-budget');const length=Number(end-start);if(fileOffset+BigInt(length)>source.size)fail('layout-mapping-outside-source');total+=length;mappings.push({start,end,fileOffset,length});}
    budget.consume('bytesRead',total);budget.consume('residentBytes',total*4);
    mappings.sort((a,b)=>{take();return a.start<b.start?-1:a.start>b.start?1:0;});
    for(let i=1;i<mappings.length;i++)if(mappings[i].start<mappings[i-1].end)fail('layout-overlapping-mappings');
    const registry=new DiscoveryProducerRegistry();for(const producer of GENERIC_PRODUCERS)registry.register(producer);
    const {evidence}=registry.collect(input,identity.architectureId,{signal});take(evidence.length);
    if(evidence.length>limits.maxRecords)fail('layout-evidence-budget');
    // Canonical fusion has an overlap pass. Reserve its conservative quadratic
    // bound before invoking it; report this as a reservation, not executed work.
    const fusionWorkReservation=evidence.length*evidence.length+evidence.length;
    take(fusionWorkReservation);
    const fusion=fuseFunctionCandidates(evidence,{snapshotId:identity.snapshotId,architectureId:identity.architectureId,signal,budget:{maxCandidates:limits.maxCandidates,maxEvidencePerCandidate:64}});check();
    if(fusion.status.completeness!=='complete')fail(fusion.status.stopReason??'layout-discovery-incomplete');
    const interpretations=[],relocations=[],ids=new Set();
    const add=item=>{take();budget.consume('artifactsMaterialized');budget.consume('residentBytes',256);take(stableStringify(item).length);const id=stableDigest(item);if(!ids.has(id)){ids.add(id);interpretations.push({...item,key:`layout-interpretation:${id}`,start:address(item.start),end:address(item.end)});}};
    for(const candidate of fusion.candidates){
      // Withdrawn candidate.regions must not erase the underlying alternatives.
      for(const evidence of candidate.extentEvidence)for(const region of evidence.regions){add({kind:'function-extent',functionStart:candidate.start,start:region.start,end:region.end,ownership:region.ownership,
        startState:candidate.startState,extentState:candidate.extentState,producerId:evidence.producerId,evidenceIds:evidence.evidenceIds,selectedByFusion:candidate.regions.some(r=>r.start===region.start&&r.end===region.end&&r.ownership===region.ownership)});}
    }
    for(const hint of list(request.hints??[],budget,limits.maxIntervals)){
      if(!['code','data','padding','jump-table'].includes(hint.kind))fail('layout-hint-kind');const start=address(hint.start),end=address(hint.end);if(end<=start)fail('layout-hint-range');
      const evidenceIds=list(hint.evidenceIds??[],budget,64).map(text).sort();
      add({id:text(hint.id),kind:hint.kind,start:start.toString(),end:end.toString(),evidenceIds,authority:'candidate-only'});
    }
    const relocationIds=new Set();
    for(const raw of list(request.relocations??[],budget,limits.maxIntervals)){
      take();const id=text(raw.id);if(relocationIds.has(id))fail('layout-duplicate-relocation-id');relocationIds.add(id);
      const start=address(raw.start),end=address(raw.end);if(end<=start)fail('layout-relocation-range');
      const expression=jsonSafe(record(raw.expression));
      relocations.push({id,start,end,producerId:text(raw.producerId),expression,mappingIncomplete:!mappings.some(m=>m.start<=start&&m.end>=end),authority:'relocation-candidate',canRewrite:false});
    }
    interpretations.sort((a,b)=>{take();return a.key<b.key?-1:a.key>b.key?1:0;});relocations.sort((a,b)=>{take();return a.id<b.id?-1:a.id>b.id?1:0;});
    const segments=[],snapshots=[],graph=new EvidenceGraph({}, {maxNodes:limits.maxRecords,maxEdges:limits.maxRecords});
    const unmapped=interpretations.filter(item=>!mappings.some(m=>m.start<=item.start&&m.end>=item.end)).map(item=>item.key);
    const read=async(offset,length)=>{
      check();controller=new AbortController();
      const aborted=()=>controller.abort();signal?.addEventListener('abort',aborted,{once:true});
      let stop;
      const denied=new Promise((_,reject)=>{stop=()=>reject(new Error('cancelled'));signal?.addEventListener('abort',stop,{once:true});timer=setTimeout(()=>{controller.abort();reject(new Error('timeout'));},Math.max(1,Math.ceil(timeout-(performance.now()-started))));});
      try{
        const value=await Promise.race([source.readExactly(offset,length,{signal:controller.signal}),denied]);check();
        if(typeof SharedArrayBuffer!=='undefined'&&value.buffer instanceof SharedArrayBuffer)fail('layout-shared-source-not-snapshot');
        return new Uint8Array(value);
      }finally{clearTimeout(timer);signal?.removeEventListener('abort',aborted);signal?.removeEventListener('abort',stop);}
    };
    for(const mapping of mappings){
      const copied=new Uint8Array(mapping.length);let offset=0;
      while(offset<mapping.length){take();const length=Math.min(source.maxReadLength,mapping.length-offset);copied.set(await read(mapping.fileOffset+BigInt(offset),length),offset);offset+=length;}
      snapshots.push({fileOffset:mapping.fileOffset,bytes:copied});
      const cut=new Set([mapping.start,mapping.end]);
      for(const item of [...interpretations,...relocations]){take();if(overlap(mapping,item)){cut.add(item.start<mapping.start?mapping.start:item.start);cut.add(item.end>mapping.end?mapping.end:item.end);}}
      for(const candidate of fusion.candidates){take();const start=BigInt(candidate.start);if(start>mapping.start&&start<mapping.end)cut.add(start);}
      const points=[...cut].sort((a,b)=>{take();return a<b?-1:a>b?1:0;});
      for(let i=0;i<points.length-1;i++){
        take();if(segments.length>=limits.maxSegments)fail('layout-segment-budget');budget.consume('residentBytes',256);
        const start=points[i],end=points[i+1],span={start,end},owners=[];
        for(const item of interpretations){take();if(overlap(span,item))owners.push(item);}
        const sites=[];for(const item of relocations){take();if(overlap(span,item))sites.push(item.id);}
        const first=Number(start-mapping.start),last=Number(end-mapping.start);let hex='';
        for(let b=first;b<last;b++){take();hex+=copied[b].toString(16).padStart(2,'0');}
        const segmentId=`layout-byte:${identity.snapshotId}:${start}`,keys=new Set(owners.map(item=>item.kind==='function-extent'?`function:${item.functionStart}`:`hint:${item.kind}:${item.id}`));
        const ambiguous=keys.size>1||owners.some(item=>item.kind==='function-extent'&&item.extentState==='unknown');
        const interpretationsWire=owners.map(item=>({...item,start:item.start.toString(),end:item.end.toString()}));
        const segment={id:segmentId,start:start.toString(),end:end.toString(),fileOffset:(mapping.fileOffset+BigInt(first)).toString(),bytesHex:hex,
          interpretations:interpretationsWire,relocationIds:sites,ambiguous,classification:owners.length?'candidate-set':'unclassified',canRewrite:false};
        segments.push(segment);budget.consume('artifactsMaterialized');
        graph.addNode({id:segmentId,family:'BinaryEvidence',binaryId:identity.binaryId,semanticKind:'original-byte-interval',completeness:'complete',deterministic:true,payload:{start:segment.start,end:segment.end,fileOffset:segment.fileOffset,bytesHex:hex,snapshotId:identity.snapshotId,sourceRevision:identity.sourceRevision}});
        for(const item of interpretationsWire){take();budget.consume('residentBytes',stableStringify(item).length*4+128);budget.consume('artifactsMaterialized',2);graph.addNode({id:item.key,family:'ControlFlowEvidence',binaryId:identity.binaryId,semanticKind:'discovery-interpretation',completeness:'partial',deterministic:true,payload:item});graph.addEdge({type:'observed-at',from:item.key,to:segmentId});}
      }
    }
    check();
    const relocationWire=relocations.map(item=>({...item,start:item.start.toString(),end:item.end.toString()}));
    const payload={schemaVersion:DISCOVERY_LAYOUT_SCHEMA,identity,status:status(identity.snapshotId,'complete'),reason:null,canRewrite:false,currentness:current?'host-revision-checked':'unverified',byteCoverage:'complete',classificationCompleteness:'partial',scope:'declared-file-backed-mappings',
      segments,candidates:fusion.candidates,relocations:relocationWire,unmapped,evidence:graph.toJSON()};
    const publicationUnits=stableStringify(payload).length;
    budget.consume('residentBytes',publicationUnits*2);take(publicationUnits);
    const digest=stableDigest(payload);check();
    const result=deepFreeze({...payload,digest,metrics:{resources:budget.snapshot(),elapsedMs:performance.now()-started,bytesCopied:total,fusionWorkReservation,publicationUnits,segments:segments.length,candidates:fusion.candidates.length,interpretations:interpretations.length,relocations:relocations.length}});
    issued.set(result,{identity,snapshots,current,signal});return result;
  }catch(error){return stopped(error instanceof BudgetExceededError?'budget-exhausted':error.message||'unsupported-input');}
  finally{clearTimeout(timer);}
}

/** Restore private original-byte snapshots, not edited or serialized claims. */
export function restoreDiscoveryBytes(result,options={}) {
  const receipt=issued.get(result);if(!receipt)fail('unissued-discovery-layout');
  const identity=identityOf(record(options).identity);
  if(receipt.signal?.aborted||!equalIdentity(receipt.identity,identity)||(receipt.current&&!equalIdentity(identity,identityOf(receipt.current()))))fail('stale-discovery-layout');
  return receipt.snapshots.map(item=>({fileOffset:item.fileOffset,bytes:new Uint8Array(item.bytes)}));
}
