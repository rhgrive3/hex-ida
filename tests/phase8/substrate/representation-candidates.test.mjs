import assert from 'node:assert/strict';
import test from 'node:test';
import * as E from '../../../js/symbolic/expr/index.js';
import { querySymbolicAnalysis, isSymbolicAnalysisResult, readSymbolicTargetInputs } from '../../../js/symbolic/query/analysis.js';
import { createTaintModels } from '../../../js/symbolic/taint/models.js';
import { isAdoptableCandidate } from '../../../js/symbolic/taint/proof-consumer.js';
import { compileRepresentationProposal, queryRepresentationCandidates, REPRESENTATION_RULES, REPRESENTATION_IDIOMS,
  REPRESENTATION_CANDIDATE_VERSION, REPRESENTATION_REWRITE_LIMITS, readRepresentationGeneratorAudit } from '../../../js/decompiler/phase8/representation-candidates.js';
import { DEFAULT_RULES } from '../../../js/decompiler/rewrite/rules.js';
import { expr } from '../../../js/decompiler/ast/nodes.js';
import { evaluateExpression } from '../../../js/decompiler/verify/equivalence.js';
import { preparePhase8RewritePlan, isPhase8RewritePlan, readProvedRewrites } from '../../../js/decompiler/phase8/pass-validation.js';
import { enhanceSemanticDecompilation, optimizeSemanticDecompilation, readProducerInputExpressions } from '../../../js/decompiler/pipeline.js';
import { proofFixture, identity } from '../helpers/proof-fixtures.mjs';
import { fixture } from '../helpers/ir-fixtures.mjs';
import { buildSemanticModel } from '../../../js/blocks.js';
import { decompile, decompileWithProof } from '../../../js/decompile.js';
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

