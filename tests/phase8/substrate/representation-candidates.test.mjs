import assert from 'node:assert/strict';
import test from 'node:test';
import * as E from '../../../js/symbolic/expr/index.js';
import { querySymbolicAnalysis, isSymbolicAnalysisResult, readSymbolicTargetInputs } from '../../../js/symbolic/query/analysis.js';
import { createTaintModels } from '../../../js/symbolic/taint/models.js';
import { isAdoptableCandidate } from '../../../js/symbolic/taint/proof-consumer.js';
import { compileRepresentationProposal, queryRepresentationCandidates, REPRESENTATION_RULES,
  REPRESENTATION_CANDIDATE_VERSION, REPRESENTATION_REWRITE_LIMITS, readRepresentationGeneratorAudit } from '../../../js/decompiler/phase8/representation-candidates.js';
import { DEFAULT_RULES } from '../../../js/decompiler/rewrite/rules.js';
import { expr } from '../../../js/decompiler/ast/nodes.js';
import { evaluateExpression } from '../../../js/decompiler/verify/equivalence.js';
import { preparePhase8RewritePlan, isPhase8RewritePlan, readProvedRewrites } from '../../../js/decompiler/phase8/pass-validation.js';
import { enhanceSemanticDecompilation, optimizeSemanticDecompilation } from '../../../js/decompiler/pipeline.js';
import { proofFixture, identity } from '../helpers/proof-fixtures.mjs';
import { fixture } from '../helpers/ir-fixtures.mjs';
import { buildSemanticModel } from '../../../js/blocks.js';
import { decompileWithProof } from '../../../js/decompile.js';
import { runPhase8Stage } from '../../../js/decompiler/phase8/index.js';
import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';
import { createDecompilerNavigation } from '../../../js/ui/decompiler-provenance.js';

const models = createTaintModels({id:'representation-test',version:'1',provenance:'test-fixture',sources:[],sinks:[]});
function query(expression, symbols, overrides = {}) {
  return queryRepresentationCandidates({expression,valueId:'value',identity,timeoutMs:1000,backendTier:'tiered',
    inputBinding:{expression,inputs:symbols.map(symbol => ({symbol,bits:symbol.sort.width}))},...overrides});
}

function assertGeneratorAudit(audit, queryHash) {
  assert.ok(audit,'the actual generator must issue an audit');
  assert.equal(audit.strategy,'representation-rules');
  assert.equal(audit.schemaVersion,'hex-phase8-generator-audit/v1');
  assert.equal(audit.scope,'whole-target-rewrite-run-not-per-rule-equivalence-or-render-adoption');
  assert.equal(audit.rulesetVersion,REPRESENTATION_CANDIDATE_VERSION);
  assert.equal(audit.proofQueryHash,queryHash);
  assert.deepEqual(audit.rewriteLimits,REPRESENTATION_REWRITE_LIMITS);
  assert.deepEqual(audit.appliedRules,[...new Set(audit.ruleTrace)]);
  assert.equal(audit.ruleTrace.length,audit.rewriteResources.applications);
  assert.ok(audit.ruleTrace.length > 0 && audit.ruleTrace.length <= audit.rewriteLimits.maxApplications);
  assert.ok(audit.rewriteResources.iterations > 0
    && audit.rewriteResources.iterations <= audit.rewriteLimits.maxIterations * audit.rewriteResources.phases);
  assert.equal(audit.rewriteResources.budgetExceeded,false);
  for (const rule of audit.appliedRules) {
    assert.ok(REPRESENTATION_RULES.some(row => row.name === rule));
    assert.equal(audit.ruleApplications[rule],audit.ruleTrace.filter(name => name === rule).length);
  }
  for (const [key,limit] of Object.entries(audit.limits)) {
    assert.ok(Number.isSafeInteger(audit.resources[key]) && audit.resources[key] >= 0 && audit.resources[key] <= limit);
  }
  assert.equal(audit.resources.candidates,1);
  assert.equal(Object.hasOwn(audit.resources,'wallClock'),false);
  for (const item of [audit,audit.appliedRules,audit.ruleTrace,audit.ruleApplications,audit.rewriteLimits,
    audit.rewriteResources,audit.limits,audit.resources]) assert.ok(Object.isFrozen(item));
  assert.deepEqual(JSON.parse(JSON.stringify(audit)),audit);
  assert.equal(isAdoptableCandidate(audit,{identity}),false);
  assert.equal(isPhase8RewritePlan(audit),false);
}

