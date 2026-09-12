import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchOwnerFixture } from './dispatch-owner-fixture.mjs';
import { createNativeDispatchMemoryReader } from '../../js/analysis/dispatch/native-source.js';
import { ScopedAnalysisWork } from '../../js/core/budgets/scoped-work.js';
import { workFor } from './helpers.mjs';
import { ScopedCallGraphSession } from '../../js/analysis/query/semantic/call-graph.js';
import { resolveUnifiedDispatch } from '../../js/analysis/dispatch/unified.js';

const pointer = [['mov', 'x9, #0x3000', 0xd2860009], ['ldr', 'x11, [x9]', 0xf940012b], ['blr', 'x11', 0xd63f0160], ['ret', '', 0xd65f03c0]];
test('loader pointer declarations stay import identities instead of their unresolved file pointer', { timeout: 20000 }, async t => {
  const f = await dispatchOwnerFixture(t, [[0x1000, pointer]], { imports: [{ address: 0x3000, name: 'owned_external', kind: 2 }], contents: [[0x3000, 0x2000]] });
  const result = await f.resolve(f.nodes().find(node => node.call));
  const imports = result.candidates.filter(row => row.family === 'import-stub');
  assert.equal(imports.length, 1, JSON.stringify(result.remaining));
  assert.equal(imports[0].item.value.address, null);
  assert.equal(imports[0].provenance.declaration.source.importDeclaration.name, 'owned_external');
  assert.equal(result.candidates.some(row => row.item.value.address === '0x2000'), false);
  assert.ok(result.remaining.includes('weak-import-presence-unqualified'));
  assert.equal(result.exact, false);
  assert.equal(result.envelope.upper.kind, 'top');
});
test('an epoch change during an actual source read rejects stale table candidates', { timeout: 20000 }, async t => {
  const f = await dispatchOwnerFixture(t, [[0x1000, pointer]], { read: async (_address, length, { retire }) => {
    retire(); return { found: true, fileOffset: 0n, bytes: new Uint8Array(length) };
  } });
  await assert.rejects(f.resolve(f.nodes().find(node => node.call)), /native-dispatch-source-stale/);
  assert.equal(f.counters.reads, 1);
});
test('short source reads cannot fabricate complete table entries', { timeout: 20000 }, async t => {
  const f = await dispatchOwnerFixture(t, [[0x1000, pointer]], { read: async () => ({ found: true, fileOffset: 0n, bytes: new Uint8Array(1) }) });
  const result = await f.resolve(f.nodes().find(node => node.call));
  assert.equal(result.candidates.length, 0);
  assert.ok(result.remaining.includes('dispatch-source-short-or-unbound-read'));
  assert.equal(result.exact, false);
});
test('a canonical BR joins a signed 32-bit relative table load without becoming a call', { timeout: 20000 }, async t => {
  const rows = [['mov', 'x9, #0x3000', 0xd2860009], ['ldrsw', 'x11, [x9]', 0xb980012b],
    ['add', 'x11, x9, x11', 0x8b0b012b], ['br', 'x11', 0xd61f0160]];
  const f = await dispatchOwnerFixture(t, [[0x1000, rows]], { contents: [[0x3000, 0xfffff000, 4]] });
  const node = f.nodes().find(node => node.kind === 'unknown-control-effect');
  assert.equal(node.call, null);
  const result = await f.resolve(node, { families: ['jump-table'] });
  assert.deepEqual(result.candidates.map(row => row.item.value.address), ['0x2000'], JSON.stringify(result.remaining));
  assert.equal(result.mode, 'jump');
  assert.equal(result.candidates[0].provenance.declaration.source.bytes.length, 4);
  assert.equal(result.exact, false);
  assert.equal(result.envelope.upper.kind, 'top');
});
test('cancelling the scoped read cancels the existing platform producer', { timeout: 20000 }, async t => {
  const f = await dispatchOwnerFixture(t, [[0x1000, pointer]]), controller = new AbortController();
  const work = new ScopedAnalysisWork({ signal: controller.signal, limits: { deadlineMs: 1000 } });
  t.after(() => work.dispose());
  let cancelled = 0;
  const operation = new Promise(() => {}); operation.cancel = () => { cancelled++; };
  const reader = createNativeDispatchMemoryReader({ backend: { readAt: () => {
    queueMicrotask(() => controller.abort('owned-read-cancel')); return operation;
  } }, symbols: null, regions: [{ id: 'readable', vmAddr: 0x1000n, size: 0x4000n, fileOffset: 0n }],
  binaryId: 'binary-scpa-test', sliceId: 'slice-arm64', snapshotId: 'snap', isCurrent: () => true });
  await assert.rejects(reader({ address: '12288', length: 8 }, { ...f, projection: f.members[0].projection, work }));
  assert.equal(cancelled, 1);
});
for (const scenario of ['partial overlap', 'zerofill overlap', 'wrong file offset', 'mapping mutation']) {
  test(`source binding rejects ${scenario}`, { timeout: 20000 }, async t => {
    const f = await dispatchOwnerFixture(t, [[0x1000, [['ret', '', 0xd65f03c0]]]]);
    const regions = [{ id: 'outer', vmAddr: 0x1000n, size: 0x4000n, fileOffset: 0n }];
    if (scenario === 'partial overlap') regions.push({ id: 'partial', vmAddr: 0x3004n, size: 0x100n, fileOffset: 0x8000n });
    if (scenario === 'zerofill overlap') regions.push({ id: 'bss', vmAddr: 0x3004n, size: 0n, declaredSize: 0x100n, zerofill: true, fileOffset: 0n });
    let reads = 0;
    const reader = createNativeDispatchMemoryReader({ backend: { readAt: async () => {
      reads++;
      if (scenario === 'mapping mutation') { regions[0].vmAddr = 0x9000n; regions[0].id = 'replaced'; }
      return { found: true, fileOffset: scenario === 'wrong file offset' ? 0xffffn : 0x2000n, bytes: new Uint8Array(8) };
    } }, symbols: null, regions, binaryId: 'binary-scpa-test', sliceId: 'slice-arm64', snapshotId: 'snap', isCurrent: () => true });
    const pending = reader({ address: '12288', length: 8 }, { ...f, projection: f.members[0].projection, work: workFor(t) });
    if (scenario.endsWith('overlap')) {
      const result = await pending;
      assert.equal(result.status, 'unsupported'); assert.equal(result.reason, 'dispatch-source-mapping-ambiguous');
      assert.equal(reads, 0);
    } else {
      await assert.rejects(pending, scenario === 'wrong file offset'
        ? /native-dispatch-source-file-offset-mismatch/ : /native-dispatch-source-mapping-changed/);
      assert.equal(reads, 1);
    }
  });
}
test('native call graph dispatch accepts nine functions and merges equivalent address spellings', { timeout: 20000 }, async t => {
  const rows = [[0x1000, [['bl', '#0x2000', 0x94000400], ['ret', '', 0xd65f03c0]]]];
  for (let i = 0; i < 8; i++) rows.push([0x2000 + i * 0x100, [['ret', '', 0xd65f03c0]]]);
  const f = await dispatchOwnerFixture(t, rows);
  const byLocator = new Map(f.members.map(member => ['0x' + BigInt(member.inputIdentity.sourceLocation.start).toString(16), member]));
  const session = new ScopedCallGraphSession({ ...f, snapshotId: 'snap', query: { functionIds: [...byLocator.keys()] },
    loadProjection: async locator => byLocator.get(locator), isCurrent: () => true,
    resolveDispatch: (projection, callSiteId, work, nativeContext) => resolveUnifiedDispatch(projection,
      { functionId: projection.functionId, callSiteId, maxTargets: nativeContext.maxTargets, maxHops: nativeContext.maxHops },
      { ...f, work, nativeContext }) });
  t.after(() => session.close());
  const calls = []; let result;
  for (let i = 0; i < 20; i++) {
    result = await session.step({ limits: { deadlineMs: 10000 } }); calls.push(...result.calls);
    if (!result.resumable) break;
  }
  assert.equal(result.enumerationComplete, true);
  assert.equal(result.loadedFunctions, 9);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].targets.length, 1, 'canonical decimal and dispatch hexadecimal addresses identify the same target');
  assert.ok(calls[0].dispatchBound.candidates.some(row => row.item.value.address === '0x2000'));
  assert.equal(calls[0].dispatchBound.remaining.includes('resolver-unsupported:native-demand-dispatch'), false);
  assert.equal(result.exact, false);
});
test('selected pure B thunks compose to the real terminal entry without closing execution', { timeout: 20000 }, async t => {
  const f = await dispatchOwnerFixture(t, [
    [0x1000, [['bl', '#0x2000', 0x94000400], ['ret', '', 0xd65f03c0]]],
    [0x2000, [['b', '#0x3000', 0x14000400]]], [0x3000, [['ret', '', 0xd65f03c0]]],
  ]);
  const result = await f.resolve(f.nodes().find(node => node.call));
  const thunks = result.candidates.filter(row => row.family === 'thunk-chain');
  assert.equal(thunks.length, 1, JSON.stringify(result.remaining));
  assert.equal(thunks[0].item.value.address, '0x3000');
  assert.equal(result.chains[0].length, 1);
  assert.equal(result.exact, false);
});
test('selected thunk cycles are reported instead of inventing a terminal target', { timeout: 20000 }, async t => {
  const f = await dispatchOwnerFixture(t, [
    [0x1000, [['bl', '#0x2000', 0x94000400], ['ret', '', 0xd65f03c0]]],
    [0x2000, [['b', '#0x3000', 0x14000400]]], [0x3000, [['b', '#0x2000', 0x17fffc00]]],
  ]);
  const result = await f.resolve(f.nodes().find(node => node.call));
  assert.equal(result.candidates.some(row => row.family === 'thunk-chain'), false);
  assert.ok(result.remaining.includes('native-thunk-cycle'));
  assert.equal(result.exact, false);
});
test('a store before a branch prevents pure thunk composition', { timeout: 20000 }, async t => {
  const f = await dispatchOwnerFixture(t, [
    [0x1000, [['bl', '#0x2000', 0x94000400], ['ret', '', 0xd65f03c0]]],
    [0x2000, [['str', 'x0, [sp]', 0xf90003e0], ['b', '#0x3000', 0x140003ff]]], [0x3000, [['ret', '', 0xd65f03c0]]],
  ]);
  const result = await f.resolve(f.nodes().find(node => node.call));
  assert.equal(result.chains.length, 0);
  assert.equal(result.candidates.some(row => row.family === 'thunk-chain'), false);
});
