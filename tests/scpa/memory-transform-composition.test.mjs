import test from 'node:test';
import assert from 'node:assert/strict';
import { checkMemoryTransformRelation, normalizeMemoryTransformProgram, MEMORY_TRANSFORM_PROGRAM_SCHEMA } from '../../js/core/evidence/memory-transform-proof.js';
import { projectScopedTransformOwners } from '../../js/analysis/scoped-transform-projection.js';
import { captureCanonicalMemoryTransforms } from '../../js/analysis/scoped-memory-transform-projection.js';
import { explainNativeTransformProjection } from '../../js/core/evidence/native-transform.js';
import { normalizeTransformReceipt, explainTransformChain } from '../../js/core/evidence/transform-chain.js';
import { CertificateCheckerRegistry } from '../../js/core/evidence/certificate.js';
import { captured } from './native-owner-fixture.mjs';
import { nativeWorkerFixture } from './native-worker-fixture.mjs';
import { fixture, workFor } from './helpers.mjs';

const binding = { worldId: 'w', snapshotId: 's', functionId: 'f' };
const fx = (extra = {}) => ({ volatile: false, atomic: false, ordering: 'none', faults: [], exceptionTargets: [], addressSpace: 'memory', ...extra });
const lanes = (valueId, count) => Array.from({ length: count }, (_, index) => ({ valueId, index }));
function access(kind, id, start, bytes, more = {}) {
  return { kind, id, sourceEntityId: `source:${id}`, range: { domain: 'canonical-stack', start: String(start), bytes },
    endian: 'little', effects: fx(), reachingDefinitions: ['entry'], ...more };
}
const assign = (id, target, value) => ({ id, kind: 'copy', target, value });
const program = (operations, inputs = [], outputs = ['out']) => ({ schema: MEMORY_TRANSFORM_PROGRAM_SCHEMA,
  ...binding, ownerDigest: 'canonical-mssa:1', inputs, operations, outputs, unknowns: [],
  control: 'linear-normal-exit-with-fault-prefixes', concurrency: 'single-thread-no-unmodeled-writers' });
function overlap(width = 2, endian = 'little', offset = 1) {
  const input = [{ id: 'a', bytes: width }, { id: 'patch', bytes: 1 }];
  const store = access('write', 'store', 0, width, { endian, value: lanes('a', width) });
  const patch = access('write', 'patch', offset, 1, { value: lanes('patch', 1) });
  const read = access('read', 'load', 0, width, { endian, target: 'out' });
  const bytes = lanes('a', width); bytes[endian === 'little' ? offset : width - 1 - offset] = { valueId: 'patch', index: 0 };
  return [program([store, patch, read], input), structuredClone(program([store, patch, { ...read, target: null }, assign('forward', 'out', bytes)], input))];
}

// Separate finite reference: concrete Uint8Array writes/readback. It imports no
// checker, MemorySSA forwarding, symbolic engine or transform implementation.
function reference(p, inputs, seed = 0) {
  const memory = Uint8Array.from({ length: 64 }, (_, i) => (i * 19 + seed) & 255), values = new Map(Object.entries(inputs));
  const data = xs => xs.map(x => typeof x === 'number' ? x : values.get(x.valueId)[x.index]);
  for (const op of p.operations) {
    if (op.kind === 'copy') { values.set(op.target, data(op.value)); continue; }
    const index = Number(op.range.start) + 16;
    if (op.kind === 'write') {
      const bytes = data(op.value); if (op.endian === 'big') bytes.reverse(); memory.set(bytes, index);
    } else if (op.kind === 'read' && op.target !== null) {
      const bytes = [...memory.slice(index, index + op.range.bytes)]; if (op.endian === 'big') bytes.reverse(); values.set(op.target, bytes);
    } else if (op.kind !== 'read') throw new Error('reference-unsupported-operation');
  }
  return { memory: [...memory], outputs: p.outputs.map(id => values.get(id)) };
}

