import assert from 'node:assert/strict';
import test from 'node:test';
import { createFunctionSummary, createMemoryEffect, summaryIdentityMatches,
  summaryMayWriteRegion, summaryIsPure } from '../../../js/analysis/summary/contract.js';
import { buildLocalFunctionSummary } from '../../../js/analysis/summary/local.js';
import { analyzeLocalPointsTo } from '../../../js/analysis/pointsto/local.js';
import { createSemanticIrFunction } from '../../../js/semantics/ir/function.js';
import { createSemanticCfg } from '../../../js/semantics/cfg/index.js';
import { buildSemanticSsa } from '../../../js/semantics/ssa/build.js';

// #7467 region-aware write predicate needs the canonical region helpers.
let regionsModule = null;
async function awaitImportRegions() {
  regionsModule ??= await import('../../../js/analysis/alias/regions-v2.js');
  return regionsModule;
}

const snapshotId = 'snapshot-summary-boundary';
const identity = { functionId: 'callee', snapshotId, analyzerId: 'summary-test', analyzerVersion: '1' };
const status = { snapshotId, analyzerId: identity.analyzerId, analyzerVersion: '1', completeness: 'complete' };
const origin = (id) => ({ instructionIds: [`instruction_${id}`] });
const valid = (extra = {}) => createFunctionSummary({ functionId: 'callee', status,
  noreturn: false, mayThrow: false, returnProvenance: [{ kind: 'arg', argIndex: 0, offset: '8', returnIndex: 0 }], ...extra });
const copy = (s = valid()) => structuredClone(s);
function caller(callOverrides = {}) {
  const call = { targetEntityIds: ['callee'], targetValueIds: [], arguments: ['arg'], returns: ['ret'],
    stateReads: [], stateWrites: [], controlEffects: [], memoryRead: { scope: 'none' }, memoryWrite: { scope: 'none' },
    summarySource: 'fixture', completeness: 'complete', determinism: 'deterministic', noreturn: false, mayThrow: false, ...callOverrides };
  const nodes = [
    { id: 'arg_node', kind: 'state-read', blockId: 'entry', inputs: [], outputs: ['arg'],
      variable: { key: 'state:x0', kind: 'physical-state', scope: 'function' }, origin: origin('arg') },
    { id: 'call_node', kind: 'call', blockId: 'entry', inputs: ['arg'], outputs: ['ret'], call, origin: origin('call') },
  ];
  const ir = createSemanticIrFunction({ functionId: 'caller', entryBlockId: 'entry', origin: origin('function'),
    blocks: [{ id: 'entry', nodeIds: nodes.map((n) => n.id), origin: origin('block') }], nodes,
    values: ['arg', 'ret'].map((id, i) => ({ id, kind: 'definition', definitionNodeId: i ? 'call_node' : 'arg_node',
      machineType: { kind: 'bitvector', widthBits: 64 }, origin: origin(id) })) });
  const cfg = createSemanticCfg({ functionId: 'caller', entryBlockId: 'entry', blocks: [{ id: 'entry', successors: [] }] });
  return { ir, cfg, ssa: buildSemanticSsa(ir, cfg) };
}
const fixture = caller();
function fold(callee) {
  return buildLocalFunctionSummary(fixture.ir, fixture.cfg, fixture.ssa, null,
    { snapshotId, calleeSummaries: new Map([['callee', callee]]) }).summary;
}
function pointsTo(callee) {
  return analyzeLocalPointsTo(fixture.ir, fixture.cfg, fixture.ssa,
    { snapshotId, summaries: new Map([['callee', callee]]) }).pointsTo.get('ret');
}

