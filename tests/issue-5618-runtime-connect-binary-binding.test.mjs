import assert from 'node:assert/strict';
import { CapabilityExecutor } from '../js/ai/capabilities/executor.js';
import { createCapabilityCatalog } from '../js/ai/capabilities/catalog.js';

const realCatalog = createCapabilityCatalog();

function createFakeRuntimePlatform() {
  let session = null;
  return {
    startSession: async (options) => {
      session = {
        id: 'sess-1',
        binaryHash: options.binaryHash || null,
        adapter: options.adapter,
      };
      return session;
    },
    currentSession: () => session,
  };
}

// 1. Rejection when current binary is null and args.binaryId is omitted (real catalog)
{
  const runtimePlatform = createFakeRuntimePlatform();
  const executor = new CapabilityExecutor({
    catalog: realCatalog,
    binaryId: null,
    runtimePlatform,
  });

  await assert.rejects(
    () => executor.execute(
      'runtime.connect',
      { adapter: 'local' },
      { scope: 'binary' },
    ),
    (err) => {
      assert.equal(err.type, 'scope_violation');
      assert.match(err.message, /explicit binary binding/i);
      return true;
    },
    'runtime.connect without current binary or args.binaryId must be rejected with scope_violation before approval',
  );

  assert.equal(runtimePlatform.currentSession(), null, 'no unbound session should have been created');
}

// 2. verifyBinding rejects unbound runtime.connect directly
{
  const executor = new CapabilityExecutor({
    catalog: realCatalog,
    binaryId: null,
  });

  assert.throws(
    () => executor.verifyBinding(realCatalog.get('runtime.connect'), { adapter: 'local' }),
    (err) => {
      assert.equal(err.type, 'scope_violation');
      assert.match(err.message, /explicit binary binding/i);
      return true;
    },
  );
}

// 3. Mismatch between args.binaryId and current binary is rejected before approval
{
  const runtimePlatform = createFakeRuntimePlatform();
  const executor = new CapabilityExecutor({
    catalog: realCatalog,
    binaryId: 'bin-current',
    runtimePlatform,
  });

  await assert.rejects(
    () => executor.execute(
      'runtime.connect',
      { adapter: 'local', binaryId: 'bin-other' },
      { scope: 'binary' },
    ),
    (err) => {
      assert.equal(err.type, 'scope_violation');
      assert.match(err.message, /different binary/i);
      return true;
    },
    'mismatch between args.binaryId and currentBinaryId must be rejected with scope_violation',
  );
}

// Test catalog without requiresApproval to verify end-to-end execution of startSession
const testEntry = {
  ...realCatalog.get('runtime.connect'),
  requiresApproval: false,
};
const testCatalog = {
  get: (id) => (id === 'runtime.connect' ? testEntry : realCatalog.get(id)),
};

// 4. Binding to current binary when args.binaryId is omitted
{
  const runtimePlatform = createFakeRuntimePlatform();
  const executor = new CapabilityExecutor({
    catalog: testCatalog,
    binaryId: 'bin-current',
    runtimePlatform,
  });

  const session = await executor.execute(
    'runtime.connect',
    { adapter: 'local' },
    { scope: 'binary' },
  );

  assert.equal(session.binaryHash, 'bin-current');
  assert.equal(runtimePlatform.currentSession()?.binaryHash, 'bin-current');
}

// 5. Binding to explicit args.binaryId when current binary is null
{
  const runtimePlatform = createFakeRuntimePlatform();
  const executor = new CapabilityExecutor({
    catalog: testCatalog,
    binaryId: null,
    runtimePlatform,
  });

  const session = await executor.execute(
    'runtime.connect',
    { adapter: 'local', binaryId: 'bin-explicit' },
    { scope: 'binary' },
  );

  assert.equal(session.binaryHash, 'bin-explicit');
  assert.equal(runtimePlatform.currentSession()?.binaryHash, 'bin-explicit');
}

// 6. Binding to explicit args.binaryId when it matches current binary
{
  const runtimePlatform = createFakeRuntimePlatform();
  const executor = new CapabilityExecutor({
    catalog: testCatalog,
    binaryId: 'bin-current',
    runtimePlatform,
  });

  const session = await executor.execute(
    'runtime.connect',
    { adapter: 'local', binaryId: 'bin-current' },
    { scope: 'binary' },
  );

  assert.equal(session.binaryHash, 'bin-current');
  assert.equal(runtimePlatform.currentSession()?.binaryHash, 'bin-current');
}

console.log('issue-5618-runtime-connect-binary-binding: PASS');
