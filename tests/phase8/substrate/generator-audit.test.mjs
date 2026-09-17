import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../../../js/symbolic/expr/index.js';
import { queryEqualitySaturation } from '../../../js/symbolic/query/equality-saturation.js';
import { querySymbolicAnalysis } from '../../../js/symbolic/query/analysis.js';
import { createTaintModels } from '../../../js/symbolic/taint/models.js';
import { isAdoptableCandidate } from '../../../js/symbolic/taint/proof-consumer.js';
import { EGRAPH_LIMITS } from '../../../js/symbolic/egraph/graph.js';
import { EQUALITY_RULESET_VERSION } from '../../../js/symbolic/egraph/rules.js';
import { preparePhase8RewritePlan, isPhase8RewritePlan, readProvedRewrites } from '../../../js/decompiler/phase8/pass-validation.js';
import { runPhase8Stage, createAnalysisState } from '../../../js/decompiler/phase8/index.js';
import { optimizeSemanticDecompilation, isProducerProjection } from '../../../js/decompiler/pipeline.js';
import { projectionFixture, proofFixture, identity } from '../helpers/proof-fixtures.mjs';

const context = (f,plan) => ({ir:f.ir,proofIdentity:identity,abiId:f.options.abiId,proofRewritePlan:plan});
const stage = (f,plan) => runPhase8Stage(context(f,plan),{stages:['canonical-facts','rendering'],timeBudgetMs:1000});
function assertAudit(audit,entry) {
  assert.equal(audit.schemaVersion,'hex-phase8-generator-audit/v1');
  assert.equal(audit.scope,'whole-query-search-not-per-candidate-derivation-or-proof');
  assert.equal(audit.strategy,'equality-saturation');
  assert.equal(audit.rulesetVersion,EQUALITY_RULESET_VERSION);
  assert.equal(audit.proofQueryHash,entry.queryHash);
  assert.equal(audit.candidateId,`egraph:${EQUALITY_RULESET_VERSION}:${entry.afterHash}`);
  assert.ok(audit.appliedRules.length > 0);
  assert.equal(new Set(audit.appliedRules).size,audit.appliedRules.length);
  for (const [key,maximum] of Object.entries(EGRAPH_LIMITS)) {
    assert.ok(Number.isSafeInteger(audit.limits[key]) && audit.limits[key] <= maximum);
    assert.ok(Number.isSafeInteger(audit.resources[key]) && audit.resources[key] <= audit.limits[key]);
  }
  assert.ok(audit.resources.verificationQueries > 0);
  assert.ok(audit.resources.ruleApplications > 0);
  assert.ok(!Object.hasOwn(audit.resources,'wallClock'));
  assert.ok(!Object.hasOwn(audit.limits,'timeoutMs'));
  for (const value of [audit,audit.appliedRules,audit.extractionCost,audit.limits,audit.resources]) assert.ok(Object.isFrozen(value));
  assert.equal(isAdoptableCandidate(audit),false,'audit data is not proof authority');
  assert.equal(isPhase8RewritePlan(audit),false);
  assert.deepEqual(JSON.parse(JSON.stringify(audit)),{...audit,limits:{...audit.limits}},
    'transport preserves data; the query reader deliberately uses a null-prototype dictionary');
}

test('C4-05 query reports the effective captured limits, not defaults or later caller mutations',async () => {
  const x = E.createFreshSymbol(E.bvSort(4),'audit_x'), expression = E.createBinary('xor',x,x);
  const limits = {enodes:64,candidates:2}, options = {expression,valueId:'audit_value',identity,
    limits,memoryObservables:[],effectObservables:[],timeoutMs:1000};
  const pending = queryEqualitySaturation(options);
  limits.enodes = 0;options.limits = {candidates:0};
  const r = await pending;
  assert.equal(r.status,'complete',r.reason);
  assert.deepEqual(r.limits,{...EGRAPH_LIMITS,enodes:64,candidates:2});
  assert.ok(Object.isFrozen(r.limits));
  assert.ok(r.candidates.some(c=>isAdoptableCandidate(c.verification,{identity})));
  const refused = await queryEqualitySaturation({...options,limits:{workItems:0}});
  assert.equal(refused.status,'partial');assert.equal(refused.limits.workItems,0);
  assert.deepEqual(refused.candidates,[]);
});

test('C4-05 actual owned target analysis retains the query budget and measured counters',async () => {
  const f = projectionFixture(4), models = createTaintModels({id:'audit-model',version:'1',provenance:'test-fixture',sources:[],sinks:[]});
  const r = await querySymbolicAnalysis(f.ir,{...f.options,models,ruleOrder:'reverse'});
  assert.equal(r.status,'complete',r.reason);
  for (const target of r.targets) {
    assert.equal(target.ruleOrder,'reverse');
    assert.deepEqual(target.generatorLimits,EGRAPH_LIMITS);
    assert.ok(Object.isFrozen(target.generatorLimits));
    assert.ok(target.metrics.ruleApplications > 0 && target.metrics.verificationQueries > 0);
  }
});