for (const field of ['argIndex', 'returnIndex']) {
  for (const [label, value] of [['array', ['0']], ['boolean', true], ['string', '0'], ['object', { valueOf: () => 0 }],
    ['negative', -1], ['fraction', 0.5], ['unsafe', Number.MAX_SAFE_INTEGER + 1], ['nan', NaN], ['infinite', Infinity]]) {
    test(`#4314: ${field}/${label} is rejected before return provenance becomes pointer evidence`, () => {
      const raw = copy(); raw.returnProvenance[0][field] = value;
      assert.equal(summaryIdentityMatches(raw, identity), false);
      assert.throws(() => createFunctionSummary(raw), TypeError);
      assert.equal(pointsTo(raw).top, true);
    });
  }
}
for (const [label, value] of [['array', ['8']], ['boolean', true], ['object', { valueOf: () => 8 }],
  ['empty', ''], ['blank', '  '], ['fraction', 8.5], ['unsafe', Number.MAX_SAFE_INTEGER + 1], ['nan', NaN], ['infinite', Infinity]]) {
  test(`#4314: offset/${label} is not converted into an exact pointer displacement`, () => {
    const raw = copy(); raw.returnProvenance[0].offset = value;
    assert.equal(summaryIdentityMatches(raw, identity), false);
    assert.throws(() => createFunctionSummary(raw), TypeError);
    assert.equal(pointsTo(raw).top, true);
  });
}
for (const kind of ['not-a-provenance-kind', '', ['arg']]) {
  test(`#4314: malformed kind ${JSON.stringify(kind)} cannot enter the canonical return vocabulary`, () => {
    const raw = copy(); raw.returnProvenance[0].kind = kind;
    assert.equal(summaryIdentityMatches(raw, identity), false);
    assert.throws(() => createFunctionSummary(raw), TypeError);
  });
}
for (const [label, row] of [
  ['arg', { kind: 'arg', argIndex: 0, offset: '-8' }],
  ['root', { kind: 'root', rootEntityId: 'object', offset: '16', addressSpace: 'memory' }],
  ['allocation', { kind: 'allocation', allocationSiteId: 'site', offset: '0', returnIndex: 0, addressSpace: 'memory' }],
]) {
  test(`#4314: canonical ${label} provenance survives serialization and reaches points-to`, () => {
    const summary = valid({ returnProvenance: [row] });
    assert.equal(summaryIdentityMatches(summary, identity), true);
    assert.equal(summaryIdentityMatches(JSON.parse(JSON.stringify(summary)), identity), true);
    assert.equal(pointsTo(summary).top, false);
  });
}
for (const offset of [0, 0n, '-8', -8n, '0x1000', 9007199254740993n]) {
  test(`#4314: exact constructor offset ${String(offset)} retains its integer value`, () => {
    const summary = valid({ returnProvenance: [{ kind: 'arg', argIndex: 0, offset }] });
    assert.equal(summary.returnProvenance[0].offset, BigInt(offset).toString());
    assert.equal(summaryIdentityMatches(summary, identity), true);
  });
}

