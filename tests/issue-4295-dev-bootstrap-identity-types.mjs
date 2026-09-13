import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEV_BOOTSTRAP_CAPABILITY,
  DEV_BOOTSTRAP_EXTENSION,
  DEV_BOOTSTRAP_EXTENSION_INTEGRITY,
  DEV_BOOTSTRAP_EXTENSION_VERSION,
  DevExtensionLoader,
  createDevBootstrapCheckpoint,
  verifyDevBootstrapIdentity,
} from '../js/ai/dev/bootstrap/dev-bootstrap-gate.js';
import { runProductionDevBootstrap } from '../js/ai/dev/bootstrap/production-bootstrap.js';

const COMMIT = 'a'.repeat(40);
const BUILD_ID = 'b'.repeat(24);
const digest = DEV_BOOTSTRAP_EXTENSION_INTEGRITY.slice('sha256-'.length);
const sha256 = async () => digest;
const baseCheckpoint = Object.freeze({
  runId: 'run-4295',
  goal: 'verify identity typing',
  decisionPolicy: 'normal',
  supervisorSessionKey: 'session-4295',
  chatgptConversationId: 'conversation-4295',
  pendingTask: { type: 'identity-check' },
  expectedCommit: COMMIT,
  expectedBuildId: BUILD_ID,
  expectedExtensionVersion: DEV_BOOTSTRAP_EXTENSION_VERSION,
});

function oneItem(value) { return [value]; }

function cloneExtension(overrides = {}) {
  return {
    ...DEV_BOOTSTRAP_EXTENSION,
    capabilities: DEV_BOOTSTRAP_EXTENSION.capabilities.map((item) => ({ ...item })),
    ...overrides,
  };
}

test('issue #4295 - checkpoint identity/text fields reject structured aliases', () => {
  for (const [field, value] of [
    ['runId', baseCheckpoint.runId],
    ['goal', baseCheckpoint.goal],
    ['supervisorSessionKey', baseCheckpoint.supervisorSessionKey],
    ['chatgptConversationId', baseCheckpoint.chatgptConversationId],
    ['expectedExtensionVersion', baseCheckpoint.expectedExtensionVersion],
    ['expectedCommit', baseCheckpoint.expectedCommit],
    ['expectedBuildId', baseCheckpoint.expectedBuildId],
  ]) {
    assert.throws(
      () => createDevBootstrapCheckpoint({ ...baseCheckpoint, [field]: oneItem(value) }),
      TypeError,
      `${field} must not accept an Array alias`,
    );
  }

  let coercions = 0;
  const hostile = { toString() { coercions += 1; return baseCheckpoint.runId; } };
  assert.throws(
    () => createDevBootstrapCheckpoint({ ...baseCheckpoint, runId: hostile }),
    TypeError,
  );
  assert.equal(coercions, 0, 'checkpoint validation must not invoke user coercion hooks');

  const normalized = createDevBootstrapCheckpoint({
    ...baseCheckpoint,
    runId: `  ${baseCheckpoint.runId}  `,
    goal: `  ${baseCheckpoint.goal}  `,
    supervisorSessionKey: `  ${baseCheckpoint.supervisorSessionKey}  `,
    chatgptConversationId: `  ${baseCheckpoint.chatgptConversationId}  `,
    expectedExtensionVersion: `  ${baseCheckpoint.expectedExtensionVersion}  `,
    expectedCommit: `  ${baseCheckpoint.expectedCommit}  `,
    expectedBuildId: `  ${baseCheckpoint.expectedBuildId}  `,
  });
  assert.equal(normalized.runId, baseCheckpoint.runId);
  assert.equal(normalized.goal, baseCheckpoint.goal);
  assert.equal(normalized.supervisorSessionKey, baseCheckpoint.supervisorSessionKey);
  assert.equal(normalized.chatgptConversationId, baseCheckpoint.chatgptConversationId);
  assert.equal(normalized.expectedExtensionVersion, baseCheckpoint.expectedExtensionVersion);
  assert.equal(normalized.expectedCommit, COMMIT);
  assert.equal(normalized.expectedBuildId, BUILD_ID);
});