test('C4-04 the public machine entry defers ordinary simplification until proof and keeps unsupported instruction refusal', async () => {
  const base = 0x1000n, rowOfAddress = address => Number((address - base) / 4n);
  const model = mn => buildSemanticModel([
    {row:0,address:base,mn,ops:'x0, x0, x0'},
    {row:1,address:base + 4n,mn:'ret',ops:''},
  ],{startRow:0,endRow:1,rowOfAddress});
  const opts = {addr:base,name:'machine_example',rowOfAddress,beginner:false,returnType:'uint64',decompilerTimeBudgetMs:5000};
  const proofOpts = {identity:{...identity,architecture:'arm64'},abiId:'aapcs64',candidateStrategy:'representation-rules',timeoutMs:1000};
  const ordinary = decompile(model('eor'),opts);
  assert.match(ordinary.pseudocode,/return 0;/);
  const withheld = await decompileWithProof(model('eor'),{...opts,phase8ProofOnlyRewrites:false},
    {...proofOpts,timeoutMs:0,requireProofOnlyRewrites:false});
  assert.equal(withheld.proofOptimization.status,'partial');
  assert.equal(withheld.proofOptimization.rewritePolicy,'deferred-optional-scalar-rewrites');
  assert.equal(withheld.proofOptimization.adopted,0);
  assert.match(withheld.pseudocode,/\^/,'uncertain proof does not inherit the ordinary xor-self simplification');
  assert.ok(!withheld.rewriteProof.some(row => row.rule === 'xor-self'));
  const result = await decompileWithProof(model('eor'),opts,proofOpts);
  assert.equal(result.proofOptimization.status,'complete',result.proofOptimization.reason);
  assert.ok(result.phase8.transformCount > 0, 'real proved transaction, not a helper-only query');
  assert.equal(result.proofOptimization.adopted,2,'the two scalar values are now projected only after proof');
  assert.equal(result.proofOptimization.rewritePolicy,'deferred-optional-scalar-rewrites');
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

// This extends candidate mining through the existing recognizer. The 64 actual
// RewriteEngine rules retain their separate registry and application accounting.
// Idiom observations describe a proposed normalization, never proof authority.
function signMaskExpression(bits, { logical = false, wrongCount = false, independent = false } = {}) {
  const input = E.createFreshSymbol(E.bvSort(bits),'sign_mask_input');
  const other = independent ? E.createFreshSymbol(E.bvSort(bits),'sign_mask_input') : input;
  const count = E.createBv(bits,BigInt(bits - (wrongCount ? 2 : 1)));
  const shifted = E.createBinary(logical ? 'lshr' : 'ashr',other,count);
  return { input, symbols:independent ? [input,other] : [input],
    before:E.createBinary('and',input,E.createUnary('not',shifted)) };
}

function assertIdiomAudit(audit, queryHash, idiom = 'recognize-max') {
  assert.ok(audit,'the real recognizer-only candidate must retain its generator observation');
  assert.equal(audit.strategy,'representation-rules');
  assert.equal(audit.schemaVersion,'hex-phase8-generator-audit/v1');
  assert.equal(audit.rulesetVersion,REPRESENTATION_CANDIDATE_VERSION);
  assert.equal(audit.proofQueryHash,queryHash);
  assert.deepEqual(audit.ruleTrace,[],'recognizer work is not a fabricated DEFAULT_RULES application');
  assert.deepEqual(audit.appliedRules,[]);
  assert.deepEqual(audit.ruleApplications,{});
  assert.deepEqual(audit.idiomTrace,[idiom]);
  assert.deepEqual(audit.idiomApplications,{[idiom]:1});
  assert.equal(audit.rewriteResources.applications,audit.ruleTrace.length + audit.idiomTrace.length);
  for (const item of [audit,audit.idiomTrace,audit.idiomApplications]) assert.ok(Object.isFrozen(item));
  assert.equal(readRepresentationGeneratorAudit({...audit}),null);
  assert.equal(isAdoptableCandidate(audit,{identity}),false);
  assert.equal(isPhase8RewritePlan(audit),false);
  assert.deepEqual(JSON.parse(JSON.stringify(audit)),audit);
}

for (const bits of [4,8]) test(`C4-04 recognizer-only sign-mask BV${bits} reaches independent candidate proof`, async () => {
  const f = signMaskExpression(bits), r = await query(f.before,f.symbols);
  assert.equal(r.status,'complete',r.reason);
  // Keep this assertion before new audit fields: the current producer stops at
  // zero candidates because no DEFAULT_RULES entry recognizes this sign mask.
  assert.equal(r.candidates.length,1,`BV${bits}: an observed recognizer-only change must become a candidate`);
  assert.equal(r.ruleCoverage.registered,64);
  assert.deepEqual(REPRESENTATION_RULES,DEFAULT_RULES.map(({name,phase}) => ({name,phase})));
  assert.ok(r.ruleCoverage.rows.every(row => row.candidateApplications === 0 && row.disposition === 'not-selected'));
  const idiom = r.idiomCoverage.rows.find(row => row.name === 'recognize-max');
  assert.ok(idiom); assert.equal(idiom.candidateApplications,1);
  assert.equal(idiom.disposition,'proved-candidate');
  const candidate = r.candidates[0], audit = readRepresentationGeneratorAudit(candidate);
  assert.equal(candidate.before,f.before);
  assert.equal(candidate.after.sort.width,bits,'the actual target retains its complete width');
  assert.notEqual(E.computeStructuralHash(candidate.after),E.computeStructuralHash(f.before));
  assert.equal(candidate.eligible,true,candidate.verification.reason);
  assert.equal(isAdoptableCandidate(candidate.verification,{identity}),true);
  assertIdiomAudit(audit,candidate.verification.evidence.queryHash);
  assert.equal(audit.candidateId,candidate.candidateId);
  assert.equal(readRepresentationGeneratorAudit({...candidate}),null);
  for (let i=0;i<2**bits;i++) {
    const value = BigInt(i), expected = BigInt.asIntN(bits,value) < 0n ? 0n : value;
    const environment = new Map([[f.input.symbolId,value]]);
    const before = E.evaluateExpr(f.before,environment), after = E.evaluateExpr(candidate.after,environment);
    assert.equal(before.status,E.EVAL_STATUS.VALUE); assert.equal(after.status,E.EVAL_STATUS.VALUE);
    assert.equal(before.value,expected,`BV${bits}: canonical before ${value}`);
    assert.equal(after.value,expected,`BV${bits}: canonical proposal ${value}`);
  }
});

test('C4-04 idiom and ordinary rules retain separate phases, traces and one shared budget', async () => {
  assert.ok(REPRESENTATION_IDIOMS.every(idiom => !DEFAULT_RULES.some(rule => rule.phase === idiom.phase)));
  assert.ok(Object.isFrozen(REPRESENTATION_IDIOMS) && REPRESENTATION_IDIOMS.every(Object.isFrozen));
  const input = E.createFreshSymbol(E.bvSort(4),'mixed_idiom');
  const doubled = E.createBinary('add',input,input);
  const before = E.createBinary('and',doubled,E.createUnary('not',E.createBinary('ashr',doubled,E.createBv(4,3n))));
  const r = await query(before,[input]);
  assert.equal(r.status,'complete',r.reason);
  assert.equal(r.candidates.length,1);
  const candidate = r.candidates[0], audit = readRepresentationGeneratorAudit(candidate);
  assert.equal(candidate.eligible,true,candidate.verification.reason);
  assert.equal(isAdoptableCandidate(candidate.verification,{identity}),true);
  assert.deepEqual(audit.idiomTrace,['recognize-max']);
  assert.deepEqual(audit.idiomApplications,{'recognize-max':1});
  assert.deepEqual(audit.ruleTrace,['double-term','strength-mul-power-two']);
  assert.equal(audit.rewriteResources.applications,audit.ruleTrace.length + audit.idiomTrace.length);
  assert.ok(audit.rewriteResources.applications <= audit.rewriteLimits.maxApplications);
  assert.equal(r.ruleCoverage.registered,64);
  assert.equal(r.idiomCoverage.registered,REPRESENTATION_IDIOMS.length);
  for (const [coverage,applications] of [[r.ruleCoverage,audit.ruleApplications],[r.idiomCoverage,audit.idiomApplications]]) {
    for (const row of coverage.rows) assert.equal(row.candidateApplications,applications[row.name] ?? 0);
  }
  assert.deepEqual(audit.appliedRules,candidate.rules);
  assert.deepEqual(candidate.idioms,['recognize-max']);
  for (const [key,limit] of Object.entries(audit.limits)) assert.ok(audit.resources[key] <= limit);
  for (let i=0;i<16;i++) {
    const environment = new Map([[input.symbolId,BigInt(i)]]);
    const original = E.evaluateExpr(before,environment), proposed = E.evaluateExpr(candidate.after,environment);
    const doubledValue = BigInt.asUintN(4,BigInt(i)*2n);
    const expected = BigInt.asIntN(4,doubledValue) < 0n ? 0n : doubledValue;
    assert.equal(original.status,E.EVAL_STATUS.VALUE); assert.equal(original.value,expected);
    assert.equal(proposed.status,E.EVAL_STATUS.VALUE); assert.equal(proposed.value,expected);
  }
});

test('C4-04 sign-mask recognition does not invent proposals for wrong operators, counts or independent inputs', async () => {
  for (const bits of [4,8]) for (const options of [{logical:true},{wrongCount:true},{independent:true}]) {
    const f = signMaskExpression(bits,options), r = await query(f.before,f.symbols);
    assert.equal(r.status,'complete',`${bits}/${JSON.stringify(options)}:${r.reason}`);
    assert.deepEqual(r.candidates,[]);
    assert.equal(r.ruleCoverage.registered,64);
    assert.ok(r.ruleCoverage.rows.every(row => row.candidateApplications === 0));
    assert.ok(r.idiomCoverage.rows.every(row => row.candidateApplications === 0 && row.disposition === 'not-selected'));
  }
});

test('C4-04 recognizer-only candidate requests preserve unknown and reject copied observation authority', async () => {
  const f = signMaskExpression(4);
  for (const overrides of [{limits:{workItems:0}},{limits:{candidates:0}},{timeoutMs:0},
    {isCancelled:() => true},{getCurrentIdentity:() => ({...identity,snapshotId:'stale-idiom'})}]) {
    const r = await query(f.before,f.symbols,overrides);
    assert.equal(r.status,'partial');
    assert.deepEqual(r.candidates,[]);
    assert.equal(readRepresentationGeneratorAudit(r),null);
    assert.equal(r.ruleCoverage.registered,64);
    assert.ok(r.ruleCoverage.rows.every(row => row.disposition === 'unknown' && row.candidateApplications === 0));
    assert.ok(r.idiomCoverage.rows.every(row => row.disposition === 'unknown' && row.candidateApplications === 0));
  }
  const fake = {strategy:'representation-rules',idiomTrace:['recognize-forged'],
    idiomApplications:{'recognize-forged':1},proofQueryHash:'forged'};
  const r = await query(f.before,f.symbols,{generatorAudit:fake});
  assert.equal(r.status,'complete',r.reason); assert.equal(r.candidates.length,1);
  const audit = readRepresentationGeneratorAudit(r.candidates[0]);
  assertIdiomAudit(audit,r.candidates[0].verification.evidence.queryHash);
  assert.notEqual(audit,fake);
  assert.throws(() => { audit.idiomTrace.push('recognize-forged'); },TypeError);
  assert.throws(() => { audit.idiomApplications['recognize-max'] = 2; },TypeError);
});

// The same canonical sign-mask shape as provenance/idiom-history.test.mjs,
// passed through the actual wrapper that privately issues proof-only producers.
// BV4 and BV8 are genuine generic targets, not reduced-width ARM64 stand-ins.
function signMaskProductionFixture(bits, { defer = true } = {}) {
  const f = fixture(`recognizer_sign_mask_${bits}`); f.block(0);
  const input = f.opaque(bits); input.index = 0; input.reg = 'x0'; input.signed = true;
  const shifted = f.binary('ashr',input,f.constant(BigInt(bits - 1),bits),bits);
  const target = f.binary('and',input,f.unary('not',shifted,bits),bits); f.ret();
  const ir = f.build(); ir.instructions = ir.blocks.flatMap(block => [...block.phis,...block.insts]);
  ir.instructions.forEach((inst,index) => {inst.id=`idiom_${index}`; inst.address=0x1000n+BigInt(index*4);});
  const ret = ir.instructions.at(-1); ret.args = [{value:target}]; target.uses.push(ret);
  const canonical = structuredClone(ir);
  const result = enhanceSemanticDecompilation({semantic:true,ir,types:null,
    lines:[{kind:'stmt',indent:0,text:'return pending;',row:ret.row,addr:ret.address}],metrics:{},ctx:{}},null,
    {phase8PrepareProof:true,phase8ProofOnlyRewrites:defer,deterministicTransforms:true,decompilerTimeBudgetMs:1000});
  return {ir,input,target,result,canonical,options:{identity,abiId:'generic-v1',memory:{addressBits:8},targets:[target],
    timeoutMs:1000,backendTier:'tiered',candidateStrategy:'representation-rules',requireProofOnlyRewrites:true}};
}

for (const bits of [4,8]) test(`C4-04 sign-mask BV${bits} adopts only through the real prepared producer and proof transaction`, async () => {
  const ordinary = signMaskProductionFixture(bits,{defer:false}), f = signMaskProductionFixture(bits);
  assert.ok(ordinary.result.rewriteProof.some(row => row.rule === 'recognize-max'));
  assert.ok(!f.result.rewriteProof.some(row => row.rule === 'recognize-max'));
  assert.equal(f.result.rewriteStats.deferred,'phase8-proof-projection');
  const originalText = f.result.pseudocode, originalAst = f.result.cAst;
  const original = f.result.semanticAst.values.find(row => row.valueId === f.target.id).expression;
  const translated = await querySymbolicAnalysis(f.ir,{...f.options,models,candidateStrategy:'translate-only'});
  assert.equal(translated.status,'complete',translated.reason);
  const binding = readSymbolicTargetInputs(translated,f.target,identity);
  assert.ok(binding); assert.equal(binding.inputs.length,1);
  assert.equal(binding.inputs[0].value,f.input);
  assert.equal(binding.expression.sort.width,bits);
  const inputs = readProducerInputExpressions(f.result,[f.input]);
  assert.ok(inputs); assert.equal(inputs[0].expression.bits,bits);
  const inputName = inputs[0].expression.name;
  const r = await optimizeSemanticDecompilation(f.result,f.options);
  assert.equal(r.proofOptimization.status,'complete',r.proofOptimization.reason);
  assert.equal(r.proofOptimization.adopted,1);
  assert.equal(r.proofOptimization.rewritePolicy,'deferred-optional-scalar-rewrites');
  const [decision] = r.proofOptimization.targetDecisions;
  assert.equal(decision.disposition,'adopted'); assert.equal(decision.candidateCount,1);
  assert.equal(decision.ruleCoverage.registered,64);
  const transform = r.phase8Projection.transforms.find(row => row.valueId === decision.valueId && row.queryHash === decision.queryHash);
  assert.ok(transform,'the eligible proposal must reach the real committed and rendered transform');
  assert.equal(transform.kind,'solver-scalar');
  assert.notEqual(transform.beforeHash,transform.afterHash);
  assertIdiomAudit(transform.generatorAudit,decision.queryHash);
  assert.ok(r.renderProvenance.ledger.some(row => row.generatorAudit === transform.generatorAudit && row.producedRefs.length));
  const after = r.semanticAst.values.find(row => row.valueId === f.target.id).expression;
  assert.equal(after.bits,bits); assert.notEqual(after,original);
  assert.notEqual(r.pseudocode,originalText);
  // The existing safe recipe may print an ITE. Literal legacy max(...) text is
  // not evidence of equivalence and is not required for this scalar adoption.
  for (let i=0;i<2**bits;i++) {
    const value = BigInt(i), expected = BigInt.asIntN(bits,value) < 0n ? 0n : value;
    const before = E.evaluateExpr(binding.expression,new Map([[binding.inputs[0].symbol.symbolId,value]]));
    assert.equal(before.status,E.EVAL_STATUS.VALUE);
    assert.equal(before.value,expected,`BV${bits}: actual translated before ${value}`);
    assert.equal(evaluateExpression(after,{[inputName]:value}),expected,`BV${bits}: actually adopted output ${value}`);
  }
  assert.equal(f.result.cAst,originalAst); assert.equal(f.result.pseudocode,originalText);
  assert.equal(f.result.semanticAst.values.find(row => row.valueId === f.target.id).expression,original);
  assert.deepEqual(structuredClone(f.ir),f.canonical);
  const replay = await optimizeSemanticDecompilation(r,f.options);
  assert.equal(replay.proofOptimization.status,'complete',replay.proofOptimization.reason);
  assert.equal(replay.proofOptimization.adopted,0); assert.equal(replay.pseudocode,r.pseudocode);
  assert.ok(replay.renderProvenance.ledger.some(row => row.generatorAudit === transform.generatorAudit));
});

test('C4-04 unknown, exhausted and stale sign-mask requests retain the exact prepared production output', async () => {
  for (const options of [{timeoutMs:0},{phase8WorkBudget:0},{isCancelled:() => true}]) {
    const f = signMaskProductionFixture(4), r = await optimizeSemanticDecompilation(f.result,{...f.options,...options});
    assert.equal(r.proofOptimization.status,'partial'); assert.equal(r.proofOptimization.adopted,0);
    assert.equal(r.cAst,f.result.cAst); assert.equal(r.semanticAst,f.result.semanticAst);
    assert.equal(r.pseudocode,f.result.pseudocode);
    assert.ok(!(r.phase8Projection?.transforms ?? []).some(row => ['solver-constant','solver-scalar'].includes(row.kind)));
    assert.deepEqual(structuredClone(f.ir),f.canonical);
  }
  const f = signMaskProductionFixture(4); f.target.def.sub = 'or';
  const r = await optimizeSemanticDecompilation(f.result,f.options);
  assert.equal(r.proofOptimization.status,'partial'); assert.equal(r.proofOptimization.adopted,0);
  assert.equal(r.proofOptimization.reason,'unissued-or-stale-projection');
  assert.equal(r.cAst,f.result.cAst); assert.equal(r.pseudocode,f.result.pseudocode);
});

// Genuine generic targets; the smaller extraction field is an explicit
// intermediate operation, never a narrowed substitute for the target's proof.
function shiftMaskShape(bits) {
  const offset = bits === 4 ? 1 : 2, fieldWidth = bits === 4 ? 2 : 3;
  return {offset,fieldWidth,mask:(1n << BigInt(fieldWidth)) - 1n};
}
function shiftMaskExpression(bits, { operator = 'lshr', offset, mask, variableOffset = false } = {}) {
  const shape = shiftMaskShape(bits), input = E.createFreshSymbol(E.bvSort(bits),'field_input');
  const count = variableOffset ? E.createFreshSymbol(E.bvSort(bits),'field_offset')
    : E.createBv(bits,BigInt(offset ?? shape.offset));
  const selectedMask = mask ?? shape.mask;
  return {input,offset:offset ?? shape.offset,mask:selectedMask,symbols:variableOffset ? [input,count] : [input],
    before:E.createBinary('and',E.createBinary(operator,input,count),E.createBv(bits,selectedMask))};
}

for (const bits of [4,8]) test(`C4-04 shift-mask BV${bits} independent candidate preserves the complete target width`, async () => {
  const f = shiftMaskExpression(bits), r = await query(f.before,f.symbols);
  assert.equal(r.status,'complete',r.reason);
  // Baseline v4 has no matching ordinary rule and declines bit_extract idioms.
  // Keep the expected zero-to-one behavioral failure ahead of new audit checks.
  assert.equal(r.candidates.length,1,`BV${bits}: a valid shift-mask recognizer result must become a candidate`);
  assert.deepEqual(REPRESENTATION_IDIOMS.map(row => row.name).sort(),['recognize-bit_extract','recognize-max']);
  assert.equal(r.ruleCoverage.registered,64);
  assert.ok(r.ruleCoverage.rows.every(row => row.candidateApplications === 0));
  const [candidate] = r.candidates, audit = readRepresentationGeneratorAudit(candidate);
  assert.equal(candidate.before,f.before); assert.equal(candidate.after.sort.width,bits);
  assert.notEqual(E.computeStructuralHash(candidate.after),E.computeStructuralHash(f.before));
  assert.equal(candidate.eligible,true,candidate.verification.reason);
  assert.equal(isAdoptableCandidate(candidate.verification,{identity}),true);
  assert.deepEqual(candidate.idioms,['recognize-bit_extract']);
  assertIdiomAudit(audit,candidate.verification.evidence.queryHash,'recognize-bit_extract');
  assert.equal(audit.candidateId,candidate.candidateId);
  const row = r.idiomCoverage.rows.find(row => row.name === 'recognize-bit_extract');
  assert.equal(row.candidateApplications,1); assert.equal(row.disposition,'proved-candidate');
  assert.equal(readRepresentationGeneratorAudit({...candidate}),null);
  for (let i=0;i<2**bits;i++) {
    const value = BigInt(i), expected = (value >> BigInt(f.offset)) & f.mask;
    const environment = new Map([[f.input.symbolId,value]]);
    for (const [label,expression] of [['before',f.before],['after',candidate.after]]) {
      const actual = E.evaluateExpr(expression,environment);
      assert.equal(actual.status,E.EVAL_STATUS.VALUE);
      assert.equal(actual.value,expected,`BV${bits}: ${label} ${value}`);
    }
  }
});

test('C4-04 shift-mask extraction bounds preserve existing zero and full-mask rule candidates', async () => {
  for (const bits of [4,8]) {
    for (const [mask,rule] of [[0n,'and-zero-right'],[(1n << BigInt(bits)) - 1n,'and-full-mask']]) {
      const f = shiftMaskExpression(bits,{mask}), r = await query(f.before,f.symbols);
      assert.equal(r.status,'complete',`${bits}/${rule}:${r.reason}`);
      assert.equal(r.candidates.length,1,'an unrepresentable extraction must not suppress the existing ordinary rule');
      const [candidate] = r.candidates, audit = readRepresentationGeneratorAudit(candidate);
      assert.equal(candidate.eligible,true,candidate.verification.reason);
      assertGeneratorAudit(audit,candidate.verification.evidence.queryHash);
      assert.deepEqual(audit.ruleTrace,[rule]); assert.deepEqual(audit.idiomTrace,[]);
      assert.deepEqual(candidate.idioms,[]); assert.equal(candidate.after.sort.width,bits);
      for (let i=0;i<2**bits;i++) {
        const value = BigInt(i), actual = E.evaluateExpr(candidate.after,new Map([[f.input.symbolId,value]]));
        assert.equal(actual.status,E.EVAL_STATUS.VALUE);
        assert.equal(actual.value,(value >> BigInt(f.offset)) & mask);
      }
    }
    // Both source expressions are legal BV. Their apparent extraction would
    // cross or start beyond the input width, so leave the recognizer unselected.
    for (const offset of [bits - 1,bits]) {
      const f = shiftMaskExpression(bits,{offset}), r = await query(f.before,f.symbols);
      assert.equal(r.status,'complete',`${bits}/${offset}:${r.reason}`);
      assert.deepEqual(r.candidates,[]);
      assert.ok(r.idiomCoverage.rows.every(row => row.candidateApplications === 0));
    }
  }
});

test('C4-04 shift-mask nonmatches and unknown candidate requests cannot issue extraction proof', async () => {
  for (const options of [{operator:'shl'},{mask:5n},{variableOffset:true}]) {
    const f = shiftMaskExpression(8,options), r = await query(f.before,f.symbols);
    assert.equal(r.status,'complete',r.reason); assert.deepEqual(r.candidates,[]);
    assert.ok(r.idiomCoverage.rows.every(row => row.candidateApplications === 0));
  }
  const f = shiftMaskExpression(4);
  for (const options of [{limits:{candidates:0}},{timeoutMs:0},{isCancelled:() => true}]) {
    const r = await query(f.before,f.symbols,options);
    assert.equal(r.status,'partial'); assert.deepEqual(r.candidates,[]);
    assert.equal(readRepresentationGeneratorAudit(r),null);
    assert.ok(r.idiomCoverage.rows.every(row => row.disposition === 'unknown' && row.candidateApplications === 0));
  }
});

test('C4-04 nested shift-mask proposals compose through existing ordinary rules and one proof', async () => {
  const input = E.createFreshSymbol(E.bvSort(8),'nested_field');
  const inner = E.createBinary('and',E.createBinary('lshr',input,E.createBv(8,1n)),E.createBv(8,15n));
  const outer = E.createBinary('and',E.createBinary('lshr',inner,E.createBv(8,1n)),E.createBv(8,3n));
  const before = E.createBinary('xor',outer,E.createBv(8,0n)), r = await query(before,[input]);
  assert.equal(r.status,'complete',r.reason); assert.equal(r.candidates.length,1);
  const [candidate] = r.candidates, audit = readRepresentationGeneratorAudit(candidate);
  assert.equal(candidate.eligible,true,candidate.verification.reason); assert.equal(candidate.after.sort.width,8);
  assert.equal(isAdoptableCandidate(candidate.verification,{identity}),true);
  assert.deepEqual(audit.idiomTrace,['recognize-bit_extract','recognize-bit_extract']);
  assert.deepEqual(audit.idiomApplications,{'recognize-bit_extract':2});
  // Width-restoring extensions separate the slices, so direct nested-extract
  // collapse is intentionally inapplicable. Record only the observed rule.
  assert.deepEqual(audit.ruleTrace,['xor-zero-right']);
  assert.deepEqual(audit.ruleApplications,{'xor-zero-right':1});
  assert.equal(audit.rewriteResources.applications,audit.idiomTrace.length + audit.ruleTrace.length);
  assert.equal(audit.proofQueryHash,candidate.verification.evidence.queryHash);
  assert.ok(audit.rewriteResources.applications <= audit.rewriteLimits.maxApplications);
  for (let i=0;i<256;i++) {
    const environment = new Map([[input.symbolId,BigInt(i)]]), expected = (BigInt(i) >> 2n) & 3n;
    for (const expression of [before,candidate.after]) {
      const actual = E.evaluateExpr(expression,environment);
      assert.equal(actual.status,E.EVAL_STATUS.VALUE); assert.equal(actual.value,expected);
    }
  }
});

test('C4-04 shift-mask comparison consumers preserve the original operand domain', async () => {
  const f = shiftMaskExpression(4), y = E.createFreshSymbol(E.bvSort(4),'comparison_input');
  const right = E.createBinary('add',y,y);
  for (const op of ['eq','slt','ult']) {
    const before = E.createCompare(op,f.before,right), r = await query(before,[f.input,y]);
    assert.equal(r.status,'complete',`${op}: ${r.reason}`);
    assert.equal(r.candidates.length,1,'an inner idiom must not suppress an existing ordinary-rule proposal');
    const [candidate] = r.candidates;
    assert.equal(candidate.eligible,true,`${op}: ${candidate.verification.reason}`);
    assert.equal(isAdoptableCandidate(candidate.verification,{identity}),true);
    assert.deepEqual(candidate.after.sort,before.sort);
    for (let x=0;x<16;x++) for (let v=0;v<16;v++) {
      const environment = new Map([[f.input.symbolId,BigInt(x)],[y.symbolId,BigInt(v)]]);
      const original = E.evaluateExpr(before,environment), proposed = E.evaluateExpr(candidate.after,environment);
      assert.equal(original.status,E.EVAL_STATUS.VALUE); assert.equal(proposed.status,E.EVAL_STATUS.VALUE);
      assert.equal(proposed.value,original.value,`${op}: ${x}/${v}`);
    }
  }
});

test('C4-04 shift-mask sign extension observes the original value width', async () => {
  const f = shiftMaskExpression(4);
  const before = E.createBinary('xor',E.createCast('sext',f.before,8),E.createBv(8,0n));
  const r = await query(before,f.symbols);
  assert.equal(r.status,'complete',r.reason); assert.equal(r.candidates.length,1);
  const [candidate] = r.candidates;
  assert.equal(candidate.eligible,true,candidate.verification.reason);
  assert.equal(isAdoptableCandidate(candidate.verification,{identity}),true);
  assert.equal(candidate.after.sort.width,8);
  for (let x=0;x<16;x++) {
    const environment = new Map([[f.input.symbolId,BigInt(x)]]), expected = (BigInt(x) >> 1n) & 3n;
    for (const expression of [before,candidate.after]) {
      const actual = E.evaluateExpr(expression,environment);
      assert.equal(actual.status,E.EVAL_STATUS.VALUE); assert.equal(actual.value,expected);
    }
  }
});

// Reuse the actual generic IR fixture and producer/private-input APIs, as in the
// sign-mask integration case. Only the expression shape differs from that case.
function shiftMaskProductionFixture(bits, { defer = true } = {}) {
  const f = fixture(`recognizer_shift_mask_${bits}`); f.block(0);
  const input = f.opaque(bits); input.index = 0; input.reg = 'x0'; input.signed = false;
  const shape = shiftMaskShape(bits), count = f.constant(BigInt(shape.offset),bits);
  const shifted = f.binary('lshr',input,count,bits), target = f.binary('and',shifted,f.constant(shape.mask,bits),bits);
  f.ret(); const ir = f.build(); ir.instructions = ir.blocks.flatMap(block => [...block.phis,...block.insts]);
  ir.instructions.forEach((inst,index) => {inst.id=`shift_mask_${index}`; inst.address=0x2000n+BigInt(index*4);});
  const ret = ir.instructions.at(-1); ret.args = [{value:target}]; target.uses.push(ret);
  const canonical = structuredClone(ir);
  const result = enhanceSemanticDecompilation({semantic:true,ir,types:null,
    lines:[{kind:'stmt',indent:0,text:'return pending;',row:ret.row,addr:ret.address}],metrics:{},ctx:{}},null,
    {phase8PrepareProof:true,phase8ProofOnlyRewrites:defer,deterministicTransforms:true,decompilerTimeBudgetMs:1000});
  return {ir,input,count,target,result,canonical,...shape,options:{identity,abiId:'generic-v1',memory:{addressBits:8},targets:[target],
    timeoutMs:1000,backendTier:'tiered',candidateStrategy:'representation-rules',requireProofOnlyRewrites:true}};
}

for (const bits of [4,8]) test(`C4-04 shift-mask BV${bits} actual producer and private transaction adopt the proved full-width value`, async () => {
  const ordinary = shiftMaskProductionFixture(bits,{defer:false}), f = shiftMaskProductionFixture(bits);
  assert.ok(ordinary.result.rewriteProof.some(row => row.rule === 'recognize-bit_extract'));
  assert.ok(!f.result.rewriteProof.some(row => row.rule === 'recognize-bit_extract'));
  assert.equal(f.result.rewriteStats.deferred,'phase8-proof-projection');
  const original = f.result.semanticAst.values.find(row => row.valueId === f.target.id).expression;
  assert.equal(original.bits,bits);
  const translated = await querySymbolicAnalysis(f.ir,{...f.options,models,candidateStrategy:'translate-only'});
  assert.equal(translated.status,'complete',translated.reason);
  const binding = readSymbolicTargetInputs(translated,f.target,identity), inputs = readProducerInputExpressions(f.result,[f.input]);
  assert.ok(binding); assert.equal(binding.inputs.length,1); assert.equal(binding.inputs[0].value,f.input);
  assert.equal(binding.expression.sort.width,bits); assert.ok(inputs); assert.equal(inputs[0].expression.bits,bits);
  const beforeText = f.result.pseudocode, beforeAst = f.result.cAst;
  const r = await optimizeSemanticDecompilation(f.result,f.options);
  assert.equal(r.proofOptimization.status,'complete',r.proofOptimization.reason);
  assert.equal(r.proofOptimization.adopted,1);
  const [decision] = r.proofOptimization.targetDecisions;
  assert.equal(decision.disposition,'adopted'); assert.equal(decision.candidateCount,1);
  const transform = r.phase8Projection.transforms.find(row => row.valueId === decision.valueId && row.queryHash === decision.queryHash);
  assert.ok(transform); assert.equal(transform.kind,'solver-scalar'); assert.notEqual(transform.beforeHash,transform.afterHash);
  assertIdiomAudit(transform.generatorAudit,decision.queryHash,'recognize-bit_extract');
  assert.ok(r.renderProvenance.ledger.some(row => row.generatorAudit === transform.generatorAudit && row.producedRefs.length));
  const after = r.semanticAst.values.find(row => row.valueId === f.target.id).expression;
  assert.equal(after.bits,bits); assert.notEqual(after,original); assert.notEqual(r.pseudocode,beforeText);
  for (let i=0;i<2**bits;i++) {
    const value = BigInt(i), expected = (value >> BigInt(f.offset)) & f.mask;
    const before = E.evaluateExpr(binding.expression,new Map([[binding.inputs[0].symbol.symbolId,value]]));
    assert.equal(before.status,E.EVAL_STATUS.VALUE); assert.equal(before.value,expected);
    assert.equal(evaluateExpression(after,{[inputs[0].expression.name]:value}),expected,`BV${bits}: adopted ${value}`);
  }
  assert.equal(f.result.cAst,beforeAst); assert.equal(f.result.pseudocode,beforeText);
  assert.equal(f.result.semanticAst.values.find(row => row.valueId === f.target.id).expression,original);
  assert.deepEqual(structuredClone(f.ir),f.canonical);
  const replay = await optimizeSemanticDecompilation(r,f.options);
  assert.equal(replay.proofOptimization.status,'complete',replay.proofOptimization.reason);
  assert.equal(replay.proofOptimization.adopted,0); assert.equal(replay.pseudocode,r.pseudocode);
});

test('C4-04 shift-mask publication and stale-input refusals retain the original prepared output', async () => {
  for (const options of [{phase8WorkBudget:0},{timeoutMs:0},{isCancelled:() => true}]) {
    const f = shiftMaskProductionFixture(4), r = await optimizeSemanticDecompilation(f.result,{...f.options,...options});
    assert.equal(r.proofOptimization.status,'partial'); assert.equal(r.proofOptimization.adopted,0);
    assert.equal(r.cAst,f.result.cAst); assert.equal(r.semanticAst,f.result.semanticAst); assert.equal(r.pseudocode,f.result.pseudocode);
    assert.ok(!(r.phase8Projection?.transforms ?? []).some(row => ['solver-constant','solver-scalar'].includes(row.kind)));
    assert.deepEqual(structuredClone(f.ir),f.canonical);
  }
  const f = shiftMaskProductionFixture(4); f.input.bits = 8;
  const r = await optimizeSemanticDecompilation(f.result,f.options);
  assert.equal(r.proofOptimization.reason,'unissued-or-stale-projection'); assert.equal(r.proofOptimization.adopted,0);
  assert.equal(r.cAst,f.result.cAst); assert.equal(r.pseudocode,f.result.pseudocode);
});