test('partial overlapping stores compose into actual changed value projections at every supported width/endian', t => {
  for (const width of [1, 2, 4, 8, 16]) for (const endian of ['little', 'big']) for (const offset of [...new Set([0, width - 1, Math.floor(width / 2)])]) {
    const [before, after] = overlap(width, endian, offset);
    const result = checkMemoryTransformRelation(before, after, { ...binding, work: workFor(t) });
    assert.equal(result.status, 'verified'); assert.equal(result.valueProjectionChanged, true);
    assert.equal(result.memoryOptimization, false); assert.equal(result.memoryAccessEliminated, false);
    assert.notEqual(result.beforeId, result.afterId);
    for (const seed of [0, 1, 19, 128, 255]) {
      const input = { a: Array.from({ length: width }, (_, i) => (seed * (i + 3) + i) & 255), patch: [255 - seed] };
      assert.deepEqual(reference(before, input, seed), reference(after, input, seed));
    }
  }
});
test('finite independent two-byte reference checks all 65536 byte-pair assignments', () => {
  const [before, after] = overlap();
  assert.equal(checkMemoryTransformRelation(before, after, binding).status, 'verified');
  for (let x = 0; x < 256; x++) for (let y = 0; y < 256; y++) {
    const input = { a: [x, 255 - x], patch: [y] };
    assert.deepEqual(reference(before, input), reference(after, input));
  }
});
for (const [name, mutation] of Object.entries({
  'partial-store-byte': p => { p.operations.at(-1).value[1] = { valueId: 'a', index: 1 }; },
  'source-lane': p => { p.operations.at(-1).value[0] = { valueId: 'patch', index: 0 }; },
  'byte-offset': p => { p.operations[1].range.start = '0'; },
  'endian': p => { p.operations[0].endian = 'big'; },
  'fault': p => { p.operations[2].effects.faults = [{ kind: 'data-abort' }]; },
  'exception-edge': p => { p.operations[2].effects.exceptionTargets = ['handler']; },
  'reaching-def': p => { p.operations[2].reachingDefinitions = ['forged']; },
  'source-binding': p => { p.operations[2].sourceEntityId = 'other-load'; },
  'order': p => { [p.operations[0], p.operations[1]] = [p.operations[1], p.operations[0]]; },
})) test(`retained-event value proof refuses ${name} mutant`, () => {
  const [before, after] = structuredClone(overlap()); mutation(after);
  assert.equal(checkMemoryTransformRelation(before, after, binding).status, 'rejected');
});
test('faulting accesses can retain their exact events while forwarding an ordinary memory value', () => {
  const [before, after] = structuredClone(overlap());
  for (const p of [before, after]) for (const op of p.operations) if (op.range) op.effects = fx({ faults: [{ kind: 'data-abort', condition: 'translation' }], exceptionTargets: ['fault-exit'] });
  const result = checkMemoryTransformRelation(before, after, binding);
  assert.equal(result.status, 'verified'); assert.equal(result.preservedEvents, 3);
  after.operations[0].value = [4, 5];
  assert.equal(checkMemoryTransformRelation(before, after, binding).status, 'rejected', 'equal later memory must not hide a changed fault prefix');
});
for (const key of ['volatile', 'atomic']) test(`${key} load values cannot be replaced by a previous ordinary byte value`, () => {
  const [before, after] = structuredClone(overlap());
  for (const p of [before, after]) p.operations[2].effects[key] = true;
  assert.equal(checkMemoryTransformRelation(before, after, binding).reason, 'memory-transform-outputs-changed');
});
test('a finite unchanged clobber is framed only when its bytes do not alter the forwarded value', () => {
  const [before, after] = structuredClone(overlap());
  const clobber = access('clobber', 'opaque-write', 10, 1);
  for (const p of [before, after]) p.operations.splice(2, 0, structuredClone(clobber));
  assert.equal(checkMemoryTransformRelation(before, after, binding).status, 'verified');
  for (const p of [before, after]) p.operations[2].range.start = '0';
  assert.equal(checkMemoryTransformRelation(before, after, binding).status, 'rejected');
});
test('general access elimination stays with the existing symbolic equivalence owner', () => {
  const [before, after] = structuredClone(overlap()); after.operations.splice(2, 1);
  assert.equal(checkMemoryTransformRelation(before, after, binding).reason, 'memory-access-rewrite-owned-by-symbolic-verifier');
});
for (const [name, mutate] of [
  ['unknown clobber', p => { p.operations[0].kind = 'unknown-clobber'; }],
  ['loop', p => { p.control = 'loop'; }],
  ['concurrency', p => { p.concurrency = 'unknown'; }],
  ['open premise', p => { p.unknowns = ['alias-not-proved']; }],
]) test(`${name} stays unknown instead of becoming an equivalent program`, () => {
  const [before, after] = structuredClone(overlap()); mutate(after);
  assert.equal(checkMemoryTransformRelation(before, after, binding).status, 'unknown');
});
test('malformed DTOs, detached byte IDs and spent budgets never produce proof', t => {
  const [before, after] = structuredClone(overlap());
  const normalized = normalizeMemoryTransformProgram(before);
  assert.throws(() => normalizeMemoryTransformProgram({ ...normalized, ownerDigest: 'other' }), /id-mismatch/);
  after.operations.at(-1).value[0].valueId = 'missing';
  assert.equal(checkMemoryTransformRelation(before, after, binding).status, 'unknown');
  assert.throws(() => checkMemoryTransformRelation(...overlap(), { ...binding, work: workFor(t, { workUnits: 0 }) }), e => e.code === 'budget-exhausted');
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => normalizeMemoryTransformProgram(cycle));
});

