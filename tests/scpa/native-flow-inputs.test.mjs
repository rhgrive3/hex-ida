import test from 'node:test';
import assert from 'node:assert/strict';
import { projectScopedFlowInputs, bindScopedFlowInputs } from '../../js/analysis/scoped-flow-projection.js';
import { buildCanonicalQueryProjection } from '../../js/analysis/query/semantic/projection.js';
import { ScopedInterproceduralProjectionBuilder } from '../../js/analysis/query/semantic/interprocedural.js';
import { compileSemanticQuery } from '../../js/analysis/query/semantic/plan.js';
import { SemanticQueryExecution } from '../../js/analysis/query/semantic/execute.js';
import { captured, scope, request, callee } from './native-owner-fixture.mjs';
import { fixture, workFor } from './helpers.mjs';

async function load(t, f, input) {
  const raw = await projectScopedFlowInputs(input.owner, input.result, request(f), { limits: { deadlineMs: 10000 } });
  assert.equal(raw.status, 'completed', raw.reason);
  const projection = await buildCanonicalQueryProjection(input.result.pipeline, { ...f, snapshotId: 'snap', work: workFor(t),
    producerArtifactId: 'artifact-' + input.base, sourceLocation: { start: input.base, end: input.base + BigInt(input.rows.length * 4), snapshotId: 'snap' } });
  t.after(() => projection.release());
  return { projection, nativeFlowInputs: raw.inputs, raw };
}

test('native input projection uses actual dominance-bound scalar ABI inputs, not guessed x0..x7', async t => {
  const f = scope(), loaded = await load(t, f, captured());
  const bound = bindScopedFlowInputs(loaded.nativeFlowInputs, loaded.projection, { ...f, snapshotId: 'snap' });
  assert.equal(bound.calls.length, 1);
  assert.deepEqual(bound.calls[0].arguments.map(a => a.register), ['x0']);
  assert.equal(bound.calls[0].arguments[0].canonicalKind, 'definition');
  assert.equal(bound.exact, false);
  assert.ok(bound.remaining.includes('abi-prototype-and-arity-unqualified'));
  assert.equal(bound.abiRevision, '2');
});
test('callee consumed x0 input stays canonical implicit-undef; sp and x30 are not arguments', async t => {
  const f = scope(), loaded = await load(t, f, captured(0x2000n, callee));
  const bound = bindScopedFlowInputs(loaded.nativeFlowInputs, loaded.projection, { ...f, snapshotId: 'snap' });
  assert.deepEqual(bound.parameters.map(a => a.register), ['x0']);
  assert.equal(bound.parameters[0].canonicalKind, 'undef');
  assert.equal(loaded.projection.source(bound.parameters[0].references[0]).proof.kind, 'implicit-undef');
  assert.equal(bound.calls.length, 0);
  assert.ok(Object.isFrozen(bound));
});
test('uncaptured, copied and wrong-snapshot worker owners cannot publish native ports', async () => {
  const f = scope(), input = captured();
  for (const owner of [null, { ...input.owner, snapshotId: 'later' },
    { ...input.owner, pipeline: { ...input.owner.pipeline, semanticIr: structuredClone(input.owner.pipeline.semanticIr) } }]) {
    const result = await projectScopedFlowInputs(owner, input.result, request(f));
    assert.equal(result.status, 'unsupported'); assert.equal(result.inputs, undefined);
  }
});
test('a different ABI revision is not silently translated into the current ABI', async () => {
  const f = fixture(), input = captured();
  const result = await projectScopedFlowInputs(input.owner, input.result, request(f));
  assert.equal(result.status, 'unsupported');
});
test('native input source binding rejects changes to identity, width, definition and register', async t => {
  const f = scope(), loaded = await load(t, f, captured(0x2000n, callee));
  const mutations = [v => { v.worldId = 'other'; }, v => { v.snapshotId = 'later'; }, v => { v.functionId = 'other'; },
    v => { v.abiRevision = '99'; }, v => { v.exact = true; }, v => { v.parameters[0].widthBits = 32; },
    v => { v.parameters[0].register = 'sp'; }, v => { v.parameters[0].definitionId = 'other'; },
    v => { v.parameters[0].valueId = 'other'; }, v => { v.parameters[0].canonicalKind = 'entry'; },
    v => { v.parameters[0].classification.kind = 'incoming-register-state'; }];
  for (const mutate of mutations) {
    const raw = structuredClone(loaded.nativeFlowInputs); mutate(raw);
    assert.throws(() => bindScopedFlowInputs(raw, loaded.projection, { ...f, snapshotId: 'snap' }));
  }
});
test('native port worker honours cancellation and finite work budget', async () => {
  const f = scope(), input = captured(), abort = new AbortController(); abort.abort();
  await assert.rejects(projectScopedFlowInputs(input.owner, input.result, request(f), { signal: abort.signal }));
  await assert.rejects(projectScopedFlowInputs(input.owner, input.result, request(f), { limits: { workUnits: 1 } }));
});

test('two real canonical functions expose a source-bound possible argument flow through a literal call', async t => {
  const f = scope(), loaded = new Map();
  const b = new ScopedInterproceduralProjectionBuilder({ ...f, snapshotId: 'snap', functionIds: ['caller', 'callee'], isCurrent: () => true,
    loadProjection: async id => { const value = await load(t, f, id === 'caller' ? captured() : captured(0x2000n, callee)); loaded.set(id, value); return value; } });
  t.after(() => b.close());
  const work = workFor(t);
  await b.advance({ work }); await b.advance({ work });
  // Bind references before the composite intentionally releases temporary maps.
  const a = loaded.get('caller'), c = loaded.get('callee');
  const source = a.projection.entityReference('ssa', a.nativeFlowInputs.calls[0].arguments[0].definitionId);
  const target = c.projection.entityReference('ssa', c.nativeFlowInputs.parameters[0].definitionId);
  const composed = await b.advance({ work });
  const plan = compileSemanticQuery({ scope: { functionIds: ['caller', 'callee'] }, select: { op: 'eq', field: 'id', value: source },
    flow: { to: { op: 'eq', field: 'id', value: target }, edgeKinds: ['call-summary'], maxDepth: 4 } }, f);
  const execution = new SemanticQueryExecution({ ...f, plan, isCurrent: () => true, loadProjection: () => ({ projection: composed.projection }) });
  t.after(() => execution.close());
  const answer = await execution.step({ limits: { deadlineMs: 10000 } });
  assert.equal(answer.results.length, 1, JSON.stringify(answer));
  assert.equal(answer.results[0].executablePathProven, false);
  assert.match(JSON.stringify(answer), /native-abi-inputs-only-return-and-memory-ports-open/);
  assert.equal(answer.results[0].edges[0].witness.owner, 'existing-abi-and-compat-register-inputs');
});
