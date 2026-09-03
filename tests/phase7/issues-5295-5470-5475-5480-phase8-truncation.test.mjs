import assert from 'node:assert/strict';
import test from 'node:test';

import { runAggregatePass } from '../../js/decompiler/phase8/aggregates.js';
import { runStructuringPass } from '../../js/decompiler/phase8/structuring.js';
import { runInductionPass } from '../../js/decompiler/phase8/induction.js';
import { canonicalAnalysisIdentity } from '../../js/decompiler/phase8/analysis-identity.js';

/**
 * Phase 8 passes must not publish `complete` after a deterministic resource
 * limit silently cut the input: truncation sets budgetExhausted and the facts
 * (and their diagnostics) stay partial (#5295, #5470, #5475, #5480).
 */

function staged(run, context, budget, key) {
  let facts;
  const result = run(context, budget, { stage: (name, value) => { if (name === key) facts = value; } });
  return { facts, result };
}

function aggregateCfg() {
  return { blocks: [
    { insts: [{ id: 1, op: 'load', loc: { kind: 'stack', disp: 0n, size: 8 }, addr: {} }] },
    { insts: [{ id: 2, op: 'mov' }, { id: 3, op: 'load', loc: { kind: 'stack', disp: 8n, size: 8 }, addr: {} }] },
    { insts: [{ id: 4, op: 'load', loc: { kind: 'global', address: '0x2000', disp: 0n, size: 8 }, addr: {} }] },
  ] };
}

function aggregateContext(cfg) {
  return { analysis: { get: (key) => (key === 'cfg' ? cfg : key === 'induction' ? { loops: [] } : null) } };
}

const AGG_LIMITS = { maxAccesses: 4096, maxRegions: 256, maxCopyChain: 8 };

test('#5470 maxAccesses truncation publishes partial aggregates', () => {
  const { facts, result } = staged(runAggregatePass, aggregateContext(aggregateCfg()),
    { limits: { ...AGG_LIMITS, maxAccesses: 1 }, shouldAbort: () => false }, 'aggregates');
  assert.equal(facts.completeness, 'partial');
  assert.equal(result.completeness, 'partial');
  assert.ok(result.diagnostics.some((entry) => entry.code === 'phase8.aggregates.budget'),
    'the cut must be diagnosed, not silent');
  // Generous limits keep the complete contract.
  const whole = staged(runAggregatePass, aggregateContext(aggregateCfg()),
    { limits: AGG_LIMITS, shouldAbort: () => false }, 'aggregates');
  assert.equal(whole.facts.completeness, 'complete');
});

test('#5470 maxAccesses exact-limit without another memory access stays complete', () => {
  const cfg = { blocks: [
    { insts: [
      { id: 1, op: 'load', loc: { kind: 'stack', disp: 0n, size: 8 }, addr: {} },
      { id: 2, op: 'mov' },
    ] },
  ] };
  const { facts, result } = staged(runAggregatePass, aggregateContext(cfg),
    { limits: { ...AGG_LIMITS, maxAccesses: 1 }, shouldAbort: () => false }, 'aggregates');
  assert.equal(facts.completeness, 'complete');
  assert.equal(result.completeness, 'complete');
  assert.ok(!result.diagnostics.some((entry) => entry.code === 'phase8.aggregates.budget'),
    'hitting the cap exactly is not truncation when no memory access remains');
});

test('#5470 maxAccesses cannot be overshot by a block-opening access', () => {
  const cfg = { blocks: [
    { insts: [{ id: 1, op: 'load', loc: { kind: 'stack', disp: 0n, size: 8 }, addr: {} }] },
    { insts: [{ id: 2, op: 'load', loc: { kind: 'stack', disp: 8n, size: 8 }, addr: {} }] },
  ] };
  const { facts } = staged(runAggregatePass, aggregateContext(cfg),
    { limits: { ...AGG_LIMITS, maxAccesses: 1 }, shouldAbort: () => false }, 'aggregates');
  assert.equal(facts.completeness, 'partial');
  const seen = new Set(facts.regions.flatMap((region) => region.origin.instructionIds));
  assert.ok(!seen.has(2), 'the access past the cap must not leak into the published regions');
});

test('#5295 maxRegions truncation publishes partial aggregates', () => {
  const { facts, result } = staged(runAggregatePass, aggregateContext(aggregateCfg()),
    { limits: { ...AGG_LIMITS, maxRegions: 1 }, shouldAbort: () => false }, 'aggregates');
  assert.equal(facts.regionCount, 1);
  assert.equal(facts.completeness, 'partial');
  assert.equal(result.completeness, 'partial');
  assert.equal(facts.regions[0].completeness, 'partial', 'kept regions must not claim completeness alone');
});

