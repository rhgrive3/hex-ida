// Supplementary recovery experiment: separate from the already-used70 freeze.
import {snapshotCandidate,requestBody,describeCandidate} from './jev-realgame-final-contract.mjs';
import {demangleCxx} from '../js/rtti.js';
import {cxxQueryTokens} from '../js/analysis/cxx/query-recovery.js';

const ROLES=new Set(['return-input','comparison-input','arithmetic-input','address-base']);
export function recoverySnapshot(c,symbols,binarySha256) {
  const snapshot=snapshotCandidate(c,symbols,binarySha256);
  const provenance=(c.provenance??c.field?.provenance??[]).slice(0,64);
  snapshot.functionContexts=snapshot.functionContexts.map((ctx,i)=>({...ctx,
    accessRoles:(provenance[i]?.member?.accessRoles??[]).filter(role=>ROLES.has(role)).slice(0,4)}));
  return snapshot;
}
export const RECOVERY_INSTRUCTION='Select only an existing candidate. Identify the main object and requested value in the phrase separately from actions and related helper objects. Prefer evidence for that object and value over an unrelated class with a matching word. Machine use roles and method names are context, not proof of a source field name. A shared method may access several different members. This is a weak ranking preference, never binary proof.';
export function recoveryRequestBody(query,candidates,arm) {
  if(arm!=='E')return requestBody(query,candidates,arm);
  const body=requestBody(query,candidates,'C');
  body.questions.pick.instructions=RECOVERY_INSTRUCTION;
  body.questions.pick.criteria=Object.fromEntries(candidates.map((c,i)=>{
    const contexts=(c.functionContexts??[]).slice().sort((a,b)=>a.address.localeCompare(b.address)).slice(0,8);
    const parts=[describeCandidate(c,'C'),`reads: ${c.readCount??'unknown'}`,`writes: ${c.writeCount??'unknown'}`];
    for(const ctx of contexts)parts.push(`release method: ${String(ctx.name?(demangleCxx(ctx.name)??ctx.name):`0x${BigInt(ctx.address).toString(16)}`).slice(0,240)}; proven receiver: ${ctx.receiverProven===true}; uses: ${(ctx.accessRoles??[]).filter(r=>ROLES.has(r)).join(', ')||'unclassified'}`);
    return [`c${i}`,parts.join(' | ')];
  }));return body;
}

// Frozen comparator for weak C++ ranking only. A lexical match to an accessor
// whose loaded member feeds its return is more specific than a shared class.
// This selects a preference; it does not modify any evidence or verdict.
export function deterministicRecoveryPick(query,candidates) {
  const tokens=new Set(cxxQueryTokens(query));
  const score=c=>{
    if(c.source!=='cxx'||c.conflict)return 0;
    const classHits=cxxQueryTokens(c.className).filter(t=>tokens.has(t)).length;
    const context=Math.max(0,...(c.functionContexts??[]).map(ctx=>{
      const method=ctx.name?(demangleCxx(ctx.name)??ctx.name).split('(')[0].split('::').at(-1):'';
      const hits=cxxQueryTokens(method).filter(t=>tokens.has(t)&&!cxxQueryTokens(c.className).includes(t)).length;
      return 4*hits*(ctx.accessRoles?.includes('return-input')?2:1);
    }));return 2*classHits+context;
  };
  const ranked=candidates.map((c,i)=>({c,i,score:score(c)})).sort((a,b)=>b.score-a.score||a.i-b.i);
  return ranked[0]?.score>0?ranked[0].c:candidates[0]??null;
}
