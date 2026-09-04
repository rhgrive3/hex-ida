import test from 'node:test';
import assert from 'node:assert/strict';
import { PlatformPluginRegistry } from '../js/platform/plugin-api.js';

test('issue 6228: rejects structured and non-numeric read budget and falls back to default', async () => {
  const reg = new PlatformPluginRegistry();
  reg.registerFormat('format.readtest', {
    async detect(ctx) {
      // DEFAULT_READ_CALL_BYTES is 1 MiB (1048576)
      // If ['16777216'] was coerced, a 2 MiB read would succeed.
      // With strict positive integer check, it falls back to 1 MiB, so 2 MiB fails.
      return ctx.read(0n, 2 * 1024 * 1024);
    },
  });

  const mockContext = (policy) => ({
    pluginPolicy: policy,
    read: async (at, bytes) => new Uint8Array(bytes),
  });

  // Array budget value: must NOT expand default read limit
  const resArray = await reg.invoke('format', 'format.readtest', 'detect', mockContext({
    binaryRead: true,
    maxReadBytes: ['16777216'],
  }));
  assert.equal(resArray.ok, false);
  assert.match(resArray.error, /exceeds per-call limit/);

  // String budget value: must NOT expand default read limit
  const resString = await reg.invoke('format', 'format.readtest', 'detect', mockContext({
    binaryRead: true,
    maxReadBytes: '16777216',
  }));
  assert.equal(resString.ok, false);
  assert.match(resString.error, /exceeds per-call limit/);

  // Boolean budget value: must NOT expand default read limit
  const resBool = await reg.invoke('format', 'format.readtest', 'detect', mockContext({
    binaryRead: true,
    maxReadBytes: true,
  }));
  assert.equal(resBool.ok, false);
  assert.match(resBool.error, /exceeds per-call limit/);

  // Valid primitive integer: successfully expands limit
  const resValid = await reg.invoke('format', 'format.readtest', 'detect', mockContext({
    binaryRead: true,
    maxReadBytes: 4 * 1024 * 1024,
    maxTotalReadBytes: 8 * 1024 * 1024,
  }));
  assert.equal(resValid.ok, true);
});

test('issue 6228: rejects structured timeout and falls back to default', async () => {
  // Registry timeout with array
  const regCoerced = new PlatformPluginRegistry({ timeoutMs: ['600000'] });
  assert.equal(regCoerced.timeoutMs, 15000, 'array timeoutMs must fall back to DEFAULT_TIMEOUT_MS');

  // Registry timeout with string
  const regStr = new PlatformPluginRegistry({ timeoutMs: '600000' });
  assert.equal(regStr.timeoutMs, 15000, 'string timeoutMs must fall back to DEFAULT_TIMEOUT_MS');

  // Fast timeout with valid number
  const regFast = new PlatformPluginRegistry({ timeoutMs: 30 });
  regFast.registerFormat('format.slow', {
    async detect() {
      await new Promise((r) => setTimeout(r, 100));
      return true;
    },
  });

  const res = await regFast.invoke('format', 'format.slow', 'detect', {});
  assert.equal(res.ok, false);
  assert.ok(res.timeout, 'should time out with valid numeric timeout');

  // Array timeoutMs in invoke option should not override to 600000ms
  const resInvokeCoerced = await regFast.invoke('format', 'format.slow', 'detect', {}, {
    timeoutMs: ['600000'],
  });
  assert.equal(resInvokeCoerced.ok, false);
  assert.ok(resInvokeCoerced.timeout, 'array timeoutMs in invoke option must fall back to registry default');
});

test('issue 6228: read capability requires strict primitive integer length', async () => {
  const reg = new PlatformPluginRegistry();
  let caughtError = null;
  reg.registerFormat('format.readlen', {
    async detect(ctx, badLen) {
      try {
        await ctx.read(0n, badLen);
      } catch (err) {
        caughtError = err;
        throw err;
      }
    },
  });

  const badLengths = [
    ['4096'],
    '4096',
    true,
    { valueOf() { return 4096; } },
    1.5,
  ];

  for (const badLen of badLengths) {
    caughtError = null;
    const res = await reg.invoke('format', 'format.readlen', 'detect', {
      pluginPolicy: { binaryRead: true },
      read: async (at, bytes) => new Uint8Array(bytes),
    }, badLen);
    assert.equal(res.ok, false);
    assert.ok(caughtError instanceof TypeError, `length ${JSON.stringify(badLen)} should throw TypeError`);
    assert.match(caughtError.message, /plugin read length must be an integer/);
  }

  // Negative integer throws RangeError
  caughtError = null;
  const resNeg = await reg.invoke('format', 'format.readlen', 'detect', {
    pluginPolicy: { binaryRead: true },
    read: async (at, bytes) => new Uint8Array(bytes),
  }, -1);
  assert.equal(resNeg.ok, false);
  assert.ok(caughtError instanceof RangeError, 'negative length should throw RangeError');

  // Valid length succeeds
  const resValid = await reg.invoke('format', 'format.readlen', 'detect', {
    pluginPolicy: { binaryRead: true },
    read: async (at, bytes) => new Uint8Array(bytes),
  }, 1024);
  assert.equal(resValid.ok, true);
});
