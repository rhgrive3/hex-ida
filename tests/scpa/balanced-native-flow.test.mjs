// Real ARM64 instructions use the public canonical pipeline and native port
// producer. These tests assert possible relations, never executable paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import { captured, scope, request, callee } from './native-owner-fixture.mjs';
import { workFor } from './helpers.mjs';
import { projectScopedFlowInputs, bindScopedFlowInputs } from '../../js/analysis/scoped-flow-projection.js';
import { buildCanonicalQueryProjection } from '../../js/analysis/query/semantic/projection.js';
import { ScopedInterproceduralProjectionBuilder } from '../../js/analysis/query/semantic/interprocedural.js';
import { compileSemanticQuery } from '../../js/analysis/query/semantic/plan.js';
import { SemanticQueryExecution } from '../../js/analysis/query/semantic/execute.js';

async function nativeScope(t, calleeRows = callee) {
  const f = scope(), work = workFor(t), loaded = new Map();
  const unary = { returnType: 'int64', parameters: [{ type: 'int64', bits: 64 }] };
  const inputs = { caller: captured(undefined, undefined,
    { functionPrototype: { returnType: 'int64', parameters: [] }, callPrototype: unary }),
  callee: captured(0x2000n, calleeRows, { functionPrototype: unary }) };
  const builder = new ScopedInterproceduralProjectionBuilder({ ...f, snapshotId: 'snap',
    functionIds: ['caller', 'callee'], isCurrent: () => true, loadProjection: async locator => {
      const input = inputs[locator], raw = await projectScopedFlowInputs(input.owner, input.result, request(f), { work });
      assert.equal(raw.status, 'completed', raw.reason);
      const projection = await buildCanonicalQueryProjection(input.result.pipeline, { ...f, snapshotId: 'snap', work,
        producerArtifactId: 'native-balanced-' + locator,
        sourceLocation: { start: input.base, end: input.base + BigInt(input.rows.length * 4), snapshotId: 'snap' } });
      const ports = bindScopedFlowInputs(raw.inputs, projection, { ...f, snapshotId: 'snap' });
      const result = { projection, nativeFlowInputs: raw.inputs, ports, functionId: projection.functionId };
      loaded.set(locator, result); return result;
    } });
  t.after(() => builder.close());
  await builder.advance({ work }); await builder.advance({ work });
  const composed = await builder.advance({ work });
  return { f, composed, caller: loaded.get('caller'), callee: loaded.get('callee') };
}

async function follow(t, fixture, source, target, via, flowKinds) {
  const plan = compileSemanticQuery({ scope: { functionIds: ['caller', 'callee'] },
    select: { op: 'eq', field: 'id', value: source }, flow: {
      to: { op: 'eq', field: 'id', value: target }, via: [{ op: 'eq', field: 'id', value: via }],
      edgeKinds: ['call-summary', 'ssa-use-def', 'operation-input', 'operation-output'],
      flowKinds, maxDepth: 32, maxCallDepth: 2,
    } }, fixture.f);
  const e = new SemanticQueryExecution({ ...fixture.f, plan, isCurrent: () => true,
    loadProjection: () => fixture.composed });
  t.after(() => e.close());
  return e.step({ limits: { deadlineMs: 10000 } });
}

test('actual declared ARM64 x0 arguments return through the same canonical callsite', async t => {
  const fixture = await nativeScope(t), call = fixture.caller.ports.calls[0];
  assert.equal(call.arguments.length, 1); assert.equal(call.returns.length, 1);
  assert.equal(fixture.callee.ports.returns.length, 1);
  const result = await follow(t, fixture, call.arguments[0].references[0], call.returns[0].references[0],
    fixture.callee.ports.parameters[0].references[0], ['data']);
  assert.equal(result.results.length, 1, JSON.stringify(result.frontier));
  const path = result.results[0], boundaries = path.edges.filter(edge => edge.boundary);
  assert.deepEqual(boundaries.map(edge => edge.boundary.direction), ['enter', 'return']);
  assert.equal(boundaries[0].boundary.callSite, boundaries[1].boundary.callSite);
  assert.equal(boundaries[1].witness.owner, 'existing-canonical-abi-return-ports');
  assert.deepEqual(path.callContext.pendingCalls, []);
  assert.equal(path.exact, false); assert.equal(path.executablePathProven, false);
  assert.equal(result.flowClosure.semanticAbsenceProven, false);
});

