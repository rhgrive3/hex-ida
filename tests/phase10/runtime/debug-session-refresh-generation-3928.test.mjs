import assert from 'node:assert/strict';
import test from 'node:test';

import { DebugSession } from '../../../js/runtime/session.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve=res; reject=rej; });
  return { promise, resolve, reject };
}

function adapterFixture(overrides = {}) {
  return {
    id:'refresh-fixture',
    kind:'fixture',
    capabilities:{ modules:false, threads:false },
    async disconnect() {},
    ...overrides,
  };
}

test('P10 DebugSession ignores refresh results from an obsolete epoch (#3928)', async () => {
  const modules = deferred();
  const adapter = adapterFixture({
    capabilities:{ modules:true, threads:false },
    getModules() { return modules.promise; },
  });
  const session = new DebugSession(adapter,{ id:'refresh-epoch' });

  const pending = session.refreshState();
  assert.equal(session.newEpoch(),2);
  modules.resolve([{ id:'epoch-1-module' }]);
  await pending;

  assert.deepEqual(session.modules,[]);
  assert.deepEqual(session.refreshErrors,{ modules:null, threads:null });
});

test('P10 newer concurrent refresh remains authoritative when the older request resolves last (#3928)', async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const adapter = adapterFixture({
    capabilities:{ modules:true, threads:false },
    getModules() { return ++calls === 1 ? first.promise : second.promise; },
  });
  const session = new DebugSession(adapter,{ id:'refresh-order' });

  const older = session.refreshState();
  const newer = session.refreshState();
  second.resolve([{ id:'new-module' }]);
  await newer;
  assert.deepEqual(session.modules,[{ id:'new-module' }]);

  first.resolve([{ id:'old-module' }]);
  await older;
  assert.deepEqual(session.modules,[{ id:'new-module' }]);
});

test('P10 stale refresh failure cannot overwrite a newer successful refresh error state (#3928)', async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const adapter = adapterFixture({
    capabilities:{ modules:true, threads:false },
    getModules() { return ++calls === 1 ? first.promise : second.promise; },
  });
  const session = new DebugSession(adapter,{ id:'refresh-errors' });
  session.refreshErrors.modules={ code:'previous', message:'previous failure' };

  const older = session.refreshState();
  const newer = session.refreshState();
  second.resolve([{ id:'current-module' }]);
  await newer;
  assert.equal(session.refreshErrors.modules,null);

  first.reject(new Error('stale failure'));
  await older;
  assert.deepEqual(session.modules,[{ id:'current-module' }]);
  assert.equal(session.refreshErrors.modules,null);
});

test('P10 current refresh atomically publishes modules, threads, and errors (#3928)', async () => {
  const adapter = adapterFixture({
    capabilities:{ modules:true, threads:true },
    async getModules() { return [{ id:'module-current' }]; },
    async getThreads() { return [{ id:7 }]; },
  });
  const session = new DebugSession(adapter,{ id:'refresh-current' });
  session.refreshErrors={
    modules:{ code:'old-modules', message:'old modules error' },
    threads:{ code:'old-threads', message:'old threads error' },
  };

  const result = await session.refreshState();

  assert.deepEqual(session.modules,[{ id:'module-current' }]);
  assert.deepEqual(session.threads,[{ id:7 }]);
  assert.deepEqual(session.refreshErrors,{ modules:null, threads:null });
  assert.deepEqual(result,{
    modules:[{ id:'module-current' }],
    threads:[{ id:7 }],
    errors:{ modules:null, threads:null },
  });
});

test('P10 disconnect during refresh prevents late publication into a closed session (#3928)', async () => {
  const modules = deferred();
  const adapter = adapterFixture({
    capabilities:{ modules:true, threads:false },
    getModules() { return modules.promise; },
  });
  const session = new DebugSession(adapter,{ id:'refresh-close' });
  session.modules=[{ id:'existing-module' }];

  const pending = session.refreshState();
  await session.disconnect();
  modules.resolve([{ id:'late-module' }]);
  await pending;

  assert.equal(session.closed,true);
  assert.deepEqual(session.modules,[{ id:'existing-module' }]);
  assert.deepEqual(session.refreshErrors,{ modules:null, threads:null });
});
