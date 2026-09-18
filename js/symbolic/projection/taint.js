/** Projection only: consume taint owner facts; never infer sources in UI/AI. */
import { stableDigest } from '../../core/identity/index.js';
import { createEvidenceNode, createEvidenceEdge } from '../../core/evidence/index.js';
import { createSymbolicEvidence } from '../evidence/symbolic-evidence.js';
import { isTaintQueryResult } from '../query/taint.js';
export function projectTaint(result,{identity=result?.identity,modelIdentity=result?.modelIdentity}={}) {
  if(!isTaintQueryResult(result,identity,modelIdentity)) return Object.freeze({status:'stale-or-unissued',evidence:null,graph:null});
  const queryHash=stableDigest({identity,modelIdentity,assumptions:result.execution?.assumptions??[],values:result.values,edges:result.edges,sinks:result.sinks,status:result.status,memoryObservations:result.execution?.memoryObservationRequests??[]});
  const prefix=`taint:${queryHash}:`;
  const nodes=result.values.map(value=>createEvidenceNode({id:prefix+value.id,family:'SymbolicEvidence',
    binaryId:identity.binaryId,targetEntityIds:value.valueId?[value.valueId]:[],semanticKind:'taint-flow',
    completeness:result.status==='complete'?'bounded':'partial',deterministic:true,
    payload:{identity,modelIdentity,valueId:value.valueId,observationId:value.observationId,taint:value.taint}}));
  const edges=result.edges.map(edge=>createEvidenceEdge({from:prefix+edge.to,to:prefix+edge.from,type:'derived-from',metadata:{flowKind:edge.kind}}));
  // Explicit explanation endpoints. The graph only projects owner-issued
  // dependencies/models; it does not reconstruct taint from labels or names.
  for(const [kind,entries] of [['source',result.models.sources],['sink',result.sinks],['sanitizer',result.models.sanitizers]]) {
    for(const model of entries) {
      const id=prefix+kind+':'+model.id;
      nodes.push(createEvidenceNode({id,family:'SymbolicEvidence',binaryId:identity.binaryId,
        targetEntityIds:model.valueId!=null?[model.valueId]:[],semanticKind:'taint-'+kind,
        completeness:result.status==='complete'?'bounded':'partial',deterministic:true,
        payload:{identity,modelIdentity,model}}));
      const value=prefix+(model.observationId!=null?'observation:'+model.observationId:'value:'+model.valueId);
      edges.push(createEvidenceEdge({from:kind==='source'?value:id,to:kind==='source'?id:value,
        type:'derived-from',metadata:{flowKind:'model-'+kind}}));
    }
  }
  const evidence=createSymbolicEvidence({queryKind:'taint-flow',claimKind:'symbolic-query',
    proofStatement:'Bounded conservative taint dependencies; not a semantic-equivalence proof',
    targetEntities:result.sinks.filter(s=>s.valueId!=null).map(s=>s.valueId),queryHash,backendId:'hex-taint-lattice',backendVersion:'1.0.0',
    solverStatus:'unsupported',verdict:'unknown',architecture:identity.architecture,
    completeness:{translation:'complete',controlFlow:result.status==='complete'?'complete':'partial',memoryEffects:result.status==='complete'?'complete':'partial',pathCoverage:result.status==='complete'?'complete':'partial',queryScope:'complete'},
    proofScope:{kind:'query-local-taint',identity,modelIdentity,assumptions:result.execution?.assumptions??[]},
    metadata:{memoryObservations:result.execution?.memoryObservationRequests??[],sources:result.models.sources,sinks:result.sinks,sanitizers:result.models.sanitizers,unknownSanitizers:result.unknownSanitizers,widened:result.widened}});
  return Object.freeze({status:result.status,evidence,graph:Object.freeze({schemaVersion:1,nodes:Object.freeze(nodes),edges:Object.freeze(edges)})});
}