for (const field of ['memoryReadRegions', 'memoryWriteRegions']) {
  for (const [label, value] of [['null', null], ['boolean', false], ['string', 'effect'], ['array', []], ['empty', {}],
    ['nonboolean broad', { regionId: 'r', broad: 'false' }], ['bad id', { regionId: ['r'] }],
    ['bad source', { regionId: 'r', source: 'unsupported-source' }], ['bad spaces', { regionId: 'r', addressSpaces: [false] }],
    ['bad evidence', { regionId: 'r', evidenceIds: [{}] }]]) {
    test(`#4320: ${field}/${label} cannot be consumed as a resolved callee effect`, () => {
      const raw = copy(); raw[field] = [value];
      assert.equal(summaryIdentityMatches(raw, identity), false);
      assert.throws(() => createFunctionSummary(raw), TypeError);
      const summary = fold(raw);
      assert.equal(summary.status.completeness, 'partial');
      assert.equal(summaryIsPure(summary), false);
      assert.equal(summaryMayWriteRegion(summary, 'other-region'), true);
      assert.ok(summary.unknownCallEffects.some((e) => e.reason === 'summary-stale'));
    });
  }
}
for (const [name, mutate] of [
  ['direct call element', (s) => { s.directCalls = [null]; }],
  ['indirect call element', (s) => { s.indirectCallSets = [false]; }],
  ['indirect exhaustive', (s) => { s.indirectCallSets = [{ callSiteId: 'site', candidateEntityIds: ['callee'], exhaustive: 'true' }]; }],
  ['unknown call element', (s) => { s.unknownCallEffects = [null]; }],
  ['bad noreturn', (s) => { s.noreturn = 'false'; }],
  ['bad mayThrow', (s) => { s.mayThrow = []; }],
  ['invalid status', (s) => { s.status.completeness = 'completee'; }],
  ['complete but stopped', (s) => { s.status.stopReason = 'budget-exhausted'; }],
  ['partial without reason', (s) => { s.status.completeness = 'partial'; }],
  ['structured status ID', (s) => { s.status.snapshotId = [snapshotId]; }],
  ['missing write set', (s) => { delete s.memoryWriteRegions; }],
  ['sparse write set', (s) => { s.memoryWriteRegions = new Array(1); }],
  ['sparse provenance', (s) => { s.returnProvenance = new Array(1); }],
  ['noncanonical ID', (s) => { s.inputs = [['arg']]; }],
  ['unresolved region', (s) => { s.memoryWriteRegions = [{ regionId:null, regionKind:'unknown', broad:false, addressSpaces:[], source:'proven-summary', evidenceIds:[] }]; }],
]) {
  test(`#4320: serialized ${name} cannot prove absence of caller writes`, () => {
    const raw = copy(); mutate(raw);
    assert.equal(summaryIdentityMatches(raw, identity), false);
    assert.equal(summaryMayWriteRegion(fold(raw), 'any-region'), true);
  });
}
test('#4320: canonical specific writes remain specific and pure callees remain pure', async () => {
  // #7467 made summaryMayWriteRegion region-aware: a specific write answers
  // by canonical region identity (a bare string id no longer matches, and an
  // under-described region cannot prove absence of writes). Build the region
  // proof the canonical producer would attach.
  const { deriveMemoryRegion, isPreciseMemoryRegion } = await awaitImportRegions();
  const region = deriveMemoryRegion({
    functionId: null, binaryId: 'binary-summary-boundary', widthBits: 64,
    addressSpace: null, origin: { instructionIds: ['instruction_r'] },
    regionEvidence: { kind: 'rooted-offset', rootEntityId: 'r-root', offset: '0' },
  });
  assert.ok(isPreciseMemoryRegion(region), 'fixture region must be precise');
  const other = deriveMemoryRegion({
    functionId: null, binaryId: 'binary-summary-boundary', widthBits: 64,
    addressSpace: null, origin: { instructionIds: ['instruction_other'] },
    regionEvidence: { kind: 'rooted-offset', rootEntityId: 'r-root', offset: '4096' },
  });
  assert.ok(isPreciseMemoryRegion(other), 'fixture query region must be precise');
  const specific = valid({ memoryWriteRegions: [{
    regionId: region.id, regionKind: 'rooted-offset', region,
  }] });
  const summary = fold(specific);
  assert.equal(summary.status.completeness, 'complete');
  assert.equal(summaryMayWriteRegion(summary, 'r'), true,
    'the summary still names region r via its canonical region id');
  assert.equal(summaryMayWriteRegion(summary, region), true);
  assert.equal(summaryMayWriteRegion(summary, 'other'), true,
    'a bare string id cannot prove absence (conservative floor), id match or may-write');
  assert.equal(summaryMayWriteRegion(summary, other), false,
    'a precise disjoint region query proves the write is specific');
  assert.equal(summaryIsPure(fold(valid())), true);
});
test('#4320: a mutable serialized summary is revalidated without being frozen or cached', () => {
  const raw = copy(); raw.escapes = [{ kind: 'fixture', details: { value: 1 } }];
  assert.equal(summaryIdentityMatches(raw, identity), true);
  assert.equal(Object.isFrozen(raw), false);
  assert.equal(Object.isFrozen(raw.escapes), false);
  assert.equal(Object.isFrozen(raw.escapes[0].details), false);
  raw.memoryWriteRegions.push(null);
  assert.equal(summaryIdentityMatches(raw, identity), false);
});
test('#4320: metadata cannot add unvalidated pointer authority to a serialized return row', () => {
  const raw = copy(valid({ returnProvenance: [{ kind: 'root', rootEntityId: 'r', addressSpace: 'memory' }] }));
  raw.returnProvenance[0].addressSpace = ['io'];
  assert.equal(summaryIdentityMatches(raw, identity), false);
  assert.equal(pointsTo(raw).top, true);
});

for (const [name, mutate] of [
  ['invalid effect', (s) => { s.memoryWriteRegions = [null]; }],
  ['stopped complete status', (s) => { s.status.stopReason = 'cancelled'; }],
  ['unknown call with complete status', (s) => {
    s.unknownCallEffects = [{ callSiteId: 'unknown', reason: 'unresolved-target', targetEntityIds: [], evidenceIds: [] }];
  }],
]) {
  test(`#4320: public summary predicates reject ${name} instead of throwing or proving purity`, () => {
    const raw = copy(); mutate(raw);
    assert.equal(summaryIsPure(raw), false);
    assert.equal(summaryMayWriteRegion(raw, 'any-region'), true);
  });
}
test('#4320: valid partial summaries match identity without becoming complete or pure', () => {
  const partial = valid({ status: { ...status, completeness: 'partial', stopReason: 'evidence-missing' } });
  assert.equal(summaryIdentityMatches(partial, identity), true);
  assert.equal(summaryIdentityMatches(copy(partial), identity), true);
  assert.equal(summaryIsPure(partial), false);
  assert.equal(summaryMayWriteRegion(partial, 'any'), true);
});

test('#4320: pre-hardening serialized summary contracts are not current evidence', () => {
  const old = copy(); old.contractVersion = '1.1.0';
  assert.equal(summaryIdentityMatches(old, identity), false);
  assert.equal(summaryIsPure(old), false);
  assert.equal(summaryMayWriteRegion(fold(old), 'any'), true);
});