test('C4-04 representation denominator reuses all 64 actual rules, without claiming universal rule proofs', async () => {
  assert.equal(REPRESENTATION_RULES.length,64);
  assert.deepEqual(REPRESENTATION_RULES,DEFAULT_RULES.map(({name,phase}) => ({name,phase})));
  assert.ok(Object.isFrozen(REPRESENTATION_RULES) && REPRESENTATION_RULES.every(Object.isFrozen));
  const x = E.createFreshSymbol(E.bvSort(4),'x');
  const r = await query(E.createBinary('xor',x,x),[x]);
  assert.equal(r.status,'complete',r.reason);
  assert.equal(r.ruleCoverage.rows.length,64);
  assert.equal(r.ruleCoverage.registered,64);
  assert.equal(r.ruleCoverage.scope,'candidate-generation-not-rule-theorems-or-render-adoption');
  assert.ok(Object.isFrozen(r.ruleCoverage) && Object.isFrozen(r.ruleCoverage.rows) && r.ruleCoverage.rows.every(Object.isFrozen));
  const row = r.ruleCoverage.rows.find(row => row.name === 'xor-self');
  assert.equal(row.candidateApplications,1);
  assert.equal(row.disposition,'proved-candidate');
  assert.equal(r.candidates[0].after.kind,'const');
  assert.equal(r.candidates[0].after.value,0n);
  assert.equal(isAdoptableCandidate(r.candidates[0].verification,{identity}),true);
  assert.equal(Object.hasOwn(row,'adopted'),false);
});

test('C4-04 real display-rule proposals are independently checked across narrow and native widths', async () => {
  const observed = [];
  for (const bits of [1,4,8,16,32,64]) for (const op of ['xor','or','add']) {
    const x = E.createFreshSymbol(E.bvSort(bits),`x${bits}`), before = E.createBinary(op,x,x);
    const r = await query(before,[x]);
    assert.equal(r.status,'complete',`${bits}/${op}:${r.reason}`);
    assert.equal(r.candidates.length,1,`${bits}/${op}`);
    const candidate = r.candidates[0];
    const audit = readRepresentationGeneratorAudit(candidate);
    assertGeneratorAudit(audit,candidate.verification.evidence.queryHash);
    assert.equal(audit.candidateId,candidate.candidateId);
    assert.deepEqual(audit.appliedRules,candidate.rules);
    if (op === 'add') assert.deepEqual(audit.ruleTrace,['double-term','strength-mul-power-two']);
    assert.deepEqual(audit.resources,Object.fromEntries(Object.keys(audit.limits).map(key => [key,r.metrics[key]])));
    for (const row of r.ruleCoverage.rows) assert.equal(row.candidateApplications,audit.ruleApplications[row.name] ?? 0);
    assert.equal(readRepresentationGeneratorAudit({...candidate}),null);
    // The actual legacy double-term -> multiply/shift chain is wrong at BV1:
    // its display shift masks 1 to 0, whereas x+x is zero. Keep the refuted cell
    // in the same 18-cell denominator instead of dropping it or relaxing proof.
    const eligible = !(bits === 1 && op === 'add');
    assert.equal(candidate.eligible,eligible,candidate.verification.reason);
    assert.equal(candidate.after.sort.width,bits);
    if (eligible) assert.equal(candidate.verification.before,before);
    else assert.equal(candidate.verification.verdict,'refuted');
    assert.equal(isAdoptableCandidate(candidate.verification,{identity}),eligible);
    observed.push(`${bits}/${op}`);
    if (!eligible) continue;
    for (const value of [0n,1n,1n << BigInt(bits - 1),(1n << BigInt(bits)) - 1n]) {
      const expected = BigInt.asUintN(bits,op === 'xor' ? 0n : op === 'or' ? value : value + value);
      const actual = E.evaluateExpr(candidate.after,new Map([[x.symbolId,value]]));
      assert.equal(actual.status,E.EVAL_STATUS.VALUE);
      assert.equal(actual.value,expected);
    }
  }
  assert.equal(new Set(observed).size,18);
});

