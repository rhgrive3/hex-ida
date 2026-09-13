/** Bounded candidate construction over the explicit scalar model. No unrolling
 * and no new proof engine: every candidate goes through the independent
 * interval induction checker, including the user-requested postcondition.
 */
import { snapshotContractData, exactInteger } from '../identity/structured.js';
import { deepFreeze, stableStringify } from '../identity/index.js';
import { assertScopedAnalysisWork } from '../budgets/scoped-work.js';
import { checkScalarLoopInvariant } from './loop-invariant.js';
export function synthesizeScalarLoopInvariant(modelInput, postcondition, {work} = {}) {
  assertScopedAnalysisWork(work);work.checkpoint();
  const model=snapshotContractData(modelInput,{maxBytes:8192,maxNodes:128});
  const bits=exactInteger(model.bits,'loop-bits',{min:1,max:64}), top={lower:'0',upper:((1n<<BigInt(bits))-1n).toString()};
  // Reuse the checker to validate all model fields AND obtain the modular image.
  const bound=checkScalarLoopInvariant(model,{invariant:top,postcondition:top},{work});
  const spans=[model.entry,model.guard,...bound.image];
  const hull={lower:spans.reduce((a,v)=>a<BigInt(v.lower)?a:BigInt(v.lower),BigInt(top.upper)).toString(),
    upper:spans.reduce((a,v)=>a>BigInt(v.upper)?a:BigInt(v.upper),0n).toString()};
  const candidates=[{kind:'entry-only',invariant:model.entry},{kind:'guard-and-modular-image-hull',invariant:hull},{kind:'full-width',invariant:top}];
  const seen=new Set(),attempts=[];let candidate=null,checked=null;
  for(const entry of candidates){
    work.checkpoint();const key=stableStringify(entry.invariant);if(seen.has(key))continue;seen.add(key);
    const c={invariant:entry.invariant,postcondition},r=checkScalarLoopInvariant(model,c,{work});
    attempts.push({kind:entry.kind,invariant:entry.invariant,status:r.status,firstFailure:r.firstFailure});
    if(r.status==='verified-model'){candidate=c;checked=r;break;}
  }
  return deepFreeze({schema:'scpa-loop-synthesis/v1',status:candidate?'candidate-checked':'unknown',candidate,checked,attempts,
    strategy:'entry; convex-guard-plus-modular-image; full-width',maxCandidates:3,exact:false,semanticProof:false,rewriteAuthorized:false,
    remaining:['finite-template-search-not-general-invariant-synthesis','native-loop-model-extraction-unproved',...(!candidate?['no-template-establishes-requested-postcondition']:[])]});
}