test('actual MemorySSA call use, entry, exit and unknown clobber ports form a balanced may-flow', async t => {
  const fixture = await nativeScope(t, [['ldr', 'x2, [x0]', 0xf9400002], ['ret', '', 0xd65f03c0]]);
  const call = fixture.caller.ports.memory.calls[0];
  assert.ok(call.inputs.length); assert.ok(call.outputs.length);
  const entry = fixture.callee.ports.memory.entries.find(port => fixture.callee.ports.memory.exits
    .some(exit => exit.definitionId === port.definitionId));
  assert.ok(entry, 'canonical unchanged entry state reaches a return block exit');
  const result = await follow(t, fixture, call.inputs[0].references[0], call.outputs[0].references[0], entry.references[0], ['memory']);
  assert.equal(result.results.length, 1, JSON.stringify(result.frontier));
  const path = result.results[0], boundaries = path.edges.filter(edge => edge.boundary);
  assert.deepEqual(boundaries.map(edge => edge.boundary.direction), ['enter', 'return']);
  assert.ok(boundaries.every(edge => edge.witness.owner === 'existing-canonical-memoryssa-ports'));
  assert.equal(boundaries[0].boundary.callSite, boundaries[1].boundary.callSite);
  assert.ok(call.outputs.some(port => port.canonicalKind.includes('clobber')));
  assert.ok(path.remaining.includes('cross-frame-memory-alias-and-byte-coverage-unqualified'));
  assert.equal(path.exact, false); assert.equal(path.executablePathProven, false);
});

test('default native navigation retains a stored pointer later used as a load address', async t => {
  const f = scope(), input = captured(0x4000n, [['str', 'x0, [sp]', 0xf90003e0],
    ['ldr', 'x2, [sp]', 0xf94003e2], ['ldr', 'x3, [x2]', 0xf9400043], ['ret', '', 0xd65f03c0]]);
  const build = () => buildCanonicalQueryProjection(input.result.pipeline, { ...f, snapshotId: 'snap', work: workFor(t) });
  const initial = await build();
  const store = input.result.pipeline.semanticIr.nodes.find(node => node.kind === 'store');
  const sink = input.result.pipeline.semanticIr.nodes.filter(node => node.kind === 'load').at(-1);
  const source = initial.adjacent(initial.entityReference('semantic-ir', store.id), 'backward').map(id => initial.edge(id))
    .find(edge => edge.kind === 'operation-input' && edge.flowKinds?.includes('data')).from;
  const target = initial.entityReference('semantic-ir', sink.id);
  const addressUse = initial.adjacent(target, 'backward').map(id => initial.edge(id))
    .find(edge => edge.kind === 'operation-input' && edge.flowKinds?.includes('address')).from;
  initial.release();
  for (const [flowKinds, reached] of [[null, true], [['data'], false], [['address'], false]]) {
    const plan = compileSemanticQuery({ scope: { functionIds: ['pointer-store-load'] },
      select: { op: 'eq', field: 'id', value: source }, flow: { to: { op: 'eq', field: 'id', value: target },
        via: [{ op: 'eq', field: 'id', value: addressUse }], flowKinds, maxDepth: 64,
        edgeKinds: ['operation-input', 'operation-output', 'ssa-use-def', 'ssa-phi',
          'memory-input', 'memory-output', 'memory-reaching', 'memory-merge'] } }, f);
    const e = new SemanticQueryExecution({ ...f, plan, isCurrent: () => true, loadProjection: async () => ({ projection: await build() }) });
    t.after(() => e.close()); const answer = await e.step({ limits: { deadlineMs: 10000 } });
    assert.equal(answer.results.length > 0, reached, JSON.stringify({ flowKinds, frontier: answer.frontier }));
    if (reached) {
      assert.equal(answer.results[0].flowKindPolicy, 'mixed-dependence-navigation');
      const typed = answer.results[0].edges.flatMap(edge => edge.flowKinds ?? []);
      assert.ok(typed.includes('data')); assert.ok(typed.includes('address'));
    }
    assert.equal(answer.flowClosure.semanticAbsenceProven, false);
  }
});
