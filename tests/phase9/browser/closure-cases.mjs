/** Browser-portable v5 production checks. This is additional runtime evidence,
 * not the project's pinned WebKit/iPad or official performance collector. */
import * as S from '../../../js/symbolic/index.js';
import { OP, MK } from '../../../js/ir-base.js';
import { identity, machineIR } from '../memory/main-fixtures.mjs';
const require = (condition, reason) => { if (!condition) throw new Error(reason); };
function program(value) {
  const instructions=[{id:'write',op:OP.STORE,args:[{value:{id:'byte',bits:8,const:BigInt(value)}}],loc:{kind:MK.GLOBAL,address:0n,size:1},row:0,address:0n},
    {id:'return',op:OP.RET,args:[{value:{id:'zero',bits:8,const:0n}}],row:1,address:4n}];
  return {entry:0,instructions,blocks:[{index:0,insts:instructions,succ:[]}]};
}
export async function runClosureBrowserCases({includeWorker=false}={}) {
  const cases=[];
  const record=async(name,action)=>{const start=performance.now(),metrics=await action();cases.push({name,status:'PASS',milliseconds:performance.now()-start,metrics});};
  await record('raw-producer-opcode-and-width',()=>{
    const r=S.translate.translateSemanticIR({id:'xor',op:OP.BIN,sub:'xor',dst:{id:'value',bits:8},args:[{value:{id:'a',bits:8,const:5n}},{value:{id:'b',bits:8,const:3n}}]});
    require(r.status==='exact'&&r.expression.sort.width===8&&S.expr.evaluateExpr(r.expression).value===6n,'raw xor or width mismatch');return r.metrics;
  });
  await record('canonical-machine-byte-access-taint-evidence',()=>{
    const ir=machineIR(['strb w1,[x0]','ldrsb x2,[x0]','ret']);
    const input=ir.values.find(v=>v.kind==='arg'&&v.reg==='x1');
    const output=ir.instructions.find(i=>i.extra?.stateWrite&&i.dst?.reg==='x2').dst;
    const context={...identity,...S.projectedMemoryAccessContext(ir),addressSpace:'memory'};
    const models=S.createTaintModels({id:'browser-closure',version:'1',provenance:'production-machine',sources:[{id:'input',valueId:S.semanticValueIdentity(input)}],sinks:[{id:'output',valueId:S.semanticValueIdentity(output)}]});
    const r=S.queryTaint(ir,{identity:context,models,memory:{addressBits:64,wrapping:'modular',accessSemantics:'canonical-normal-completion'},execution:{symbolicArgs:{0:256n}}});
    require(r.status==='complete',r.reason);require(r.sinks[0].taint.sources.includes('input')&&r.evidence.proofScope.assumptions.length>0,'taint or scope missing');return r.metrics;
  });
  const memory={addressBits:1,wrapping:'modular',initialBytes:[[0n,0],[1n,0]]};
  await record('all-byte-equivalence-real-proved-and-refuted',async()=>{
    const beforeIr=program(1),afterIr=program(1);
    const r=await S.queryMemoryEquivalence({identity,beforeIr,afterIr,memory,inputs:[]});
    require(r.eligible,r.reason);require(S.isAdoptableMemoryEquivalence(r,{identity,beforeIr,afterIr,memory,inputs:[],preconditions:[]}),'issued proof not consumable');
    const no=await S.queryMemoryEquivalence({identity,beforeIr,afterIr:program(2),memory,inputs:[]});
    require(no.verdict==='refuted'&&no.firstDivergence.address===0n,'store difference was not refuted');return {equivalent:r.metrics,refuted:no.metrics};
  });
  await record('finite-memory-cancellation-no-publication',async()=>{
    const r=await S.queryMemoryEquivalence({identity,beforeIr:program(1),afterIr:program(1),memory,inputs:[],signal:AbortSignal.abort()});
    require(!r.eligible&&!r.evidence&&r.verdict==='unknown','cancel published proof');return r.metrics;
  });
  if(includeWorker)await record('existing-dedicated-worker-backend-sat-unsat',async()=>{
    const [{WorkerSolverBackend},Q]=await Promise.all([import('../../../js/symbolic/solver/worker-backend.js'),import('../../../js/symbolic/verify/query.js')]);
    const E=S.expr,x=E.createFreshSymbol(E.bvSort(2),'closure-worker'),backend=new WorkerSolverBackend({maxBvWidth:8,maxAssignments:256});
    const session=backend.createSession({timeoutMs:2000});
    try {
      const make=values=>Q.createVerificationQuery({kind:Q.VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,claimKind:Q.CLAIM_KIND.EDGE_INFEASIBLE,constraints:values.map(v=>E.createCompare('eq',x,E.createBv(2,BigInt(v))))});
      const sat=await session.check(make([1])),unsat=await session.check(make([1,2]));
      require(sat.status==='sat'&&unsat.status==='unsat'&&sat.backend==='hex-exhaustive-bv-worker','worker result mismatch');
      return {sat:sat.status,unsat:unsat.status,backend:sat.backend,isolation:backend.capabilities().executionIsolation};
    } finally {await session.dispose();}
  });
  return cases;
}