test('C4-05 genuine plans and committed overlays retain generator audits without changing the strict pass-result schema',async () => {
  const f = projectionFixture(4), plan = await preparePhase8RewritePlan(f.ir,f.options);
  assert.equal(plan.status,'complete',plan.reason);
  for (const entry of plan.entries) {
    assertAudit(entry.generatorAudit,entry);
    assert.deepEqual(entry.generatorAudit.extractionCost,{treeNodes:1,depth:1,expensiveOps:0});
  }
  const r = stage(f,plan);
  assert.equal(r.ledger.published,true,JSON.stringify(r.ledger.diagnostics));
  const overlay = readProvedRewrites(r.analysis,context(f,plan));
  assert.ok(overlay);
  for (const [index,entry] of overlay.entries.entries()) assert.equal(entry.generatorAudit,plan.entries[index].generatorAudit);
  for (const transform of r.ledger.passes.at(-1).transforms) {
    assert.deepEqual(Object.keys(transform.validation).sort(),['planId','queryHash','schemaVersion','verifier']);
    assert.deepEqual(Object.keys(transform.rewrite).sort(),['afterHash','beforeHash']);
    assert.ok(overlay.entries.some(entry=>entry.queryHash===transform.validation.queryHash));
  }
});

test('C4-05 constant and nonconstant real projections retain proof-linked rule/cost/budget audits under all schedules',async () => {
  for (const operator of ['xor','or']) for (const ruleOrder of ['canonical','reverse','discovery']) {
    const f = projectionFixture(4,operator), original = f.result.pseudocode;
    const options = {...f.options,ruleOrder}, plan = await preparePhase8RewritePlan(f.ir,options);
    assert.equal(plan.status,'complete',plan.reason);
    const r = await optimizeSemanticDecompilation(f.result,options);
    assert.equal(r.proofOptimization.status,'complete',r.proofOptimization.reason);
    assert.equal(r.proofOptimization.adopted,2);
    for (const record of r.phase8Projection.transforms) {
      const entry = plan.entries.find(entry=>entry.valueId===record.valueId);
      assert.ok(entry);assertAudit(record.generatorAudit,entry);
      assert.equal(record.generatorAudit.ruleOrder,ruleOrder);
      assert.deepEqual(record.generatorAudit,entry.generatorAudit);
      assert.equal(record.generatorAudit.extractionCost.treeNodes,operator==='xor'?1:3);
      const ledger = r.renderProvenance.ledger.find(row=>row.queryHash===record.queryHash);
      assert.ok(ledger);assert.equal(ledger.generatorAudit,record.generatorAudit);
      assert.throws(()=>{record.generatorAudit.extractionCost.treeNodes=999;},TypeError);
    }
    assert.equal(r.ir,f.ir);assert.equal(f.result.pseudocode,original);
    assert.ok(isProducerProjection(r));
    const replay = await optimizeSemanticDecompilation(r,options);
    assert.equal(replay.proofOptimization.status,'complete',replay.proofOptimization.reason);
    assert.equal(replay.proofOptimization.adopted,0);
    assert.equal(replay.pseudocode,r.pseudocode);
    for (const record of r.phase8Projection.transforms) {
      assert.ok(replay.phase8Projection.history.transforms.includes(record));
      assert.ok(replay.renderProvenance.ledger.some(row=>row.queryHash===record.queryHash && row.generatorAudit===record.generatorAudit));
    }
  }
});

test('C4-05 replay audit identity is deterministic and excludes wall-clock measurements',async () => {
  const f = projectionFixture(4,'or');
  const a = await preparePhase8RewritePlan(f.ir,f.options), b = await preparePhase8RewritePlan(f.ir,f.options);
  assert.equal(a.status,'complete',a.reason);assert.equal(b.status,'complete',b.reason);
  assert.deepEqual(a.entries.map(e=>e.generatorAudit),b.entries.map(e=>e.generatorAudit));
  assert.equal(a.planId,b.planId);
  assert.equal(stage(f,a).ledger.publicationDigest,stage(f,b).ledger.publicationDigest);
  assert.equal(typeof a.metrics.wallClock,'number','elapsed observations remain outside stable audit identity');
});

