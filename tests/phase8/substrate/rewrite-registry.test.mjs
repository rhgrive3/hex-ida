import assert from 'node:assert/strict';
import test from 'node:test';
import { stableDigest } from '../../../js/core/identity/index.js';
import {
  createAnalysisState, createPassDescriptor, createPassResult, createProvider, passRegistryDigest,
  phase8Passes, phase8RewriteRegistry, runPassTransaction, runPhase8Vertical, seedAnalysisState,
} from '../../../js/decompiler/phase8/index.js';
import { PROOF_REWRITE_PASS, preparePhase8RewritePlan, isPhase8RewritePlan } from '../../../js/decompiler/phase8/pass-validation.js';
import { buildRewriteRegistry, passRewritePolicy, rewritePolicyFailure, REWRITE_REGISTRY_VERSION } from '../../../js/decompiler/phase8/rewrite-registry.js';
import { proofFixture, identity } from '../helpers/proof-fixtures.mjs';

const allPasses = () => [...phase8Passes(), { descriptor:PROOF_REWRITE_PASS }];
const context = () => ({ ir:{ values:[{id:1}], blocks:[{index:0}], entry:0, origin:{} } });

test('C4-04 rewrite denominator is the exact registered production pass union', () => {
  const registry = phase8RewriteRegistry(), passes = allPasses();
  assert.equal(registry.length, 9);
  assert.deepEqual(new Set(registry.map(row => row.passId)), new Set(passes.map(pass => pass.descriptor.id)));
  // Registration order is not execution order: the runner dependency-sorts
  // within each stage. Coverage must preserve the exact union, not reorder it.
  const byId = rows => new Map(rows.map(row => [row.passId,row]));
  assert.deepEqual(byId(registry), byId(buildRewriteRegistry(passes)));
  assert.ok(Object.isFrozen(registry));
  for (const row of registry) {
    const descriptor = passes.find(pass => pass.descriptor.id === row.passId).descriptor;
    assert.equal(row.passVersion, descriptor.version);
    assert.equal(row.stage, descriptor.stage);
    assert.ok(Object.isFrozen(row) && Object.isFrozen(row.families) && Object.isFrozen(row.kinds));
    assert.equal(row.mode, descriptor === PROOF_REWRITE_PASS ? 'proof-gated-value-projection' : 'analysis-only');
  }
  assert.throws(() => buildRewriteRegistry(passes.slice(1)), /registry-incomplete/);
  assert.throws(() => buildRewriteRegistry([...passes, passes[0]]), /unclassified-or-duplicate/);
  assert.throws(() => buildRewriteRegistry([...passes, {descriptor:{id:'phase8.new-unclassified'}}]), /unclassified-or-duplicate/);
});

test('C4-04 rewrite policy is part of execution registry identity, not proof authority', () => {
  const passes = phase8Passes({ stages:['canonical-facts'] });
  const material = passes.map(({descriptor:d}) => ({
    id:d.id, version:d.version, stage:d.stage, budgetClass:d.budgetClass,
    consumes:d.consumes, preserves:d.preserves, invalidates:d.invalidates, produces:d.produces,
    contractVersion:d.contractVersion, rewriteRegistryVersion:REWRITE_REGISTRY_VERSION,
    rewritePolicy:passRewritePolicy(d),
  }));
  assert.equal(passRegistryDigest(passes), stableDigest(material));
  assert.notEqual(passRegistryDigest(passes), stableDigest(material.map(row => ({...row,rewriteRegistryVersion:'old'}))));
  assert.notEqual(passRegistryDigest(passes), stableDigest(material.map(row => ({...row,rewritePolicy:null}))));
  let reads = 0;
  assert.equal(passRewritePolicy({get id() { reads++; return PROOF_REWRITE_PASS.id; }}), null);
  assert.equal(reads, 0);
  assert.equal(isPhase8RewritePlan({...phase8RewriteRegistry().at(-1)}), false);
});

