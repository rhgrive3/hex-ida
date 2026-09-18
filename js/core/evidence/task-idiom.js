/** Task-driven, source-linked explanatory idioms. This is neither a C renderer
 * nor a CFG optimizer. A candidate must lower back to the same checked typed
 * predicate before the opt-in task view may display it. Original statements,
 * order and unresolved proof obligations always remain available.
 */
import {snapshotContractData,recordFields,exactString,exactEnum,contractFail} from '../identity/structured.js';
import {deepFreeze,stableDigest,stableStringify,lossyTypeWitness} from '../identity/index.js';
import {checkBitvectorViewRelation} from './bv-view-proof.js';
import {checkNativeTransformRelation,explainNativeTransformProjection} from './native-transform.js';
const typed=v=>stableStringify([v,lossyTypeWitness(v)]);
const TASK_VIEWS=new WeakSet();
export function assertIssuedTaskIdiomView(v){if(!TASK_VIEWS.has(v))contractFail('issued-task-view-required');return v;}
export const TASK_IDIOM_SCHEMA='scpa-mask-condition-idiom/v1';
export const READING_TASKS=Object.freeze(['inspect-bit-condition','trace-value','inspect-memory-order']);
export function proposeMaskCondition(expression) {
  const e=snapshotContractData(expression,{allowBigInt:true,maxBytes:262144,maxNodes:4096});
  if(e?.kind!=='compare'||!['==','!='].includes(e.op)||e.comparisonDomain!=='integer'||e.effect!=='pure')return null;
  const zero=x=>x?.kind==='const'&&typeof x.value==='bigint'&&BigInt.asUintN(x.bits,x.value)===0n;
  const masked=zero(e.right)?e.left:zero(e.left)?e.right:null;
  if(masked?.kind!=='binary'||!['and','&'].includes(masked.op)||masked.effect!=='pure')return null;
  const mask=masked.right?.kind==='const'?masked.right:masked.left?.kind==='const'?masked.left:null;
  const operand=mask===masked.right?masked.left:masked.right;
  if(!mask||typeof mask.value!=='bigint'||!Number.isSafeInteger(mask.bits)||mask.bits<1||mask.bits>128||mask.bits!==masked.bits)return null;
  const value=BigInt.asUintN(mask.bits,mask.value);if(value===0n)return null;
  return deepFreeze({schema:TASK_IDIOM_SCHEMA,kind:e.op==='!='?'any-set':'all-clear',width:mask.bits,maskHex:'0x'+value.toString(16),operand,
    sourceExpression:e,scope:'typed-bit-condition-only; not-C-or-machine-equivalence'});
}
export function lowerMaskCondition(input) {
  const c=snapshotContractData(input,{allowBigInt:true,maxBytes:262144,maxNodes:4096});
  recordFields(c,['schema','kind','width','maskHex','operand','sourceExpression','scope'],'task-idiom-fields');
  if(c.schema!==TASK_IDIOM_SCHEMA||!Number.isSafeInteger(c.width)||c.width<1||c.width>128||typeof c.maskHex!=='string'||!/^0x[1-9a-f][0-9a-f]*$/.test(c.maskHex)||c.maskHex.length>34||BigInt(c.maskHex)>=(1n<<BigInt(c.width)))contractFail('task-idiom-contract');
  exactEnum(c.kind,['any-set','all-clear'],'task-idiom-kind');
  const e=c.sourceExpression;
  const constant={kind:'const',bits:c.width,signed:false,effect:'pure',value:BigInt(c.maskHex)};
  return {kind:'compare',bits:1,signed:false,effect:'pure',op:c.kind==='any-set'?'!=':'==',compareSigned:e.compareSigned,comparisonDomain:'integer',
    left:{kind:'binary',bits:c.width,signed:c.operand.signed,effect:'pure',op:'and',left:c.operand,right:constant},
    right:{...constant,value:0n}};
}
export async function projectTaskIdiomView(view,request,context) {
  const {work}=context;work.checkpoint();
  const q=snapshotContractData(request,{maxBytes:8192,maxNodes:128});recordFields(q,['task','statementIds'],'task-view-query');exactEnum(q.task,READING_TASKS,'task-view-task');
  if(q.statementIds!==undefined&&(!Array.isArray(q.statementIds)||!q.statementIds.length||q.statementIds.length>16))contractFail('task-view-selection');
  q.statementIds?.forEach(v=>exactString(v,'task-statement-id',128));if(q.statementIds&&new Set(q.statementIds).size!==q.statementIds.length)contractFail('task-view-duplicate-selection');
  // Canonical projection binding and existing transformations are checked first.
  const chain=await explainNativeTransformProjection(view,context);
  if(chain.status!=='completed')return {status:'unsupported',reason:'task-native-proof-projection-unavailable',exact:false};
  const slots=view.capture.finalExpressionStatements;
  if(!Array.isArray(slots)||slots.length!==view.finalStatements.length)return {status:'unsupported',reason:'task-source-expressions-not-captured',exact:false};
  const changes=new Map(chain.statements.map(s=>[s.statementId,s])),seen=new Set(),statements=[];
  for(const [i,slot]of slots.entries()) {
    work.checkpoint();work.charge('workUnits');const id=`phase8-statement:${i}`,final=view.finalStatements[i];seen.add(id);
    if(slot.index!==i||final.index!==i||slot.text!==final.text||slot.statementKind!==final.statementKind||typed(slot.source)!==typed(final.source)||typed(slot.location)!==typed(final.location))contractFail('task-final-statement-binding');
    let candidate=null,proof=null,reason='not-selected-for-idiom-task';
    if(q.task==='inspect-bit-condition'&&(!q.statementIds||q.statementIds.includes(id))&&slot.expression){
      candidate=proposeMaskCondition(slot.expression);reason=candidate?'native-transform-premises-open':'unsupported-condition-idiom';
      if(candidate&&(!changes.has(id)||changes.get(id).chain.status==='conditionally-verified')){
        const after=lowerMaskCondition(candidate);
        const current=checkNativeTransformRelation({before:slot.expression,after:slot.expression,beforeStatement:slot,afterStatement:slot,statementId:id,statementIndex:i,mapping:'actual-final-slot'},
          {...context,finalStatements:view.finalStatements,memoryFrame:view.memoryFrame,worldId:context.world.id});
        const idiom=checkBitvectorViewRelation(slot.expression,after,{work});
        proof={current,idiom};reason=current.status==='verified'&&idiom.status==='verified'?null:'idiom-proof-unresolved';
      }
    }
    const selected=candidate&&reason===null;
    statements.push({statementId:id,index:i,source:slot.source,originalText:slot.text,selection:selected?'checked-idiom':'original',
      candidate:selected?candidate:null,proof,reason,display:selected?`${candidate.kind==='any-set'?'Any bit set':'All bits clear'} under mask ${candidate.maskHex} (${candidate.width}-bit value)`:slot.text});
    await work.yieldIfNeeded();
  }
  if(q.statementIds?.some(id=>!seen.has(id)))contractFail('task-statement-outside-capture');
  if(context.isCurrent?.()!==true)contractFail('task-owner-stale-before-publication');
  const body={schema:'scpa-task-idiom-view/v1',status:'completed',task:q.task,worldId:context.world.id,assumptionsId:context.assumptions.id,
    snapshotId:context.snapshotId,functionId:context.functionId,producerArtifactId:context.producerArtifactId,statements,
    changedViewCount:statements.filter(s=>s.selection==='checked-idiom').length,originalStatementOrder:statements.map(s=>s.statementId),
    humanTaskResults:'UNMEASURED',semanticProof:false,exact:false,rewriteAuthorized:false,defaultActivation:false,releaseQualified:false,
    remaining:[...chain.remaining,'human-task-time-and-correctness-unmeasured','not-C-rendering-or-CFG-structuring-proof','conditional-production-semantics-gates-unmet']};
  const result=deepFreeze({...body,viewId:stableDigest({body,typed:lossyTypeWitness(body)})});TASK_VIEWS.add(result);return result;
}