test('two real byte-value derivations compose through the existing receipt DAG and reject a detached endpoint', async t => {
  const f = fixture();
  const [original, forwarded] = structuredClone(overlap());
  original.operations[2].target = 'first'; original.operations.push(access('read', 'last-load', 0, 2, { target: 'out' }));
  const intermediate = structuredClone(original);
  intermediate.operations.splice(2, 1, { ...intermediate.operations[2], target: null }, assign('first-value', 'first', forwarded.operations.at(-1).value));
  const last = structuredClone(intermediate);
  last.operations.splice(4, 1, { ...last.operations[4], target: null }, assign('last-value', 'out', forwarded.operations.at(-1).value));
  const programs = [original, intermediate, last].map(p => normalizeMemoryTransformProgram({ ...p, worldId: f.world.id, outputs: ['first', 'out'] }));
  const fragment = p => ({ artifactId: 'artifact', ownerDigest: p.id, semanticIrVersion: p.schema, entityIds: p.outputs, byteRangeIds: [] });
  const observable = { inputBindings: ['a', 'patch'], outputs: ['first', 'out'], memoryFootprint: 'whole-canonical-stack-footprint',
    eventModel: 'all-canonical-accesses-retained', faults: 'every-fault-prefix', termination: 'preserve', fpEnvironment: 'none',
    concurrencyModel: 'single-thread-no-unmodeled-writers' };
  const receipts = [], pairs = new Map();
  for (let i = 0; i < 2; i++) {
    const receipt = normalizeTransformReceipt({ schema: 'scoped-transform-receipt/v1', worldId: f.world.id,
      assumptionsId: f.assumptions.id, binaryId: f.world.binarySet[0].binaryId, functionId: 'f', snapshotId: 's',
      before: fragment(programs[i]), after: fragment(programs[i + 1]), ruleId: 'scoped-linear-byte-memory', ruleVersion: '1.0.0',
      ownerVersion: 'test-canonical-projection', observable, claim: 'equivalent', sourceReceipts: i ? [receipts[0].id] : [],
      obligations: [], queryHash: null, evidenceId: null }, { ...f, snapshotId: 's', functionId: 'f' });
    receipts.push(receipt); pairs.set(receipt.id, [programs[i], programs[i + 1]]);
  }
  const registry = new CertificateCheckerRegistry();
  registry.register({ id: 'test-independent-byte-receipt', version: '1', semanticKind: 'decompiler-transform',
    level: 'derivation-checked', execution: 'local-bounded', check: n => ({
      ...checkMemoryTransformRelation(...pairs.get(n.id), { ...binding, worldId: f.world.id }),
      worldId: f.world.id, assumptionsId: f.assumptions.id, nodeId: n.id, propositionChecked: true }) });
  const run = steps => explainTransformChain({ functionId: 'f', stepIds: steps.map(r => r.id), includePremises: true }, {
    ...f, snapshotId: 's', work: workFor(t), checkers: registry,
    resolveReceipt: id => { const data = steps.find(r => r.id === id); return data ? { data, isCurrent: () => true } : null; } });
  const result = await run(receipts);
  assert.equal(result.status, 'conditionally-verified'); assert.equal(result.checks.length, 2);
  assert.equal(result.checks.every(r => r.status === 'verified'), true);
  const { id: ignored, ...lastReceipt } = receipts[1];
  const disconnected = normalizeTransformReceipt({ ...lastReceipt, before: fragment(programs[0]) }, { ...f, snapshotId: 's', functionId: 'f' });
  pairs.set(disconnected.id, pairs.get(receipts[1].id));
  const bad = await run([receipts[0], disconnected]);
  assert.equal(bad.status, 'unknown'); assert.ok(bad.remaining.includes('transform-fragment-chain-disconnected'));
});