test('C4-05 copied plans, seeded overlays and edited history cannot grant authority to an otherwise owned AST wrapper',async () => {
  const f = projectionFixture(4), plan = await preparePhase8RewritePlan(f.ir,f.options);
  assert.equal(plan.status,'complete',plan.reason);
  const forged = {...plan,entries:plan.entries.map(entry=>({...entry,generatorAudit:{...entry.generatorAudit,
    proofQueryHash:'forged',extractionCost:{treeNodes:0,depth:0,expensiveOps:0}}}))};
  assert.equal(isPhase8RewritePlan(forged,context(f,forged)),false);
  assert.equal(stage(f,forged).ledger.published,false);
  const good = stage(f,plan), overlay = readProvedRewrites(good.analysis,context(f,plan));
  assert.equal(readProvedRewrites(createAnalysisState({provedRewrites:{...overlay,entries:forged.entries}}),context(f,plan)),null);
  const r = await optimizeSemanticDecompilation(f.result,f.options);
  const clone = {...r,phase8Projection:{...r.phase8Projection,transforms:r.phase8Projection.transforms.map(row=>({...row,generatorAudit:forged.entries[0].generatorAudit}))}};
  // Result wrappers may legitimately retain the same privately owned AST. A
  // substituted history loses its binding, not the AST's semantic capability.
  assert.equal(isProducerProjection(clone),true);
  const rejected = await optimizeSemanticDecompilation(clone,f.options);
  assert.equal(rejected.proofOptimization.status,'complete');assert.equal(rejected.proofOptimization.adopted,0);
  assert.equal(rejected.pseudocode,r.pseudocode);
  assert.equal(rejected.phase8Projection.history.completeness,'incomplete');
  assert.ok(rejected.phase8Projection.history.reasons.includes('unavailable-prior-projection-history'));
  assert.ok(rejected.renderProvenance.ledger.every(row=>row.generatorAudit?.proofQueryHash!=='forged'));
  const copiedAst = await optimizeSemanticDecompilation({...r,semanticAst:{...r.semanticAst}},f.options);
  assert.equal(copiedAst.proofOptimization.status,'partial');assert.equal(copiedAst.proofOptimization.adopted,0);
});

test('C4-05 stale or exhausted transactions never publish a newly prepared generator audit as an adopted transform',async () => {
  const f = projectionFixture(4), plan = await preparePhase8RewritePlan(f.ir,f.options);
  assert.equal(plan.status,'complete',plan.reason);
  for (const extra of [{phase8WorkBudget:0},{timeoutMs:0},{isCancelled:()=>true}]) {
    const r = await optimizeSemanticDecompilation(f.result,{...f.options,...extra});
    assert.equal(r.proofOptimization.status,'partial');assert.equal(r.proofOptimization.adopted,0);
    assert.equal(r.pseudocode,f.result.pseudocode);
    assert.ok(!(r.phase8Projection?.transforms??[]).some(record=>record.generatorAudit));
  }
  f.target.def.sub = 'add';
  assert.equal(isPhase8RewritePlan(plan,context(f,plan)),false);
  assert.equal(stage(f,plan).ledger.published,false);
});

test('C4-05 audit capture remains inside exact parent work/allocation budgets',async () => {
  const f = projectionFixture(4), baseline = await preparePhase8RewritePlan(f.ir,f.options);
  assert.equal(baseline.status,'complete',baseline.reason);
  for (const counter of ['workItems','allocationUnits']) {
    const ceiling = baseline.metrics[counter];
    for (const delta of [-1,0,1]) {
      const r = await preparePhase8RewritePlan(f.ir,{...f.options,limits:{[counter]:ceiling+delta}});
      assert.equal(r.status,delta < 0 ? 'partial' : 'complete',`${counter}/${delta}:${r.reason}`);
      if (delta < 0) assert.deepEqual(r.entries,[]);
      else assert.ok(r.entries.every(entry=>entry.generatorAudit));
    }
  }
});

test('C4-05 caller metadata cannot replace owned audit fields or label another strategy as equality saturation',async () => {
  const fake = {strategy:'equality-saturation',appliedRules:['forged'],limits:{enodes:0},proofQueryHash:'forged'};
  const f = proofFixture(4);
  for (const candidateStrategy of ['local-rewrites','representation-rules','equality-saturation']) {
    const plan = await preparePhase8RewritePlan(f.ir,{...f.options,candidateStrategy,generatorAudit:fake,generatorLimits:fake.limits});
    assert.equal(plan.status,'complete',plan.reason);assert.equal(plan.entries.length,1);
    const audit = plan.entries[0].generatorAudit;
    if (candidateStrategy === 'equality-saturation') {
      assertAudit(audit,plan.entries[0]);assert.ok(!audit.appliedRules.includes('forged'));assert.ok(audit.limits.enodes > 0);
    } else if (candidateStrategy === 'representation-rules') {
      assert.equal(audit.strategy,'representation-rules');
      assert.ok(!audit.appliedRules.includes('forged'));
      assert.equal(audit.proofQueryHash,plan.entries[0].queryHash);
    } else assert.equal(audit,undefined);
  }
});