test('C4-04 independent verification refutes the existing unsigned-select abs proposal', async () => {
  const x = E.createFreshSymbol(E.bvSort(4),'x');
  // Unsigned x < 0 is false. The actual legacy select-abs rule still proposes
  // signed abs(x); its own truthy evidence is not an admissible proof.
  const before = E.createIte(E.createCompare('ult',x,E.createBv(4,0n)),E.createUnary('neg',x),x);
  const r = await query(before,[x]);
  assert.equal(r.status,'complete',r.reason);
  assert.equal(r.candidates.length,1);
  assert.equal(r.candidates[0].eligible,false);
  assert.equal(r.candidates[0].verification.verdict,'refuted');
  assert.equal(isAdoptableCandidate(r.candidates[0].verification,{identity}),false);
  assert.equal(r.ruleCoverage.rows.find(row => row.name === 'select-abs').disposition,'refuted');
  assert.ok(r.candidates[0].verification.counterexample);
});

test('C4-04 a refuted real rule chain cannot enter the production proof plan', async () => {
  const f = proofFixture(1); f.target.def.sub = 'add';
  const plan = await preparePhase8RewritePlan(f.ir,{...f.options,candidateStrategy:'representation-rules'});
  assert.equal(plan.status,'complete',plan.reason);
  assert.deepEqual(plan.entries,[]);
  assert.equal(plan.targetDecisions[0].disposition,'refuted');
  assert.equal(plan.targetDecisions[0].ruleCoverage.registered,64);
  assert.ok(plan.targetDecisions[0].ruleCoverage.rows.some(row => row.disposition === 'refuted'));
  assert.equal(f.target.def.sub,'add');
});

test('C4-04 a source with no rule match does not acquire synthetic carrier-cast candidates', async () => {
  const x = E.createFreshSymbol(E.bvSort(4),'x'), y = E.createFreshSymbol(E.bvSort(4),'y');
  const r = await query(E.createBinary('xor',x,y),[x,y]);
  assert.equal(r.status,'complete',r.reason);
  assert.deepEqual(r.candidates,[]);
  assert.ok(r.ruleCoverage.rows.every(row => row.candidateApplications === 0 && row.disposition === 'not-selected'));
});

test('C4-04 proposal compilation binds leaves by object, rejects effects/getters/cycles and bounds expansion', () => {
  const x = E.createFreshSymbol(E.bvSort(4),'canonical_x'), y = E.createFreshSymbol(E.bvSort(4),'canonical_y');
  const a = expr.variable('same_display_name',4,false), b = expr.variable('same_display_name',4,false);
  const inputs = new Map([[a,x],[b,y]]), term = expr.binary('sub',a,b,4,false);
  const compiled = compileRepresentationProposal(term,inputs);
  assert.equal(compiled.left,x); assert.equal(compiled.right,y);
  assert.throws(() => compileRepresentationProposal({...a},inputs),/unbound-representation-input/);
  assert.throws(() => compileRepresentationProposal(expr.load({},4),inputs),/unsupported-representation/);
  let reads = 0;
  assert.throws(() => compileRepresentationProposal({get kind() { reads++; return 'const'; }},inputs));
  assert.equal(reads,0);
  const cycle = expr.unary('not',a,4,false); cycle.arg = cycle;
  assert.throws(() => compileRepresentationProposal(cycle,inputs),/representation-proposal-bound/);
  let deep = a;
  for (let i=0;i<66;i++) deep = expr.unary('not',deep,4,false);
  assert.throws(() => compileRepresentationProposal(deep,inputs),/representation-proposal-bound/);
});

test('C4-04 proposal adapter agrees with the existing typed AST evaluator on small-width arithmetic and shifts', () => {
  for (const bits of [1,2,3,4]) {
    const x = E.createFreshSymbol(E.bvSort(bits),'x'), y = E.createFreshSymbol(E.bvSort(bits),'y');
    const a = expr.variable('a',bits,false), b = expr.variable('b',bits,false), inputs = new Map([[a,x],[b,y]]);
    const nodes = ['add','sub','mul','and','or','xor','shl','lshr','ashr'].map(op => expr.binary(op,a,b,bits,false));
    for (const op of ['eq','ne','lt','le','gt','ge']) for (const signed of [false,true]) nodes.push(expr.compare(op,a,b,signed));
    nodes.push(expr.unary('abs',a,bits,true),expr.select(expr.compare('lt',a,b,true),a,b,bits,false));
    for (const node of nodes) {
      const compiled = compileRepresentationProposal(node,inputs);
      for (let i=0;i<2**bits;i++) for (let j=0;j<2**bits;j++) {
        const av = BigInt(i), bv = BigInt(j), actual = E.evaluateExpr(compiled,new Map([[x.symbolId,av],[y.symbolId,bv]]));
        assert.equal(actual.status,E.EVAL_STATUS.VALUE);
        assert.equal(BigInt(actual.value),evaluateExpression(node,{a:av,b:bv}),`${bits}/${node.op}/${i}/${j}`);
      }
    }
  }
});

