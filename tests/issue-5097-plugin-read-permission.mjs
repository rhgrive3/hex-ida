import assert from 'node:assert/strict';
import { PlatformPluginRegistry } from '../js/platform/plugin-api.js';

function manifest(id, permissions) {
  return {
    id, name: `P ${id}`, version: '1.0.0', apiVersion: '2.0.0',
    permissions, supportedTargets: ['*'],
    contributions: [{ type: 'analyzer', id: `${id}-a`, contractVersion: '1.0.0', capabilities: [] }],
  };
}
async function tryRead(registry, contribId, ctx) {
  return registry.invoke('analyzer', contribId, 'analyze', ctx);
}
function echoImpl() {
  return {
    async analyze(ctx) {
      const bytes = await ctx.read(0n, 1);
      return [...bytes];
    },
  };
}
const readCtx = (policy) => ({
  read: async () => Uint8Array.of(0x41),
  pluginPolicy: policy,
});

// 1. manifest binaryRead:false + policy grant + valid range -> deny
{
  const r = new PlatformPluginRegistry();
  r.registerPlugin(manifest('test.no-read', { binaryRead: false }), { 'test.no-read-a': echoImpl() });
  const res = await tryRead(r, 'test.no-read-a', readCtx({ binaryRead: true, readRanges: [{ start: 0n, size: 16n }] }));
  assert.equal(res.ok, false, 'manifest denied must not read');
}

// 2. manifest permission省略 + valid range -> deny
{
  const m = manifest('test.omit', undefined);
  delete m.permissions;
  const r = new PlatformPluginRegistry();
  r.registerPlugin(m, { 'test.omit-a': echoImpl() });
  const res = await tryRead(r, 'test.omit-a', readCtx({ binaryRead: true, readRanges: [{ start: 0n, size: 16n }] }));
  assert.equal(res.ok, false, 'omitted permission must not read');
}

// 3. manifest true + policy false + valid range -> deny
{
  const r = new PlatformPluginRegistry();
  r.registerPlugin(manifest('test.pol', { binaryRead: true }), { 'test.pol-a': echoImpl() });
  const res = await tryRead(r, 'test.pol-a', readCtx({ binaryRead: false, readRanges: [{ start: 0n, size: 16n }] }));
  assert.equal(res.ok, false, 'policy denied must not read');
}

// 4. both true + in-range -> allow
{
  const r = new PlatformPluginRegistry();
  r.registerPlugin(manifest('test.ok', { binaryRead: true }), { 'test.ok-a': echoImpl() });
  const res = await tryRead(r, 'test.ok-a', readCtx({ binaryRead: true, readRanges: [{ start: 0n, size: 16n }] }));
  assert.equal(res.ok, true);
  assert.deepEqual(res.value, [0x41]);
}

// 5. both true + out-of-range -> deny
{
  const r = new PlatformPluginRegistry();
  r.registerPlugin(manifest('test.oor', { binaryRead: true }), { 'test.oor-a': echoImpl() });
  const res = await tryRead(r, 'test.oor-a', readCtx({ binaryRead: true, readRanges: [{ start: 0x100n, size: 16n }] }));
  assert.equal(res.ok, false, 'out-of-range must be denied');
}

// 6. both true + no ranges -> allow (existing unrestricted-with-budget behavior)
{
  const r = new PlatformPluginRegistry();
  r.registerPlugin(manifest('test.free', { binaryRead: true }), { 'test.free-a': echoImpl() });
  const res = await tryRead(r, 'test.free-a', readCtx({ binaryRead: true }));
  assert.equal(res.ok, true);
  assert.deepEqual(res.value, [0x41]);
}

// 7. context.binary.readRanges だけでは permission が生えない
{
  const r = new PlatformPluginRegistry();
  r.registerPlugin(manifest('test.ctx', { binaryRead: false }), { 'test.ctx-a': echoImpl() });
  const res = await tryRead(r, 'test.ctx-a', {
    read: async () => Uint8Array.of(0x41),
    pluginPolicy: { binaryRead: false },
    binary: { readRanges: [{ start: 0n, size: 16n }] },
  });
  assert.equal(res.ok, false, 'context ranges must not mint permission');
}

// 8. legacy registerAnalyzer shim は binaryRead:true 互換を維持
{
  const r = new PlatformPluginRegistry();
  r.registerAnalyzer('legacy-ok', echoImpl());
  const res = await tryRead(r, 'legacy-ok', readCtx({ binaryRead: true }));
  assert.equal(res.ok, true);
}

console.log('issue #5097 manifest binaryRead AND policy grant: PASS');
