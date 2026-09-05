import test from 'node:test';
import assert from 'node:assert/strict';

import { DebuggerProvider } from '../../../js/runtime/debugger-provider.js';
import { InstrumentationProvider } from '../../../js/runtime/instrumentation-provider.js';

function makeDebuggerAdapter() {
  let registerWrites = 0;
  let memoryWrites = 0;
  return {
    id: 'occurrence-debugger',
    kind: 'debugger',
    version: '1',
    capabilities: { modules: false },
    connected: false,
    epoch: 0,
    async connect() { this.connected = true; },
    async disconnect() { this.connected = false; },
    setEpoch(value) { this.epoch = value; },
    async writeRegister() { return { writeNumber: ++registerWrites }; },
    async writeMemory() { return { writeNumber: ++memoryWrites }; },
  };
}

test('DebuggerProvider records repeated identical mutations as distinct occurrences', async () => {
  const provider = new DebuggerProvider(makeDebuggerAdapter());
  const session = await provider.openSession({
    processKey: 'debug-occurrence-process',
    binaryId: 'debug-occurrence-binary',
    sessionNonce: 'debug-occurrence-session',
  });
  const facet = session.facets.debugger;

  const first = await facet.writeRegister('x0', 1);
  const second = await facet.writeRegister('x0', 1);

  assert.equal(first.result.writeNumber, 1);
  assert.equal(second.result.writeNumber, 2);
  assert.equal(first.intervention.acknowledgedResult.writeNumber, 1);
  assert.equal(second.intervention.acknowledgedResult.writeNumber, 2);
  assert.notEqual(first.intervention.interventionId, second.intervention.interventionId);
  assert.deepEqual([first.intervention.sequence, second.intervention.sequence], [0, 1]);
  assert.equal(facet.interventions.all().length, 2);

  const bytes = new Uint8Array([0xaa, 0xbb]);
  const memoryFirst = await facet.writeMemory(0x1000n, bytes);
  const memorySecond = await facet.writeMemory(0x1000n, bytes);

  assert.notEqual(memoryFirst.intervention.interventionId, memorySecond.intervention.interventionId);
  assert.deepEqual([memoryFirst.intervention.sequence, memorySecond.intervention.sequence], [2, 3]);
  assert.deepEqual(
    [memoryFirst.intervention.acknowledgedResult.writeNumber, memorySecond.intervention.acknowledgedResult.writeNumber],
    [1, 2],
  );

  await assert.rejects(
    facet.writeRegister('x1', 2, { parentInterventionIds: ['missing-parent'] }),
    (error) => error?.code === 'runtime-intervention-parent-missing',
  );

  const child = await facet.writeRegister('x1', 2, {
    parentInterventionIds: [second.intervention.interventionId],
  });
  assert.equal(child.intervention.sequence, 4);
  assert.deepEqual(child.intervention.parentInterventionIds, [second.intervention.interventionId]);
  assert.equal(facet.interventions.all().length, 5);

  await session.close();
});

function makeInstrumentationBackend() {
  const calls = {
    install: 0,
    remove: 0,
    intercept: 0,
    replace: 0,
    memory: 0,
  };
  return {
    id: 'occurrence-instrumentation',
    version: '1',
    async installProbe() { return { handle: 'probe-fixed', call: ++calls.install }; },
    async removeProbe() { return { removed: ++calls.remove }; },
    async intercept() { return { handle: 'intercept-fixed', call: ++calls.intercept }; },
    async replace() { return { replaced: ++calls.replace }; },
    async writeMemory() { return { written: ++calls.memory }; },
  };
}

test('InstrumentationProvider sequences every mutation occurrence per session', async () => {
  const provider = new InstrumentationProvider(makeInstrumentationBackend(), {
    allowReplacement: true,
    allowMemoryWrite: true,
  });
  const session = await provider.openSession({
    processKey: 'instrumentation-occurrence-process',
    binaryId: 'instrumentation-occurrence-binary',
    sessionNonce: 'instrumentation-occurrence-session',
  });
  const facet = session.facets.instrumentation;
  const records = [];

  records.push(await facet.installProbe({ address: 0x2000n }));
  records.push(await facet.installProbe({ address: 0x2000n }));
  assert.notEqual(records[0].intervention.interventionId, records[1].intervention.interventionId);
  assert.deepEqual(
    records.slice(0, 2).map(({ intervention }) => intervention.acknowledgedResult.call),
    [1, 2],
  );

  records.push(await facet.intercept({ address: 0x3000n }));
  records.push(await facet.intercept({ address: 0x3000n }));
  assert.notEqual(records[2].intervention.interventionId, records[3].intervention.interventionId);

  records.push(await facet.replace({ address: 0x4000n }, { address: 0x5000n }));
  records.push(await facet.replace({ address: 0x4000n }, { address: 0x5000n }));
  assert.notEqual(records[4].intervention.interventionId, records[5].intervention.interventionId);

  const bytes = new Uint8Array([1, 2, 3]);
  records.push(await facet.writeMemory(0x6000n, bytes));
  records.push(await facet.writeMemory(0x6000n, bytes));
  assert.notEqual(records[6].intervention.interventionId, records[7].intervention.interventionId);

  const secondInstallId = records[1].intervention.interventionId;
  records.push(await facet.removeProbe('probe-fixed'));
  records.push(await facet.removeProbe('probe-fixed'));
  assert.equal(records[8].intervention.parentInterventionIds.includes(secondInstallId), true);
  assert.notEqual(records[8].intervention.interventionId, records[9].intervention.interventionId);

  assert.deepEqual(records.map(({ intervention }) => intervention.sequence), [...Array(10).keys()]);
  assert.equal(facet.interventions.all().length, 10);

  await session.close();
});