const NATIVE = [['mov', 'x0, #7', 0xd28000e0], ['str', 'x0, [sp]', 0xf90003e0], ['ldr', 'x0, [sp]', 0xf94003e0], ['ret', '', 0xd65f03c0]];
async function native(t) {
  const f = fixture(d => { d.profile.abiRevision = '2'; d.environment.concurrency = 'single-thread'; });
  const { owner, result } = captured(0x1000n, NATIVE);
  const request = { kind: 'transforms', ...f, worldId: f.world.id, snapshotId: 'snap', producerArtifactId: 'artifact' };
  const view = await projectScopedTransformOwners(owner, result, request, { limits: { deadlineMs: 10000 } });
  const context = { ...f, snapshotId: 'snap', functionId: owner.pipeline.functionId, producerArtifactId: 'artifact', isCurrent: () => true, work: workFor(t) };
  return { owner, view, context };
}
test('real canonical MemorySSA -> final native statement -> independent receipt composition keeps fault events', async t => {
  const { owner, view, context } = await native(t);
  assert.equal(view.memoryTransforms.steps.length, 1);
  const step = view.memoryTransforms.steps[0];
  assert.equal(step.sourceReceipt.proofKind, 'canonical-memoryssa-byte-forwarding');
  assert.equal(step.sourceReceipt.artifactDigest, owner.pipeline.memorySsa.canonicalDigest);
  assert.notEqual(step.before.id, step.after.id);
  assert.ok(step.before.operations.some(op => op.effects?.faults.length));
  assert.match(view.finalStatements[step.statementIndices[0]].text, /return 7/);
  const explanation = await explainNativeTransformProjection(view, context);
  assert.equal(explanation.verifiedMemoryTransformCount, 1);
  assert.equal(explanation.memoryTransforms.chain.status, 'conditionally-verified');
  assert.equal(explanation.memoryTransforms.chain.minimumCheck, 'derivation-checked');
  assert.equal(explanation.memoryTransforms.renderedEventPreservation, 'unproved');
  assert.equal(explanation.memoryTransforms.wholeFunctionProof, false);
});
test('native forged receipt owner, final statement and forwarded byte never pass composition', async t => {
  const { view, context } = await native(t);
  for (const mutation of [
    v => { v.memoryTransforms.steps[0].sourceReceipt.artifactDigest = 'forged'; },
    v => { v.memoryTransforms.steps[0].sourceReceipt.value = 8n; },
    v => { v.finalStatements[v.memoryTransforms.steps[0].statementIndices[0]].text = 'return 8;'; },
    v => { const after = v.memoryTransforms.steps[0].after; delete after.id; after.operations.at(-1).value[0] = 8; },
  ]) {
    const mutant = structuredClone(view); mutation(mutant);
    const result = await explainNativeTransformProjection(mutant, context);
    assert.equal(result.verifiedMemoryTransformCount, 0); assert.equal(result.memoryTransforms.chain.status, 'rejected');
  }
});
test('serialized MemorySSA data cannot mint a native canonical forwarding capture', async t => {
  const { owner, context } = await native(t);
  const result = captureCanonicalMemoryTransforms({ ...owner.pipeline, memorySsa: structuredClone(owner.pipeline.memorySsa) },
    { cAst: { body: [] } }, { worldId: context.world.id, snapshotId: 'snap', concurrency: 'single-thread', work: workFor(t) });
  assert.deepEqual(result.steps, []); assert.deepEqual(result.remaining, ['memory-transform-canonical-owner-unbound']);
});
test('actual worker default unknown concurrency never silently acquires a single-thread assumption', async t => {
  const f = await nativeWorkerFixture(t, { rowsByLocator: { '0x1000': NATIVE } });
  const result = await f.invoke('explainTransformChain', { functionId: '0x1000' });
  assert.equal(result.verifiedMemoryTransformCount, 0);
  assert.equal(result.memoryTransforms.chain.status, 'unknown');
  assert.ok(result.memoryTransforms.remaining.includes('memory-transform-concurrency-not-qualified'));
  assert.equal(result.releaseQualified, false);
});