test('C4-04 actual ordinary execution accounts for analysis and unsupported passes without claiming rewrites', () => {
  const {ledger} = runPhase8Vertical(context());
  assert.equal(ledger.published, true, ledger.stopReason);
  const coverage = ledger.rewriteCoverage;
  assert.equal(coverage.registered, 9);
  assert.equal(coverage.accounted, 9);
  assert.equal(coverage.selected, 8);
  assert.equal(coverage.scope, 'registered-phase8-transactions-not-render-adoption');
  assert.ok(Object.isFrozen(coverage) && Object.isFrozen(coverage.rows) && coverage.rows.every(Object.isFrozen));
  for (const row of coverage.rows) {
    const result = ledger.passes.find(result => result.passId === row.passId);
    assert.equal(row.proofTransformCount, 0);
    assert.equal(row.resultStatus, result?.status ?? null);
    assert.equal(row.completeness, result?.completeness ?? 'unknown');
    assert.equal(row.disposition, !result ? 'not-requested' : result.status === 'unsupported' ? 'unsupported' : 'analysis-only');
  }
  const interactive = runPhase8Vertical({...context(), enabledStages:['canonical-facts']}).ledger.rewriteCoverage;
  assert.equal(interactive.selected, 1);
  assert.equal(interactive.rows.filter(row => row.disposition === 'not-requested').length, 8);
  assert.equal(interactive.rows.find(row => row.passId === 'phase8.identity').disposition, 'analysis-only');
});

test('C4-04 selected passes with unavailable inputs remain explicit unsupported rows', () => {
  const {ledger} = runPhase8Vertical({analysis:createAnalysisState(), enabledStages:['canonical-facts']});
  assert.equal(ledger.published, true);
  const row = ledger.rewriteCoverage.rows.find(row => row.selected);
  assert.equal(row.disposition, 'unsupported');
  assert.equal(row.completeness, 'unknown');
  assert.match(row.reason, /^missing-input:/);
  assert.equal(row.proofTransformCount, 0);
});

test('C4-04 optional provider failure stays partial analysis, never a proved rewrite', () => {
  const f = proofFixture(4);
  const provider = createProvider({id:'registry.partial',version:'1',kinds:['idiom'],
    refine() { throw new Error('controlled provider failure'); }});
  const {ledger} = runPhase8Vertical({ir:f.ir,providers:[provider]});
  assert.equal(ledger.published, true, ledger.stopReason);
  const row = ledger.rewriteCoverage.rows.find(row => row.passId === 'phase8.providers');
  assert.equal(row.disposition, 'analysis-only');
  assert.equal(row.resultStatus, 'changed');
  assert.equal(row.completeness, 'partial');
  assert.equal(row.proofTransformCount, 0);
});

test('C4-04 only the real proof transaction reports committed transforms, not rendered adoption', async () => {
  const f = proofFixture(4), plan = await preparePhase8RewritePlan(f.ir, f.options);
  assert.equal(plan.status, 'complete', plan.reason);
  const ctx = {ir:f.ir, proofIdentity:identity, abiId:f.options.abiId, proofRewritePlan:plan,
    enabledStages:['canonical-facts','rendering']};
  const {ledger} = runPhase8Vertical(ctx);
  assert.equal(ledger.published, true, ledger.stopReason);
  const row = ledger.rewriteCoverage.rows.find(row => row.passId === PROOF_REWRITE_PASS.id);
  assert.equal(row.disposition, 'proof-committed');
  assert.ok(row.proofTransformCount > 0);
  assert.equal(row.proofTransformCount, ledger.passes.find(result => result.passId === row.passId).transforms.length);
  assert.equal(row.proofTransformCount, plan.entries.length);
  assert.equal(Object.hasOwn(row, 'adopted'), false);
  assert.equal(isPhase8RewritePlan({...plan,...row}, ctx), false);
});

test('C4-04 cancellation at every real transaction check withholds all earlier success counts', async () => {
  const f = proofFixture(4), plan = await preparePhase8RewritePlan(f.ir, f.options);
  assert.equal(plan.status, 'complete', plan.reason);
  const ctx = {ir:f.ir, proofIdentity:identity, abiId:f.options.abiId, proofRewritePlan:plan,
    enabledStages:['canonical-facts','rendering']};
  let checks = 0;
  const normal = runPhase8Vertical(ctx, {shouldAbort:() => { checks++; return false; }});
  assert.equal(normal.ledger.published, true);
  assert.ok(checks > 3);
  for (let at = 1; at <= checks; at++) {
    const analysis = seedAnalysisState(f.ir), before = analysis.snapshot();
    let calls = 0;
    const {ledger} = runPhase8Vertical({...ctx,analysis}, {shouldAbort:() => ++calls >= at});
    assert.equal(ledger.published, false, `check ${at}/${checks}`);
    assert.deepEqual(analysis.snapshot(), before);
    assert.equal(ledger.rewriteCoverage.rows.length, 9);
    assert.ok(ledger.rewriteCoverage.rows.every(row => row.proofTransformCount === 0));
    assert.ok(ledger.rewriteCoverage.rows.filter(row => row.selected).every(row => row.disposition === 'unknown'));
  }
});