test('C4-04 budget, stale identity, cancellation and external rule/proof attempts withhold the whole candidate batch', async () => {
  const x = E.createFreshSymbol(E.bvSort(4),'x'), before = E.createBinary('xor',x,x);
  for (const overrides of [{limits:{workItems:0}},{limits:{candidates:0}},{timeoutMs:0},
    {isCancelled:() => true},{getCurrentIdentity:() => ({...identity,snapshotId:'stale'})},
    {rules:DEFAULT_RULES},{proof:{}},{memoryObservables:[{}]},
    {correspondence:{inputs:[{before:'x',after:'y'}]}},{valueId:''}]) {
    const r = await query(before,[x],overrides);
    assert.equal(r.status,'partial');
    assert.deepEqual(r.candidates,[]);
    assert.equal(r.ruleCoverage.rows.length,64);
    assert.ok(r.ruleCoverage.rows.every(row => row.disposition === 'unknown' && row.candidateApplications === 0));
  }
  const unsupported = await query(E.createBinary('udiv',x,x),[x]);
  assert.equal(unsupported.status,'partial');
  assert.equal(unsupported.reason,'unsupported-representation-source');
});

test('C4-04 translation-only analysis retains real input ownership without fabricated candidate queries', async () => {
  const f = proofFixture(4);
  const r = await querySymbolicAnalysis(f.ir,{...f.options,models,candidateStrategy:'translate-only'});
  assert.equal(r.status,'complete',r.reason);
  assert.equal(r.metrics.candidateQueries,0);
  assert.deepEqual(r.targets[0].candidates,[]);
  assert.ok(Object.isFrozen(r.targets[0].candidates));
  assert.equal(isSymbolicAnalysisResult(r,identity),true);
  assert.equal(readSymbolicTargetInputs(r,f.target,identity).inputs[0].value,f.input);
  f.target.def.sub = 'or';
  assert.equal(isSymbolicAnalysisResult(r,identity),false);
});

function productionFixture() {
  const f = fixture('representation_production'); f.block(0);
  const a = f.opaque(8); a.index = 0; a.reg = 'x0';
  const target = f.binary('add',a,a,8); f.ret();
  const ir = f.build(); ir.instructions = ir.blocks.flatMap(block => [...block.phis,...block.insts]);
  ir.instructions.forEach((inst,index) => {inst.id=`inst_${index}`; inst.address=0x1000n+BigInt(index*4);});
  const ret = ir.instructions.at(-1); ret.args = [{value:target}];
  const result = enhanceSemanticDecompilation({semantic:true,ir,types:null,
    lines:[{kind:'stmt',indent:0,text:'return pending;',row:ret.row,addr:ret.address}],metrics:{},ctx:{}},null,
    {phase8PrepareProof:true,decompilerTimeBudgetMs:1000,returnType:'uint8_t'});
  return {ir,target,result,options:{identity,abiId:'generic-v1',memory:{addressBits:8},targets:[target],
    timeoutMs:1000,backendTier:'tiered',candidateStrategy:'representation-rules'}};
}

test('C4-04 actual producer, private plan, transaction and projection adopt the independently proved legacy-rule candidate', async () => {
  const f = productionFixture(), originalText = f.result.pseudocode;
  const canonical = structuredClone(f.ir), plan = await preparePhase8RewritePlan(f.ir,f.options);
  assert.equal(plan.status,'complete',plan.reason);
  const [entry] = plan.entries;
  assertGeneratorAudit(entry.generatorAudit,entry.queryHash);
  const context = {ir:f.ir,proofIdentity:identity,abiId:f.options.abiId,proofRewritePlan:plan};
  const stage = runPhase8Stage(context,{stages:['canonical-facts','rendering'],timeBudgetMs:1000});
  assert.equal(stage.ledger.published,true,stage.ledger.stopReason);
  assert.equal(readProvedRewrites(stage.analysis,context).entries[0].generatorAudit,entry.generatorAudit);
  const r = await optimizeSemanticDecompilation(f.result,f.options);
  assert.equal(r.proofOptimization.status,'complete',r.proofOptimization.reason);
  assert.equal(r.proofOptimization.adopted,1);
  assert.equal(r.proofOptimization.targetDecisions[0].disposition,'adopted');
  assert.equal(r.proofOptimization.targetDecisions[0].ruleCoverage.registered,64);
  assert.match(originalText,/\+/);
  assert.doesNotMatch(r.pseudocode,/\+/);
  assert.equal(r.ir,f.ir); assert.equal(f.target.def.sub,'add'); assert.equal(f.result.pseudocode,originalText);
  const transform = r.phase8Projection.transforms.find(row => row.queryHash === entry.queryHash);
  assert.deepEqual(transform.generatorAudit,entry.generatorAudit);
  assert.ok(r.renderProvenance.ledger.some(row => row.generatorAudit === transform.generatorAudit && row.producedRefs.length));
  const replay = await optimizeSemanticDecompilation(r,f.options);
  assert.equal(replay.proofOptimization.status,'complete',replay.proofOptimization.reason);
  assert.equal(replay.proofOptimization.adopted,0);
  assert.equal(replay.pseudocode,r.pseudocode);
  assert.ok(replay.renderProvenance.ledger.some(row => row.generatorAudit === transform.generatorAudit));
  assert.deepEqual(structuredClone(f.ir),canonical);
});

