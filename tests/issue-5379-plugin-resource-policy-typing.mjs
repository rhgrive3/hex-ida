// Regression for #5379: plugin timeout/binary-read resource limits must not be
// produced by raw Number() coercion of structured values. Array/boolean/
// numeric-string settings must never be promoted into the authoritative
// resource policy (isolation timeout, per-call/total binary read budget);
// malformed values must fall back to the defaults or be rejected explicitly.
import assert from 'node:assert/strict';
import { PlatformPluginRegistry } from '../js/platform/plugin-api.js';

const DEFAULT_TIMEOUT_MS = 15_000;

// Registry-wide timeout: structured coercion inputs never become the policy.
assert.equal(new PlatformPluginRegistry().timeoutMs, DEFAULT_TIMEOUT_MS);
assert.equal(new PlatformPluginRegistry({ timeoutMs: 2_500 }).timeoutMs, 2_500);
assert.throws(() => new PlatformPluginRegistry({ timeoutMs: ['1'] }), TypeError);
assert.throws(() => new PlatformPluginRegistry({ timeoutMs: true }), TypeError);
assert.throws(() => new PlatformPluginRegistry({ timeoutMs: '10' }), TypeError);
assert.throws(() => new PlatformPluginRegistry({ timeoutMs: 1.5 }), TypeError);
assert.throws(() => new PlatformPluginRegistry({ timeoutMs: Number.MAX_SAFE_INTEGER + 10 }), TypeError);

// Per-invocation timeout: a numeric string must not shrink the effective
// isolation window, and it is not silently promoted either.
{
  const registry = new PlatformPluginRegistry({ timeoutMs: 1_000 });
  registry.registerAnalyzer('issue5379.slow', {
    async analyze() { await new Promise((r) => setTimeout(r, 30)); return 'done'; },
  });
  const coerced = await registry.invoke('analyzer', 'issue5379.slow', 'analyze', {}, { timeoutMs: '10' });
  assert.equal(coerced.ok, false);
  assert.notEqual(coerced.timeout, true, 'a malformed per-invocation timeout must not become a live 10ms budget');
  assert.match(coerced.error, /timeoutMs/);
  const primitive = await registry.invoke('analyzer', 'issue5379.slow', 'analyze', {}, { timeoutMs: 1_000 });
  assert.equal(primitive.ok, true);
  const expired = await registry.invoke('analyzer', 'issue5379.slow', 'analyze', {}, { timeoutMs: 5 });
  assert.equal(expired.ok, false);
  assert.equal(expired.timeout, true);
}

// Binary read policy: malformed byte limits never reach the read capability,
// and valid primitive limits keep enforcing the boundary.
{
  const registry = new PlatformPluginRegistry({ timeoutMs: 1_000 });
  registry.registerAnalyzer('issue5379.reader', {
    async analyze(context) {
      const four = await context.read(0n, 4);
      return four.byteLength;
    },
  });
  const context = (pluginPolicy) => ({
    pluginPolicy,
    read: async (_at, length) => new Uint8Array(length),
  });
  const malformed = await registry.invoke(
    'analyzer', 'issue5379.reader', 'analyze',
    context({ binaryRead: true, maxReadBytes: ['1'], maxTotalReadBytes: '2' }),
  );
  assert.equal(malformed.ok, false);
  assert.match(malformed.error, /maxReadBytes|maxTotalReadBytes/);

  const coerced = await registry.invoke(
    'analyzer', 'issue5379.reader', 'analyze',
    context({ binaryRead: true, maxReadBytes: '8', maxTotalReadBytes: true }),
  );
  assert.equal(coerced.ok, false);
  assert.match(coerced.error, /positive safe integer/);

  const unbounded = await registry.invoke(
    'analyzer', 'issue5379.reader', 'analyze',
    context({ binaryRead: true }),
  );
  assert.equal(unbounded.ok, true);
  assert.equal(unbounded.value, 4, 'well-formed policy keeps the default read budget');

  registry.registerAnalyzer('issue5379.clamped', {
    async analyze(context) {
      const small = await context.read(0n, 4);
      let bigError = null;
      try { await context.read(0n, 9); } catch (error) { bigError = error.message; }
      return [small.byteLength, bigError];
    },
  });
  const clamped = await registry.invoke(
    'analyzer', 'issue5379.clamped', 'analyze',
    context({ binaryRead: true, maxReadBytes: 8, maxTotalReadBytes: 32 }),
  );
  assert.equal(clamped.ok, true);
  assert.equal(clamped.value[0], 4);
  assert.match(clamped.value[1], /per-call limit \(8 bytes\)/);
}

console.log('issue 5379 typed plugin resource policy boundary: PASS');
