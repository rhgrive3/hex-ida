import assert from 'node:assert/strict';
import { MessageChannel as NodeMessageChannel } from 'node:worker_threads';
import { PlatformPluginRegistry } from '../js/platform/plugin-api.js';
import { PluginHost } from '../js/plugins.js';

const plugins = new PlatformPluginRegistry();
plugins.registerFormat('test.elf', { detect: () => true });
plugins.registerArchitecture('test.arch', { instructionAlignment: 1 });
plugins.registerKnowledgeProvider('test.knowledge', { lookup: () => [] });
plugins.registerViewContribution('test.view', { render: () => null });
plugins.registerGoalProvider('test.goal', { goals: () => [] });
plugins.registerAnalyzer('test.good', { analyze: async () => ({ ok: true }) });
plugins.registerAnalyzer('test.bad', { analyze: async () => { throw new Error('plugin boom'); } });
const results = await plugins.runAnalyzers({ binary: { hash: 'abc' }, capability: { format: 'elf' } });
assert.equal(results.length, 2);
assert.equal(results.find((x) => x.id === 'test.good').ok, true);
assert.equal(results.find((x) => x.id === 'test.bad').isolated, true);
assert.equal(plugins.failures.length, 1);

// Plugin-visible state is a detached snapshot. A plugin cannot mutate live
// project/binary objects even through nested arrays/objects.
const hostProject = { user: { names: ['coins'] }, findings: { evidence: [{ id: 'e1' }] } };
const hostBinary = { metadata: { sections: ['__text'] } };
plugins.registerAnalyzer('test.mutate', {
  analyze: async (context) => {
    try { context.project.user.names.push('hijacked'); } catch { /* frozen snapshot */ }
    try { context.project.findings.evidence[0].id = 'changed'; } catch { /* frozen snapshot */ }
    try { context.binary.metadata.sections[0] = '__evil'; } catch { /* frozen snapshot */ }
    return { names: context.project.user.names.slice() };
  },
});
const isolated = await plugins.invoke('analyzer', 'test.mutate', 'analyze', { project: hostProject, binary: hostBinary });
assert.equal(isolated.ok, true);
assert.deepEqual(hostProject.user.names, ['coins']);
assert.equal(hostProject.findings.evidence[0].id, 'e1');
assert.deepEqual(hostBinary.metadata.sections, ['__text']);

function restoreGlobal(name, descriptor) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete globalThis[name];
}

async function withLocalStorage(storage, run) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable:true,
    writable:true,
    value:storage,
  });
  try {
    return await run();
  } finally {
    restoreGlobal('localStorage', descriptor);
  }
}

async function withDiscoverySandbox(definitions, run) {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const messageChannelDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'MessageChannel');
  const listeners = new Map();
  const on = (type, handler) => {
    let set = listeners.get(type);
    if (!set) listeners.set(type, set = new Set());
    set.add(handler);
  };
  const off = (type, handler) => listeners.get(type)?.delete(handler);
  const emit = (type, event) => {
    for (const handler of [...(listeners.get(type) || [])]) handler(event);
  };
  const fakeWindow = { addEventListener:on, removeEventListener:off };
  const fakeDocument = {
    createElement(tag) {
      assert.equal(tag, 'iframe');
      const frame = {
        hidden: false,
        referrerPolicy: '',
        srcdoc: '',
        setAttribute() {},
        remove() {},
        contentWindow: {
          postMessage(message, _origin, transfer) {
            if (message?.t !== 'init') return;
            const port = transfer?.[0];
            assert.ok(port, 'sandbox init must transfer a MessagePort');
            port.onmessage = (event) => {
              if (event.data?.t === 'start') {
                port.postMessage({ t:'done', value:definitions });
              }
            };
            port.start?.();
            port.postMessage({ t:'ready' });
          },
        },
      };
      return frame;
    },
    body: {
      append(frame) {
        queueMicrotask(() => emit('message', {
          source:frame.contentWindow,
          data:{ t:'hexSandboxFrameReady' },
        }));
      },
    },
  };

  Object.defineProperty(globalThis, 'window', { configurable:true, writable:true, value:fakeWindow });
  Object.defineProperty(globalThis, 'document', { configurable:true, writable:true, value:fakeDocument });
  Object.defineProperty(globalThis, 'MessageChannel', { configurable:true, writable:true, value:NodeMessageChannel });
  try {
    return await run();
  } finally {
    restoreGlobal('MessageChannel', messageChannelDescriptor);
    restoreGlobal('document', documentDescriptor);
    restoreGlobal('window', windowDescriptor);
  }
}

