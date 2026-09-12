/** Recorded, counterbalanced task trial inventory. A nonempty complete
 * denominator is fixed before observations. Missing/failed/incorrect rows are
 * not dropped to make a faster-looking paired sample. No people are recruited,
 * timed, or declared improved by this module; host records are unadmitted.
 */
import {assertIssuedTaskIdiomView} from '../../core/evidence/task-idiom.js';
import {snapshotContractData,recordFields,exactString,exactEnum,contractFail} from '../../core/identity/structured.js';
import {deepFreeze,stableDigest} from '../../core/identity/index.js';
import {assertScopedAnalysisWork} from '../../core/budgets/scoped-work.js';
const PLANS=new WeakSet();
export function createReadabilityTaskPlan(view,participantIds,{work}={}) {
  assertIssuedTaskIdiomView(view);assertScopedAnalysisWork(work);work.checkpoint();
  const ids=snapshotContractData(participantIds,{maxBytes:8192,maxNodes:128});
  if(!Array.isArray(ids)||!ids.length||ids.length>32||new Set(ids).size!==ids.length)contractFail('reading-participant-set');
  ids.forEach(id=>exactString(id,'reading-pseudonymous-participant',128));
  const cases=view.statements.filter(s=>s.selection==='checked-idiom');
  if(!cases.length||cases.length>16||cases.length*ids.length*2>256)contractFail('reading-task-budget-or-empty');
  const rows=[];
  for(const [p,participantId]of ids.entries())for(const [c,statement]of cases.entries())for(const [order,variant]of ((p+c)%2?['idiom','original']:['original','idiom']).entries()) {
    work.charge('workUnits');
    rows.push({id:stableDigest([view.viewId,participantId,statement.statementId,variant]),participantId,statementId:statement.statementId,
      variant,order,prompt:'Which hexadecimal mask is tested by this condition?',expectedAnswer:statement.candidate.maskHex,
      sourceViewId:view.viewId,display:variant==='idiom'?statement.display:statement.originalText});
  }
  const body={schema:'scpa-readability-task-plan/v1',sourceViewId:view.viewId,worldId:view.worldId,snapshotId:view.snapshotId,task:view.task,
    rows,expected:rows.length,assignment:'counterbalanced-AB-BA-by-fixed-participant-case-index',preregistrationVerified:false,
    semanticProof:false,humanStudyQualified:false};
  const plan=deepFreeze({...body,id:stableDigest(body)});PLANS.add(plan);return plan;
}
export function auditReadabilityTaskRecords(plan,records,{work}={}) {
  assertScopedAnalysisWork(work);work.checkpoint();if(!PLANS.has(plan))contractFail('reading-issued-plan-required');
  const data=snapshotContractData(records,{maxBytes:262144,maxNodes:4096});if(!Array.isArray(data)||data.length>plan.expected)contractFail('reading-record-budget');
  const expected=new Map(plan.rows.map(r=>[r.id,r])),observed=new Map();
  for(const r of data){
    work.charge('workUnits');recordFields(r,['trialId','sourceViewId','outcome','durationMs','answer','evidenceIds'],'reading-record-fields');
    if(!expected.has(r.trialId)||observed.has(r.trialId)||r.sourceViewId!==plan.sourceViewId)contractFail('reading-record-binding');
    exactEnum(r.outcome,['completed','failed','abandoned'],'reading-outcome');
    if(r.durationMs!==null&&(typeof r.durationMs!=='number'||!Number.isFinite(r.durationMs)||r.durationMs<0||r.durationMs>86400000))contractFail('reading-duration');
    if(r.answer!==null)exactString(r.answer,'reading-answer',128);
    if(!Array.isArray(r.evidenceIds)||!r.evidenceIds.length||r.evidenceIds.length>16)contractFail('reading-observation-evidence');r.evidenceIds.forEach(v=>exactString(v,'reading-evidence',256));
    if(r.outcome==='completed'&&(r.durationMs===null||r.answer===null))contractFail('reading-completed-missing-measurement');
    observed.set(r.trialId,r);
  }
  const rows=plan.rows.map(t=>{const r=observed.get(t.id);return{trialId:t.id,participantId:t.participantId,statementId:t.statementId,variant:t.variant,
    state:r?r.outcome:'UNMEASURED',correct:r?.outcome==='completed'?r.answer===t.expectedAnswer:null,durationMs:r?.durationMs??null,evidenceIds:r?.evidenceIds??[]};});
  const pairs=[];
  for(let i=0;i<rows.length;i+=2){const a=rows[i].variant==='original'?rows[i]:rows[i+1],b=rows[i].variant==='idiom'?rows[i]:rows[i+1];
    const measured=a.correct===true&&b.correct===true;
    pairs.push({participantId:a.participantId,statementId:a.statementId,state:measured?'RECORDED-UNVERIFIED':'INCOMPLETE-OR-INCORRECT',
      durationDeltaMs:measured?b.durationMs-a.durationMs:null,interpretation:'descriptive-only; human-provenance-and-learning-effects-unqualified'});}
  const missing=rows.filter(r=>r.state==='UNMEASURED').length,incorrect=rows.filter(r=>r.correct===false).length;
  return deepFreeze({schema:'scpa-readability-task-audit/v1',planId:plan.id,status:missing?'UNMEASURED-OR-PARTIAL':'RECORDED-UNVERIFIED',
    expected:plan.expected,recorded:observed.size,missing,incorrect,rows,pairs,semanticProof:false,humanStudyQualified:false,improvementClaim:false,
    remaining:['actual-human-provenance-unverified','preregistration-not-independently-verified','cross-task-transfer-and-competitor-baseline-unmeasured','no-production-readability-admission']});
}
