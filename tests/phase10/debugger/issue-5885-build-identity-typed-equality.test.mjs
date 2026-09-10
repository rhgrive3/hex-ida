import assert from 'node:assert/strict';
import test from 'node:test';

import { DebuggerProvider } from '../../../js/runtime/debugger-provider.js';

const binaryId = 'bin_sha256_' + '58'.repeat(32);
let sessionSequence = 0;

function moduleSnapshot(buildIdentity) {
  return [{
    id: 'module:main',
    base: 0x1000n,
    size: 0x100n,
    staticBase: 0x4000n,
    binaryId,
    identityState: 'exact',
    identityEvidenceIds: ['e:module:5885'],
    buildIdentity,
  }];
}

async function openWithSnapshots(...snapshots) {
  let index = 0;
  const adapter = {
    id: 'issue-5885-adapter',
    kind: 'debugger',
    capabilities: { modules: true },
    connected: false,
    async connect() { this.connected = true; },
    async disconnect() { this.connected = false; },
    async getModules() {
      const snapshot = snapshots[Math.min(index, snapshots.length - 1)];
      index += 1;
      return snapshot;
    },
  };
  const provider = new DebuggerProvider(adapter, { id: 'issue-5885-provider' });
  const session = await provider.openSession({
    binaryId,
    processKey: 'process:5885',
    sessionNonce: `issue-5885:${++sessionSequence}`,
  });
  return { session, refresh: () => session.facets.debugger.refreshModules() };
}

test('BigInt and lookalike string build identities are distinct module generations', async () => {
  const { session, refresh } = await openWithSnapshots(
    moduleSnapshot({ build: 1n }),
    moduleSnapshot({ build: '1n' }),
  );
  try {
    assert.equal(session.modules.get('module:main').generation, 1);
    assert.equal(session.modules.get('module:main').buildIdentity.build, 1n);
    await refresh();
    const current = session.modules.get('module:main');
    assert.equal(current.generation, 2);
    assert.equal(current.buildIdentity.build, '1n');
  } finally {
    await session.close();
  }
});

test('nested BigInt and lookalike string build identities cannot collide', async () => {
  const { session, refresh } = await openWithSnapshots(
    moduleSnapshot({ nested: { build: 42n } }),
    moduleSnapshot({ nested: { build: '42n' } }),
  );
  try {
    await refresh();
    const current = session.modules.get('module:main');
    assert.equal(current.generation, 2);
    assert.equal(current.buildIdentity.nested.build, '42n');
  } finally {
    await session.close();
  }
});


test('typed witness distinguishes BigInt from its canonical decimal string', async () => {
  const { session, refresh } = await openWithSnapshots(
    moduleSnapshot({ build: 7n }),
    moduleSnapshot({ build: '7' }),
  );
  try {
    await refresh();
    const current = session.modules.get('module:main');
    assert.equal(current.generation, 2);
    assert.equal(current.buildIdentity.build, '7');
  } finally {
    await session.close();
  }
});

test('the same BigInt identity remains unchanged across refresh', async () => {
  const { session, refresh } = await openWithSnapshots(
    moduleSnapshot({ build: 1n, nested: { revision: 2n } }),
    moduleSnapshot({ build: 1n, nested: { revision: 2n } }),
  );
  try {
    await refresh();
    assert.equal(session.modules.get('module:main').generation, 1);
  } finally {
    await session.close();
  }
});

test('plain-object property insertion order does not create a false module generation', async () => {
  const first = {};
  first.build = 1n;
  first.flavor = 'release';
  const reordered = {};
  reordered.flavor = 'release';
  reordered.build = 1n;
  const { session, refresh } = await openWithSnapshots(
    moduleSnapshot(first),
    moduleSnapshot(reordered),
  );
  try {
    await refresh();
    assert.equal(session.modules.get('module:main').generation, 1);
  } finally {
    await session.close();
  }
});

test('genuinely different typed build identities still advance generation', async () => {
  const { session, refresh } = await openWithSnapshots(
    moduleSnapshot({ build: 1n }),
    moduleSnapshot({ build: 2n }),
  );
  try {
    await refresh();
    const current = session.modules.get('module:main');
    assert.equal(current.generation, 2);
    assert.equal(current.buildIdentity.build, 2n);
  } finally {
    await session.close();
  }
});