test('issue #4295 - active extension identity rejects structured aliases', () => {
  const checkpoint = createDevBootstrapCheckpoint(baseCheckpoint);
  assert.throws(
    () => verifyDevBootstrapIdentity(checkpoint, { commit: [COMMIT], buildId: BUILD_ID }, DEV_BOOTSTRAP_EXTENSION_VERSION),
    TypeError,
  );
  assert.throws(
    () => verifyDevBootstrapIdentity(checkpoint, { commit: COMMIT, buildId: [BUILD_ID] }, DEV_BOOTSTRAP_EXTENSION_VERSION),
    TypeError,
  );
  assert.throws(
    () => verifyDevBootstrapIdentity(checkpoint, { commit: COMMIT, buildId: BUILD_ID }, [DEV_BOOTSTRAP_EXTENSION_VERSION]),
    TypeError,
  );

  let coercions = 0;
  const hostileVersion = { toString() { coercions += 1; return DEV_BOOTSTRAP_EXTENSION_VERSION; } };
  assert.throws(
    () => verifyDevBootstrapIdentity(checkpoint, { commit: COMMIT, buildId: BUILD_ID }, hostileVersion),
    TypeError,
  );
  assert.equal(coercions, 0, 'active extension identity validation must not invoke coercion hooks');

  assert.equal(
    verifyDevBootstrapIdentity(checkpoint, { commit: COMMIT, buildId: BUILD_ID }, DEV_BOOTSTRAP_EXTENSION_VERSION).verified,
    true,
  );
});

test('issue #4295 - extension manifest identities and capability lookup remain primitive-string only', async () => {
  const structuredCases = [
    cloneExtension({ id: [DEV_BOOTSTRAP_EXTENSION.id] }),
    cloneExtension({ version: [DEV_BOOTSTRAP_EXTENSION.version] }),
    cloneExtension({ integrity: [DEV_BOOTSTRAP_EXTENSION.integrity] }),
    cloneExtension({ capabilities: DEV_BOOTSTRAP_EXTENSION.capabilities.map((item, index) => index === 0 ? { ...item, name: [item.name] } : { ...item }) }),
    cloneExtension({ capabilities: DEV_BOOTSTRAP_EXTENSION.capabilities.map((item, index) => index === 0 ? { ...item, kind: [item.kind] } : { ...item }) }),
  ];
  for (const extension of structuredCases) {
    const loader = new DevExtensionLoader({ sha256 });
    await assert.rejects(loader.stage(extension), TypeError);
  }

  let coercions = 0;
  const hostileId = { toString() { coercions += 1; return DEV_BOOTSTRAP_EXTENSION.id; } };
  await assert.rejects(
    new DevExtensionLoader({ sha256 }).stage(cloneExtension({ id: hostileId })),
    TypeError,
  );
  assert.equal(coercions, 0, 'extension manifest validation must not invoke coercion hooks');

  const loader = new DevExtensionLoader({ sha256 });
  await loader.stage(cloneExtension());
  loader.activateAtSafeBoundary({
    checkpoint: baseCheckpoint,
    activeIdentity: { commit: COMMIT, buildId: BUILD_ID },
    reinitialized: true,
  });
  assert.equal(loader.invoke(DEV_BOOTSTRAP_CAPABILITY).verified, true);
  assert.throws(() => loader.invoke([DEV_BOOTSTRAP_CAPABILITY]), TypeError);

  coercions = 0;
  const hostileCapability = { toString() { coercions += 1; return DEV_BOOTSTRAP_CAPABILITY; } };
  assert.throws(() => loader.invoke(hostileCapability), TypeError);
  assert.equal(coercions, 0, 'capability lookup must not invoke coercion hooks');
});


