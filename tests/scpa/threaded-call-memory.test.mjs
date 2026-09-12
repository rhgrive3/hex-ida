import test from 'node:test';
import assert from 'node:assert/strict';
import { threadedNativeFixture } from './threaded-native-fixture.mjs';

const functionIds = ['0x1000', '0x102c', '0x1034'];
const fixture = t => threadedNativeFixture(t, { fixture: 'threaded-call-memory' });
async function complete(f, method, resume, request) {
  let result = await f.invoke(method, request);
  const calls = [...(result.calls ?? [])];
  for (let steps = 0; result.continuation; steps++) {
    assert.ok(steps < 16, 'bounded continuation must settle');
    result = await f.invoke(resume, { cursor: result.continuation.cursor });
    calls.push(...(result.calls ?? []));
  }
  return { result, calls };
}

test('assembled stack/call/memory ELF uses actual function extents and public ABI/call graph', { timeout: 25000 }, async t => {
  const f = await fixture(t);
  assert.ok(f.workerThreadId > 0);
  assert.equal(f.info.formatId, 'elf');
  for (const row of f.manifest.expectedFunctions) {
    assert.equal(f.symbols.functionAt(BigInt(row.start)).end, BigInt(row.end));
  }
  const region = f.info.slices[0].regions.find(r => BigInt(r.vmAddr) === 0x1000n);
  const decoded = await f.backend.fetchChunk(region.id, 0);
  assert.deepEqual(decoded.mn, ['stp', 'mov', 'mov', 'add', 'str', 'ldr', 'bl', 'str', 'ldr', 'ldp', 'ret', 'add', 'ret', 'ldr', 'str', 'ret']);
  assert.equal(decoded.ops[6], '#0x102c');
  assert.equal(decoded.ops[13], 'x9, [x0]');
  assert.equal(decoded.ops[14], 'x9, [x1]');

  const caller = await f.invoke('abiInputBindings', { functionId: functionIds[0] });
  const callee = await f.invoke('abiInputBindings', { functionId: functionIds[1] });
  const memory = await f.invoke('abiInputBindings', { functionId: functionIds[2] });
  assert.equal(caller.calls.length, 1);
  assert.equal(caller.calls[0].arguments[0].register, 'x0');
  assert.equal(callee.parameters[0].register, 'x0');
  assert.deepEqual(memory.parameters.map(p => p.register).sort(), ['x0', 'x1']);
  assert.equal(new Set([caller.functionId, callee.functionId, memory.functionId]).size, 3);
  assert.equal(caller.exact, false);
  assert.equal(callee.exact, false);

  const before = f.counters.semantic;
  const { result, calls } = await complete(f, 'callGraphSlice', 'resumeCallGraphSlice', { functionIds });
  assert.equal(f.counters.semantic - before, 3, 'each selected native function is prepared once');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].callerFunctionId, caller.functionId);
  assert.equal(calls[0].targets.length, 1);
  const target = calls[0].targets[0];
  assert.equal(target.address, '0x102c');
  assert.equal(target.targetFunctionId, callee.functionId);
  assert.equal(target.sourceBinding.calleeInput.functionLocator, '0x102c');
  assert.equal(target.closed, false);
  assert.equal(target.exact, false);
  assert.equal(result.exact, false);
  assert.equal(result.releaseQualified, false);
});

test('actual load/store memory owners replay current source and reject another function owner', { timeout: 25000 }, async t => {
  const f = await fixture(t);
  const query = await f.invoke('semanticQuery', {
    scope: { functionIds: ['0x1034'] }, select: { op: 'eq', field: 'owner', value: 'memoryssa' }, resultLimit: 32,
  });
  assert.equal(query.executionStatus, 'completed');
  const records = query.results.map(row => row.value);
  const load = records.find(row => row.kind === 'memory-use');
  assert.ok(load);
  assert.ok(records.some(row => row.kind === 'memory-def'));
  assert.ok(records.some(row => row.kind === 'may-alias-clobber'));
  assert.equal(query.semanticClosure, 'unknown');
  assert.equal(query.exact, false);
  assert.ok(query.frontier.entries.some(row => row.reason === 'may-alias-clobber'));
  const explanation = await f.invoke('referenceSlice', { functionId: '0x1034', request: {
    projectionId: load.reference.projectionId, referenceIds: [load.id], includeBytes: true, maxDepth: 2,
  } });
  assert.equal(explanation.status, 'completed', explanation.reason);
  const { bundle } = explanation;
  assert.ok(bundle.sources.length > 0);
  assert.ok(bundle.sources.every(row => Array.isArray(row.bytes) && row.bytes.length === row.length));
  assert.ok(bundle.sources.some(row => BigInt(row.offset) === 0x1034n && row.length === 4));
  const replay = await f.invoke('replayReferenceSlice', { functionId: '0x1034', bundle });
  assert.equal(replay.status, 'matched-current-source');
  assert.equal(replay.contentMatches, true);
  assert.equal(replay.semanticProof, false);
  const foreign = await f.invoke('replayReferenceSlice', { functionId: '0x102c', bundle });
  assert.equal(foreign.status, 'stale');
  assert.equal(foreign.semanticProof, false);
});

