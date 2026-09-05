import assert from 'node:assert/strict';
import test from 'node:test';

import { DebugAdapter } from '../../../js/debug/adapter.js';
import { DebuggerProvider } from '../../../js/runtime/debugger-provider.js';

class EventAdapter extends DebugAdapter {
  constructor() {
    super({ id: 'module-event-adapter', kind: 'test', capabilities: { modules: false } });
  }
}

async function openSession(nonce) {
  const provider = new DebuggerProvider(new EventAdapter());
  return provider.openSession({ binaryId: 'bin-A', sessionNonce: nonce }, { connect: false });
}

function moduleLoad(sequence, overrides = {}) {
  return {
    kind: 'module-load',
    sequence,
    module: {
      id: 'main',
      runtimeBase: 0x1000,
      runtimeSize: 0x1000,
      staticBase: 0x4000,
      binaryId: 'bin-A',
      identityState: 'exact',
      ...overrides,
    },
  };
}

test('issue #4372 - identical module-load is idempotent but changed base replaces the active generation', async () => {
  const session = await openSession('issue-4372-base');
  const ingest = session.facets.debugger.events.ingest;

  ingest(moduleLoad(1));
  assert.equal(session.modules.get('main').generation, 1);
  assert.equal(session.modules.get('main').loadedSequence, 1);

  ingest(moduleLoad(2));
  assert.equal(session.modules.get('main').generation, 1, 'identical duplicate must not advance generation');
  assert.equal(session.modules.get('main').loadedSequence, 1, 'duplicate must preserve the original load occurrence');

  ingest(moduleLoad(3, { runtimeBase: 0x5000 }));
  const replacement = session.modules.get('main');
  assert.equal(replacement.generation, 2);
  assert.equal(replacement.runtimeBase, 0x5000n);
  assert.equal(replacement.loadedSequence, 3);
  assert.equal(session.facets.debugger.resolveAddress(0x5100n, { binaryId: 'bin-A' }).state, 'exact');
  assert.equal(session.facets.debugger.resolveAddress(0x1100n, { binaryId: 'bin-A' }).state, 'unresolved');

  const retired = session.modules.history().find((binding) => binding.generation === 1 && binding.unloadedSequence != null);
  assert.equal(retired?.unloadedSequence, 3, 'old generation must retire at the replacement event sequence');
  await session.close();
});

test('issue #4372 - changed size and static identity each replace the active generation', async () => {
  const session = await openSession('issue-4372-identity');
  const ingest = session.facets.debugger.events.ingest;

  ingest(moduleLoad(10));
  ingest(moduleLoad(11, { runtimeSize: 0x2000 }));
  assert.equal(session.modules.get('main').generation, 2);
  assert.equal(session.modules.get('main').runtimeSize, 0x2000n);
  assert.equal(session.modules.get('main').loadedSequence, 11);

  ingest(moduleLoad(12, { runtimeSize: 0x2000, binaryId: 'bin-B', staticBase: 0x9000 }));
  const replacement = session.modules.get('main');
  assert.equal(replacement.generation, 3);
  assert.equal(replacement.binaryId, 'bin-B');
  assert.equal(replacement.staticBase, 0x9000n);
  assert.equal(replacement.loadedSequence, 12);
  await session.close();
});

test('issue #4372 - explicit module-unload keeps existing retirement semantics after replacement', async () => {
  const session = await openSession('issue-4372-unload');
  const ingest = session.facets.debugger.events.ingest;

  ingest(moduleLoad(20));
  ingest(moduleLoad(21, { runtimeBase: 0x6000 }));
  ingest({ kind: 'module-unload', sequence: 22, module: { id: 'main' } });

  assert.equal(session.modules.get('main'), null);
  const retired = session.modules.history().find((binding) => binding.generation === 2 && binding.unloadedSequence === 22);
  assert.ok(retired, 'explicit unload must retire the replacement generation at its event sequence');
  await session.close();
});