test('C4-04 representation audit publication is bounded and cannot be supplied by a caller', async () => {
  const x = E.createFreshSymbol(E.bvSort(4),'audit_x'), before = E.createBinary('xor',x,x);
  const fake = {strategy:'representation-rules',ruleTrace:['forged'],proofQueryHash:'forged'};
  const normal = await query(before,[x],{generatorAudit:fake});
  const audit = readRepresentationGeneratorAudit(normal.candidates[0]);
  assertGeneratorAudit(audit,normal.candidates[0].verification.evidence.queryHash);
  assert.ok(!audit.ruleTrace.includes('forged'));
  assert.throws(() => { audit.ruleTrace.push('forged'); },TypeError);
  assert.throws(() => { audit.ruleApplications['xor-self'] = 99; },TypeError);
  for (const options of [{limits:{allocationUnits:audit.resources.allocationUnits - 1}},
    {timeoutMs:0},{isCancelled:() => true}]) {
    const stopped = await query(before,[x],options);
    assert.equal(stopped.status,'partial');
    assert.deepEqual(stopped.candidates,[]);
    assert.equal(readRepresentationGeneratorAudit(stopped),null);
  }
});

test('C4-04 copied representation audits cannot manufacture plans or replace retained adopted history', async () => {
  const f = productionFixture(), plan = await preparePhase8RewritePlan(f.ir,f.options);
  assert.equal(plan.status,'complete',plan.reason);
  const forged = {...plan,entries:plan.entries.map(entry => ({...entry,generatorAudit:{...entry.generatorAudit,proofQueryHash:'forged'}}))};
  const context = {ir:f.ir,proofIdentity:identity,abiId:f.options.abiId,proofRewritePlan:forged};
  assert.equal(isPhase8RewritePlan(forged,context),false);
  assert.equal(runPhase8Stage(context,{stages:['canonical-facts','rendering'],timeBudgetMs:1000}).ledger.published,false);
  const result = await optimizeSemanticDecompilation(f.result,f.options);
  assert.equal(result.proofOptimization.adopted,1);
  const edited = {...result,phase8Projection:{...result.phase8Projection,
    transforms:result.phase8Projection.transforms.map(row => ({...row,generatorAudit:forged.entries[0].generatorAudit}))}};
  const replay = await optimizeSemanticDecompilation(edited,f.options);
  // The copied history loses the private idempotence binding. A new, genuine
  // scalar proof may be applied again; the edited receipt authorizes nothing.
  assert.equal(replay.proofOptimization.status,'complete',replay.proofOptimization.reason);
  assert.equal(replay.proofOptimization.adopted,1);
  assertGeneratorAudit(replay.phase8Projection.transforms[0].generatorAudit,plan.entries[0].queryHash);
  assert.equal(replay.pseudocode,result.pseudocode);
  assert.equal(replay.phase8Projection.history.completeness,'incomplete');
  assert.ok(replay.renderProvenance.ledger.every(row => row.generatorAudit?.proofQueryHash !== 'forged'));
  for (const options of [{phase8WorkBudget:0},{timeoutMs:0},{isCancelled:() => true}]) {
    const stopped = await optimizeSemanticDecompilation(f.result,{...f.options,...options});
    assert.equal(stopped.proofOptimization.adopted,0);
    assert.ok(!(stopped.phase8Projection?.transforms ?? []).some(row => row.generatorAudit));
  }
});