test('#5475 maxBlocks truncation publishes partial structuring', () => {
  const cfg = { blocks: [
    { index: 0, succ: [1], successorEdges: [{ to: 1, kind: 'branch' }], insts: [] },
    { index: 1, succ: [0], successorEdges: [{ to: 0, kind: 'branch' }], insts: [] },
  ] };
  const context = { analysis: { get: (key) => (key === 'cfg' ? cfg : key === 'dominators' ? {} : key === 'induction' ? { loops: [] } : null) } };
  const { facts, result } = staged(runStructuringPass, context,
    { limits: { maxBlocks: 1, maxChainWalk: 4096 }, shouldAbort: () => false }, 'structuredRegions');
  assert.equal(facts.completeness, 'partial');
  assert.equal(result.completeness, 'partial');
  const whole = staged(runStructuringPass, context,
    { limits: { maxBlocks: 4096, maxChainWalk: 4096 }, shouldAbort: () => false }, 'structuredRegions');
  assert.equal(whole.facts.completeness, 'complete');
});

function inductionContext({ loops, cfg, dominators }) {
  const analysis = { get: (key) => {
    if (key === 'cfg') return cfg;
    if (key === 'loops') return { loops };
    if (key === 'dominators') return dominators;
    if (key === 'ssa') return { values: [] };
    return null;
  } };
  const resolved = canonicalAnalysisIdentity({ analysis });
  assert.equal(resolved.valid, true, 'the fixture must pass the pass identity gate');
  return { analysis: { get: (key) => (key === 'ranges' ? { identity: resolved.identity } : analysis.get(key)) } };
}

function twoLoopCfg() {
  return { blocks: [
    { index: 0, succ: [1], successorEdges: [{ to: 1, kind: 'branch' }], insts: [], phis: [] },
    { index: 1, succ: [0], successorEdges: [{ to: 0, kind: 'branch' }], insts: [], phis: [] },
  ] };
}

const fakeLoop = (header) => ({
  header, classification: 'counted', latches: [header], nodes: [header],
  exits: [], exitEdges: [], guardBlock: null, depth: 0, parentHeader: null,
});

test('#5480 maxLoops truncation publishes partial induction', () => {
  const context = inductionContext({ loops: [fakeLoop(0), fakeLoop(1)], cfg: twoLoopCfg(), dominators: {} });
  const { facts, result } = staged(runInductionPass, context,
    { limits: { maxLoops: 1, maxPhisPerLoop: 256, maxCopyChain: 8 }, shouldAbort: () => false }, 'induction');
  assert.equal(facts.loops.length, 1);
  assert.equal(facts.completeness, 'partial');
  assert.equal(result.completeness, 'partial');
  const whole = staged(runInductionPass, context,
    { limits: { maxLoops: 512, maxPhisPerLoop: 256, maxCopyChain: 8 }, shouldAbort: () => false }, 'induction');
  assert.equal(whole.facts.loops.length, 2);
  assert.equal(whole.facts.completeness, 'complete');
});

test('#5480 maxPhisPerLoop truncation publishes partial induction', () => {
  const phis = [1, 2, 3].map((id) => ({ dst: { id, bits: 64 }, incoming: [{ from: 0 }, { from: 0 }] }));
  const cfg = { blocks: [
    { index: 0, succ: [0, 1], successorEdges: [{ to: 0, kind: 'branch' }, { to: 1, kind: 'branch' }], insts: [], phis },
    { index: 1, succ: [], successorEdges: [], insts: [], phis: [] },
  ] };
  const context = inductionContext({
    loops: [{ header: 0, latches: [0], nodes: [0], exits: [1], exitEdges: [], guardBlock: null, depth: 0, parentHeader: null }],
    cfg,
    dominators: { dominators: { 0: [0], 1: [0, 1] } },
  });
  const { facts, result } = staged(runInductionPass, context,
    { limits: { maxLoops: 512, maxPhisPerLoop: 1, maxCopyChain: 8 }, shouldAbort: () => false }, 'induction');
  assert.equal(facts.completeness, 'partial');
  assert.equal(result.completeness, 'partial');
  assert.equal(facts.loops[0].completeness, 'partial', 'the cut loop must not claim completeness alone');
  assert.match(facts.loops[0].completenessReason ?? '', /maxPhisPerLoop/);
});