function persistedManifest(host) {
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let raw = null;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable:true,
    writable:true,
    value:{ setItem(_key, value) { raw = value; } },
  });
  try {
    const saved = PluginHost.prototype.save.call(host);
    assert.equal(saved.ok, true);
    return JSON.parse(raw);
  } finally {
    restoreGlobal('localStorage', storageDescriptor);
  }
}

const failingStorage = {
  setItem() { throw new Error('quota'); },
};
const oldInstallation = {
  v:3,
  installationId:'old',
  source:'hex.plugin({ name:"Old", run() {} })',
  origin:'test',
  definitions:[
    { index:0, name:'Old', description:'' },
    { index:1, name:'Disabled', description:'kept metadata' },
  ],
  enabledIndexes:[0],
};
const oldPlugin = {
  id:'old:0',
  installationId:'old',
  index:0,
  name:'Old',
  description:'',
  source:oldInstallation.source,
  origin:'test',
};

// #3650: a real localStorage failure during clear must roll back both halves
// of the logical registry, including disabled-definition manifest metadata.
const clearHost = Object.create(PluginHost.prototype);
clearHost.plugins = [oldPlugin];
clearHost.installations = new Map([['old', oldInstallation]]);
const clearInstallationsRef = clearHost.installations;
const clearResult = await withLocalStorage(failingStorage, () => clearHost.clear());
assert.equal(clearResult.ok, false);
assert.equal(clearResult.persistenceError, true);
assert.deepEqual(clearHost.plugins, [oldPlugin]);
assert.equal(clearHost.installations, clearInstallationsRef, 'rollback preserves Map identity');
assert.equal(clearHost.installations.get('old'), oldInstallation);
assert.equal(clearHost.installations.get('old').definitions[1].name, 'Disabled');
const clearRetryManifest = persistedManifest(clearHost);
assert.deepEqual(clearRetryManifest.map((entry) => entry.installationId), ['old']);
assert.equal(clearRetryManifest[0].definitions.length, 2);

// The install failure path uses the same transaction rollback and must not
// leave a phantom installation after the real persistence boundary fails.
const installHost = Object.create(PluginHost.prototype);
installHost.app = Object.create(null);
installHost.plugins = [oldPlugin];
installHost.installations = new Map([['old', oldInstallation]]);
const installResult = await withLocalStorage(
  failingStorage,
  () => withDiscoverySandbox(
    [{ name:'New', description:'' }],
    () => installHost.install('hex.plugin({ name:"New", run() {} })', 'test', { installationId:'new' }),
  ),
);
assert.equal(installResult.persistenceError, true);
assert.deepEqual(installHost.plugins, [oldPlugin]);
assert.equal(installHost.installations.size, 1);
assert.equal(installHost.installations.get('old'), oldInstallation);
assert.equal(installHost.installations.has('new'), false);
const retryManifest = persistedManifest(installHost);
assert.deepEqual(retryManifest.map((entry) => entry.installationId), ['old']);
assert.equal(retryManifest[0].definitions.length, 2);

// Successful mutations retain the existing behavior.
const successHost = Object.create(PluginHost.prototype);
successHost.app = Object.create(null);
successHost.plugins = [];
successHost.installations = new Map();
successHost.save = () => ({ ok:true });
const installSuccess = await withDiscoverySandbox(
  [{ name:'New', description:'' }],
  () => successHost.install('hex.plugin({ name:"New", run() {} })', 'test', { installationId:'new' }),
);
assert.equal(installSuccess.ok, true);
assert.equal(successHost.plugins.length, 1);
assert.equal(successHost.installations.has('new'), true);
assert.equal(successHost.clear().ok, true);
assert.equal(successHost.plugins.length, 0);
assert.equal(successHost.installations.size, 0);

console.log('plugin-platform: PASS');