test('C4-04 adopted representation audit survives public navigation without becoming proof authority', async () => {
  const f = productionFixture(), result = await optimizeSemanticDecompilation(f.result,f.options);
  assert.equal(result.proofOptimization.adopted,1);
  const original = result.phase8Projection.transforms[0].generatorAudit;
  let epoch = 1;
  const value = {pseudocode:result.pseudocode,lines:result.lines,renderProvenance:result.renderProvenance};
  const api = new AnalysisQueryAPI({
    currentIdentity:async () => ({binaryId:'representation-audit',projectRevision:1,analysisEpoch:epoch,artifactVersions:{}}),
    decompile:async () => ({value,status:{completeness:'complete'}}),
  });
  const snapshot = await api.snapshot(), response = await api.decompile(snapshot,'function');
  const navigation = createDecompilerNavigation(response,{currentSnapshot:() => api.snapshot()});
  const selected = await navigation.selectOrigin('addr',f.target.def.address);
  assert.equal(selected.state,'ready');
  const record = selected.transforms.find(row => row.queryHash === original.proofQueryHash);
  assert.deepEqual(record.generatorAudit,original);
  assert.equal(readRepresentationGeneratorAudit(record),null);
  assert.equal(isAdoptableCandidate(record.generatorAudit,{identity}),false);
  epoch++;
  assert.equal((await navigation.selectOrigin('addr',f.target.def.address)).reason,'stale-query-snapshot');
});

test('C4-04 representation coverage cannot copy plan authority or publish after an exhausted transaction', async () => {
  const f = productionFixture(), plan = await preparePhase8RewritePlan(f.ir,f.options);
  assert.equal(plan.status,'complete',plan.reason);
  assert.equal(plan.candidateStrategy,'representation-rules');
  const scope = {ir:f.ir,proofIdentity:identity,abiId:f.options.abiId};
  assert.equal(isPhase8RewritePlan(plan,scope),true);
  assert.equal(isPhase8RewritePlan({...plan},scope),false);
  const r = await optimizeSemanticDecompilation(f.result,{...f.options,phase8WorkBudget:0});
  assert.equal(r.proofOptimization.status,'partial');
  assert.equal(r.proofOptimization.adopted,0);
  assert.equal(r.pseudocode,f.result.pseudocode);
  f.target.def.sub = 'or';
  assert.equal(isPhase8RewritePlan(plan,scope),false);
});

test('C4-04 the public machine entry separates proved no-op projection from unsupported instruction refusal', async () => {
  const base = 0x1000n, rowOfAddress = address => Number((address - base) / 4n);
  const model = mn => buildSemanticModel([
    {row:0,address:base,mn,ops:'x0, x0, x0'},
    {row:1,address:base + 4n,mn:'ret',ops:''},
  ],{startRow:0,endRow:1,rowOfAddress});
  const opts = {addr:base,name:'machine_example',rowOfAddress,beginner:false,returnType:'uint64',decompilerTimeBudgetMs:5000};
  const proofOpts = {identity:{...identity,architecture:'arm64'},abiId:'aapcs64',candidateStrategy:'representation-rules',timeoutMs:1000};
  const result = await decompileWithProof(model('eor'),opts,proofOpts);
  assert.equal(result.proofOptimization.status,'complete',result.proofOptimization.reason);
  assert.ok(result.phase8.transformCount > 0, 'real proved transaction, not a helper-only query');
  assert.equal(result.proofOptimization.adopted,0,'the ordinary renderer already emitted this constant');
  assert.ok(result.proofOptimization.targetDecisions.some(row => row.ruleCoverage?.rows.some(
    rule => rule.name === 'xor-self' && rule.disposition === 'proved-candidate')));
  assert.ok(result.ir.instructions.some(inst => inst.op === 'bin' && inst.sub === 'xor'));
  assert.match(result.pseudocode,/return 0;/);

  // Current ADD lifting also emits BFX/is-zero auxiliaries outside the executor
  // profile. Preserve this explicit unsupported cell; do not remove instructions
  // or fabricate execution evidence to force a proof through the new generator.
  const unsupported = await decompileWithProof(model('add'),opts,proofOpts);
  assert.equal(unsupported.proofOptimization.status,'partial');
  assert.equal(unsupported.proofOptimization.reason,'unsupported-instruction');
  assert.equal(unsupported.proofOptimization.adopted,0);
  assert.ok(unsupported.ir.instructions.some(inst => inst.op === 'bfx'));
  assert.match(unsupported.pseudocode,/\+/);
});
