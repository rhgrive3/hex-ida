import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeAnalysisPlatform } from '../../../js/runtime/index.js';

function assertInvalidAdapterName(fn) {
  assert.throws(fn, (error) => error?.code === 'invalid-adapter-name');
}

test('#4303 structured registration cannot alias or replace a canonical adapter name', () => {
  const platform = new RuntimeAnalysisPlatform({ symbolic:false });
  const good = { id:'good' };
  const bad = { id:'bad' };
  platform.registerAdapter('local', good);

  assertInvalidAdapterName(() => platform.registerAdapter(['local'], bad));
  assertInvalidAdapterName(() => platform.registerAdapter('   ', bad));
  assert.strictEqual(platform.adapter('local'), good);
});

test('#4303 lookup accepts only explicit non-empty primitive string names', () => {
  const platform = new RuntimeAnalysisPlatform({ symbolic:false });
  const local = { id:'local' };
  platform.registerAdapter('local', local);

  for (const bad of [['local'], {}, new String('local'), 7, true, false, 0, 1n, Symbol('local'), '', ' \t\n ']) {
    assertInvalidAdapterName(() => platform.adapter(bad));
  }

  let coercions = 0;
  const hostile = {
    toString() { coercions++; return 'local'; },
    valueOf() { coercions++; return 'local'; },
  };
  assertInvalidAdapterName(() => platform.adapter(hostile));
  assert.equal(coercions, 0, 'adapter-name validation must not execute coercion hooks');
  assert.strictEqual(platform.adapter('local'), local);
});

test('#4303 default lookup and exact valid-string replacement semantics are preserved', async () => {
  const platform = new RuntimeAnalysisPlatform({ symbolic:false });
  const first = { id:'first' };
  const replacement = { id:'replacement' };
  const spaced = { id:'spaced' };
  platform.registerAdapter('local', first);

  assert.strictEqual(platform.adapter(), first);
  assert.strictEqual(platform.adapter(null), first);
  assert.strictEqual(platform.adapter(undefined), first);

  platform.registerAdapter('local', replacement);
  assert.strictEqual(platform.adapter('local'), replacement);

  platform.registerAdapter(' local ', spaced);
  assert.strictEqual(platform.adapter(' local '), spaced, 'valid non-empty string keys remain exact');
  assert.strictEqual(platform.adapter('local'), replacement, 'validation must not trim/canonicalize existing key semantics');

  const active = { id:'active', kind:'fixture' };
  await platform.startSession({ adapter:active, connect:false });
  assert.strictEqual(platform.adapter(), active, 'current-session adapter remains the default authority');
  assert.strictEqual(platform.adapter(null), active);
});

test('#4303 remote/replay factories validate names before constructing adapters', () => {
  const platform = new RuntimeAnalysisPlatform({ symbolic:false });
  let invalidFactoryTouches = 0;
  const poisonTransport = {};
  Object.defineProperty(poisonTransport, 'send', { get() { invalidFactoryTouches++; throw new Error('transport touched'); } });
  Object.defineProperty(poisonTransport, 'onMessage', { get() { invalidFactoryTouches++; throw new Error('transport touched'); } });
  const poisonOptions = { get kind() { invalidFactoryTouches++; throw new Error('options touched'); } };

  assertInvalidAdapterName(() => platform.createRemote(['remote'], poisonTransport, poisonOptions));
  assert.equal(invalidFactoryTouches, 0, 'invalid remote identity must fail before adapter/transport/options side effects');
  assertInvalidAdapterName(() => platform.createReplay({ name:'replay' }, {}));

  let subscriptions = 0;
  const transport = {
    send() {},
    onMessage() { subscriptions++; return () => {}; },
  };
  const remote = platform.createRemote('remote', transport);
  assert.ok(remote);
  assert.equal(subscriptions, 1);
  assert.strictEqual(platform.adapter('remote'), remote);
});