test('C4-04 unsupported targets produce no committed transforms and a copied plan stays unknown', async () => {
  const f = proofFixture(4);
  f.target.def.sub = 'udiv';
  const plan = await preparePhase8RewritePlan(f.ir, f.options);
  assert.equal(plan.status, 'complete', plan.reason);
  assert.equal(plan.targetDecisions[0].disposition, 'unsupported');
  const ctx = {ir:f.ir, proofIdentity:identity, abiId:f.options.abiId,
    enabledStages:['canonical-facts','rendering']};
  const {ledger} = runPhase8Vertical({...ctx,proofRewritePlan:plan});
  assert.equal(ledger.published, true);
  const row = ledger.rewriteCoverage.rows.find(row => row.passId === PROOF_REWRITE_PASS.id);
  assert.equal(row.disposition, 'unchanged', 'pass outcome and per-target support are separate denominators');
  assert.equal(row.proofTransformCount, 0);
  const copied = runPhase8Vertical({...ctx,proofRewritePlan:{...plan}}).ledger;
  assert.equal(copied.published, false);
  assert.ok(copied.rewriteCoverage.rows.filter(row => row.selected).every(row => row.disposition === 'unknown'));
  assert.ok(copied.rewriteCoverage.rows.every(row => row.proofTransformCount === 0));
});

test('C4-04 all eight analysis-only descriptors refuse reported rewrites atomically', () => {
  for (const {descriptor} of phase8Passes()) {
    const analysis = createAnalysisState(Object.fromEntries(descriptor.consumes.map(key => [key,{completeness:'complete'}])));
    const before = analysis.snapshot();
    const outcome = runPassTransaction(analysis, {descriptor, run(_context, _budget, area) {
      for (const key of descriptor.produces) area.stage(key, {completeness:'complete',marker:'must-not-commit'});
      return createPassResult({descriptor, status:'changed', produced:descriptor.produces,
        transforms:[{kind:'unproved-fold',targets:['value_1'],proof:'reported-text-is-not-proof'}]});
    }}, {requireRewritePolicy:true});
    assert.equal(outcome.committed, false, descriptor.id);
    assert.equal(outcome.stopReason, 'analysis-only-pass-reported-transform', descriptor.id);
    assert.deepEqual(analysis.snapshot(), before);
  }
});

test('C4-04 a copied proof descriptor cannot gain admission from a matching registry ID', () => {
  const descriptor = {...PROOF_REWRITE_PASS};
  const analysis = createAnalysisState(Object.fromEntries(descriptor.consumes.map(key => [key,{}])));
  const before = analysis.snapshot();
  const outcome = runPassTransaction(analysis, {descriptor, run() {
    return createPassResult({descriptor, status:'changed',
      transforms:[{kind:'solver-scalar',targets:['value_1'],proof:'copied-proof'}]});
  }}, {requireRewritePolicy:true});
  assert.equal(outcome.committed, false);
  assert.equal(outcome.stopReason, 'rewrite-policy-proof-pass-identity');
  assert.deepEqual(analysis.snapshot(), before);
  assert.equal(rewritePolicyFailure(PROOF_REWRITE_PASS, {transforms:[{kind:'undeclared'}]}, {proofPass:true}),
    'rewrite-policy-undeclared-kind');
});

test('C4-04 required registry mode refuses unknown passes without breaking the standalone transaction API', () => {
  const descriptor = createPassDescriptor({id:'phase8.test-unclassified',version:'1',stage:'canonical-facts',produces:['ranges']});
  const pass = {descriptor,run(_context, _budget, area) {
    area.stage('ranges', {completeness:'complete'});
    return createPassResult({descriptor,status:'changed',produced:['ranges']});
  }};
  const analysis = createAnalysisState(), before = analysis.snapshot();
  const refused = runPassTransaction(analysis,pass,{requireRewritePolicy:true});
  assert.equal(refused.committed, false);
  assert.equal(refused.stopReason, 'rewrite-policy-unclassified');
  assert.deepEqual(analysis.snapshot(), before);
  assert.equal(runPassTransaction(analysis,pass,{}).committed, true);
});