test('issue #4295 - production bootstrap does not launder structured first-party identities before the gate', async () => {
  const structuredRuntimeParent = responsiveParent({
    runtimeIdentity: { commit: [COMMIT], buildId: BUILD_ID },
  });
  const runtimeGlobal = fakeSandboxGlobal(structuredRuntimeParent);
  let prepares = 0;
  const runtimeResult = await runProductionDevBootstrap({
    engine: { devBootstrap: { prepare: async () => { prepares += 1; } } },
    session: { current: { id: 'hex-conversation', model: null, reasoning: null } },
    bridge: { request: async () => ({ conversation: { id: 'chatgpt-conversation' } }) },
    globalObject: runtimeGlobal,
  });
  assert.equal(runtimeResult.state, 'failed');
  assert.equal(prepares, 0, 'structured runtime identity must fail before bootstrap preparation');

  let runtimeCoercions = 0;
  const hostileCommit = { toString() { runtimeCoercions += 1; return COMMIT; } };
  const hostileRuntimeParent = responsiveParent({ runtimeIdentity: { commit: hostileCommit, buildId: BUILD_ID } });
  const hostileRuntimeResult = await runProductionDevBootstrap({
    engine: { devBootstrap: { prepare: async () => { prepares += 1; } } },
    session: { current: { id: 'hex-conversation', model: null, reasoning: null } },
    bridge: { request: async () => ({ conversation: { id: 'chatgpt-conversation' } }) },
    globalObject: fakeSandboxGlobal(hostileRuntimeParent),
  });
  assert.equal(hostileRuntimeResult.state, 'failed');
  assert.equal(runtimeCoercions, 0, 'production runtime identity must not execute coercion hooks');

  const conversationParent = responsiveParent({ runtimeIdentity: { commit: COMMIT, buildId: BUILD_ID } });
  let sessionForCalls = 0;
  const structuredSessionResult = await runProductionDevBootstrap({
    engine: { devBootstrap: {
      prepare: async () => {},
      sessionFor: () => { sessionForCalls += 1; return { supervisorSessionKey: 'session' }; },
    } },
    session: { current: { id: ['hex-conversation'], model: null, reasoning: null } },
    bridge: { request: async () => ({ conversation: { id: 'chatgpt-conversation' } }) },
    globalObject: fakeSandboxGlobal(conversationParent),
  });
  assert.equal(structuredSessionResult.state, 'failed');
  assert.equal(sessionForCalls, 0, 'structured Hex conversation identity must not reach session routing');

  let checkpointCalls = 0;
  const bridgeParent = responsiveParent({ runtimeIdentity: { commit: COMMIT, buildId: BUILD_ID } });
  const structuredBridgeResult = await runProductionDevBootstrap({
    engine: { devBootstrap: {
      prepare: async () => {},
      sessionFor: () => ({ supervisorSessionKey: 'session' }),
      createCheckpoint: () => { checkpointCalls += 1; throw new Error('checkpoint should not be reached'); },
    } },
    session: { current: { id: 'hex-conversation', model: null, reasoning: null } },
    bridge: {
      request: async () => ({ conversation: { id: ['chatgpt-conversation'] } }),
      conversationFor: () => null,
    },
    globalObject: fakeSandboxGlobal(bridgeParent),
  });
  assert.equal(structuredBridgeResult.state, 'failed');
  assert.equal(checkpointCalls, 0, 'structured ChatGPT conversation identity must not reach checkpoint creation');
});

function responsiveParent({ runtimeIdentity }) {
  const parent = {
    target: null,
    postMessage(message) {
      if (message?.type !== 'hex.dev.bootstrap.handoff-request') return;
      queueMicrotask(() => parent.target.emit({
        origin: 'https://chatgpt.com',
        source: parent,
        data: {
          protocol: message.protocol,
          type: 'hex.dev.bootstrap.handoff-response',
          generation: message.generation,
          sandboxToken: message.sandboxToken,
          handoff: null,
          runtimeIdentity,
        },
      }));
    },
  };
  return parent;
}

function fakeSandboxGlobal(parent) {
  const listeners = new Set();
  const search = '?__hex_embed_generation=1&__hex_dev_bootstrap=1';
  const target = {
    parent,
    location: { href: 'about:srcdoc', origin: 'null', pathname: '', search: '' },
    __HEX_RUNTIME_HOST_HREF__: `https://ida.rhgrive.workers.dev/embed/chatgpt${search}`,
    __HEX_RUNTIME_HOST_ORIGIN__: 'https://ida.rhgrive.workers.dev',
    __HEX_RUNTIME_HOST_PATHNAME__: '/embed/chatgpt',
    __HEX_RUNTIME_HOST_SEARCH__: search,
    __HEX_RUNTIME_HOST_LOCATION__: {
      href: `https://ida.rhgrive.workers.dev/embed/chatgpt${search}`,
      origin: 'https://ida.rhgrive.workers.dev',
      pathname: '/embed/chatgpt',
      search,
    },
    __HEX_EMBED_SANDBOX_TOKEN__: 'c'.repeat(64),
    addEventListener(type, listener) { if (type === 'message') listeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'message') listeners.delete(listener); },
    emit(event) { for (const listener of [...listeners]) listener(event); },
  };
  parent.target = target;
  return target;
}