test('three native summary inputs resume once each and retain unknown call/memory authority', { timeout: 25000 }, async t => {
  const f = await fixture(t);
  let result = await f.invoke('summarySlice', { functionIds });
  assert.equal(result.preparation.loadedFunctions, 1);
  const consumed = result.continuation.cursor;
  result = await f.invoke('resumeSummarySlice', { cursor: consumed });
  assert.equal(result.preparation.loadedFunctions, 2);
  const before = { ...f.counters };
  await assert.rejects(f.invoke('resumeSummarySlice', { cursor: consumed }));
  assert.deepEqual(f.counters, before, 'consumed cursor cannot dispatch more native work');
  for (let steps = 0; result.continuation; steps++) {
    assert.ok(steps < 16);
    result = await f.invoke('resumeSummarySlice', { cursor: result.continuation.cursor });
  }
  assert.equal(f.counters.semantic, 3);
  assert.equal(result.executionStatus, 'completed');
  assert.equal(result.preparation.sourceInputsRetained, false);
  assert.equal(result.callCandidateBindings.bindings.length, 1);
  const binding = result.callCandidateBindings.bindings[0];
  assert.equal(binding.sourceBinding.callerInput.functionLocator, '0x1000');
  assert.equal(binding.sourceBinding.calleeInput.functionLocator, '0x102c');
  const summary = result.summaries.find(row => row.functionId === binding.callerFunctionId).summary;
  assert.deepEqual(summary.indirectCallSets[0].candidateEntityIds, [binding.targetFunctionId]);
  assert.equal(summary.indirectCallSets[0].exhaustive, false);
  assert.equal(summary.unknownCallEffects.length, 1);
  assert.ok(summary.memoryWriteRegions.some(row => row.broad && row.source === 'unknown-call-fallback'));
  assert.equal(summary.mayThrow, 'unknown');
  const copyId = result.requestedScope.members.find(row => row.locator === '0x1034').functionId;
  const copy = result.summaries.find(row => row.functionId === copyId).summary;
  assert.equal(copy.memoryReadRegions.length, 1);
  assert.equal(copy.memoryWriteRegions.length, 1);
  assert.equal(copy.memoryReadRegions[0].broad, true);
  assert.equal(copy.memoryWriteRegions[0].broad, true);
  assert.equal(result.semanticClosure, 'unknown');
  assert.equal(result.exact, false);
  assert.equal(result.releaseQualified, false);
});

test('binary transport change retires a partially prepared multi-function native summary', { timeout: 25000 }, async t => {
  const f = await fixture(t);
  const result = await f.invoke('summarySlice', { functionIds });
  assert.equal(result.preparation.loadedFunctions, 1);
  assert.ok(result.continuation);
  const before = { ...f.counters };
  f.backend.transportEpoch++;
  await assert.rejects(f.invoke('resumeSummarySlice', { cursor: result.continuation.cursor }), /scoped-session-unavailable-or-wrong-kind/);
  assert.deepEqual(f.counters, before, 'retired world must not load the remaining functions');
});

test('real stack-load argument reaches the selected callee only as an open ABI flow', { timeout: 25000 }, async t => {
  const f = await fixture(t);
  const caller = await f.invoke('abiInputBindings', { functionId: '0x1000' });
  const callee = await f.invoke('abiInputBindings', { functionId: '0x102c' });
  const before = f.counters.semantic;
  let result = await f.invoke('interproceduralQuery', {
    scope: { functionIds: ['0x1000', '0x102c'] },
    select: { op: 'eq', field: 'entityId', value: caller.calls[0].arguments[0].definitionId },
    flow: { to: { op: 'eq', field: 'entityId', value: callee.parameters[0].definitionId }, edgeKinds: ['call-summary'], maxDepth: 4 },
  });
  const paths = [];
  for (let steps = 0; ; steps++) {
    assert.ok(steps < 16);
    paths.push(...result.results);
    if (!result.continuation) break;
    result = await f.invoke('resumeSemanticQuery', { cursor: result.continuation.cursor });
  }
  assert.equal(f.counters.semantic - before, 2);
  assert.equal(paths.length, 1);
  assert.equal(paths[0].edges.length, 1);
  assert.equal(paths[0].edges[0].witness.owner, 'existing-abi-and-compat-register-inputs');
  assert.equal(result.scopeMode, 'explicit-interprocedural');
  assert.equal(result.semanticClosure, 'unknown');
  assert.equal(result.exact, false);
  assert.equal(result.releaseQualified, false);
});
