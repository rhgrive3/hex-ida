import assert from 'node:assert/strict';
import { PlatformPluginRegistry } from '../js/platform/plugin-api.js';

function manifest(pluginId, analyzerId, binaryRead) {
  return {
    id: pluginId,
    name: pluginId,
    version: '1.0.0',
    apiVersion: '2.0.0',
    permissions: { binaryRead },
    supportedTargets: ['*'],
    contributions: [{
      type: 'analyzer',
      id: analyzerId,
      contractVersion: '1.0.0',
      capabilities: [],
    }],
  };
}

function registerReadAnalyzer(registry, pluginId, analyzerId, binaryRead) {
  registry.registerPlugin(manifest(pluginId, analyzerId, binaryRead), {
    [analyzerId]: {
      async analyze(context, requests = [{ address: 0x1000n, length: 4 }]) {
        const lengths = [];
        for (const request of requests) {
          const bytes = await context.read(request.address, request.length);
          lengths.push(bytes.byteLength);
        }
        return lengths;
      },
    },
  });
}

function hostContext(policy, onRead) {
  return {
    pluginPolicy: policy,
    read: async (_address, length) => {
      onRead();
      return new Uint8Array(length).fill(0x41);
    },
  };
}

{
  const registry = new PlatformPluginRegistry();
  registerReadAnalyzer(registry, 'deny.plugin', 'deny.analyzer', false);
  let hostReads = 0;

  const fullGrant = await registry.invoke(
    'analyzer',
    'deny.analyzer',
    'analyze',
    hostContext({ binaryRead: true }, () => { hostReads++; }),
  );
  assert.equal(fullGrant.ok, false);
  assert.match(fullGrant.error, /plugin binary read permission denied/);

  const rangeGrant = await registry.invoke(
    'analyzer',
    'deny.analyzer',
    'analyze',
    hostContext({
      binaryRead: false,
      readRanges: [{ start: 0x1000n, size: 0x100n }],
    }, () => { hostReads++; }),
  );
  assert.equal(rangeGrant.ok, false);
  assert.match(rangeGrant.error, /plugin binary read permission denied/);
  assert.equal(hostReads, 0, 'manifest denial must stop host reads even when host ranges grant access');
}

{
  const registry = new PlatformPluginRegistry();
  registerReadAnalyzer(registry, 'allow.plugin', 'allow.analyzer', true);
  let hostReads = 0;
  const context = (policy) => hostContext(policy, () => { hostReads++; });

  const noGrant = await registry.invoke(
    'analyzer',
    'allow.analyzer',
    'analyze',
    context({ binaryRead: false }),
  );
  assert.equal(noGrant.ok, false);
  assert.match(noGrant.error, /plugin binary read permission denied/);
  assert.equal(hostReads, 0);

  const inRange = await registry.invoke(
    'analyzer',
    'allow.analyzer',
    'analyze',
    context({ readRanges: [{ start: 0x1000n, size: 0x20n }] }),
  );
  assert.equal(inRange.ok, true);
  assert.deepEqual(inRange.value, [4]);
  assert.equal(hostReads, 1);

  const outsideRange = await registry.invoke(
    'analyzer',
    'allow.analyzer',
    'analyze',
    context({ readRanges: [{ start: 0x1000n, size: 0x20n }] }),
    [{ address: 0x2000n, length: 4 }],
  );
  assert.equal(outsideRange.ok, false);
  assert.match(outsideRange.error, /outside permitted ranges/);
  assert.equal(hostReads, 1, 'out-of-range reads must fail before host I/O');

  const fullGrant = await registry.invoke(
    'analyzer',
    'allow.analyzer',
    'analyze',
    context({ binaryRead: true }),
  );
  assert.equal(fullGrant.ok, true);
  assert.deepEqual(fullGrant.value, [4]);
  assert.equal(hostReads, 2);

  const perCall = await registry.invoke(
    'analyzer',
    'allow.analyzer',
    'analyze',
    context({ binaryRead: true, maxReadBytes: 3, maxTotalReadBytes: 8 }),
  );
  assert.equal(perCall.ok, false);
  assert.match(perCall.error, /exceeds per-call limit/);
  assert.equal(hostReads, 2, 'per-call rejection must happen before host I/O');

  const totalBudget = await registry.invoke(
    'analyzer',
    'allow.analyzer',
    'analyze',
    context({ binaryRead: true, maxReadBytes: 4, maxTotalReadBytes: 6 }),
    [
      { address: 0x1000n, length: 4 },
      { address: 0x1004n, length: 4 },
    ],
  );
  assert.equal(totalBudget.ok, false);
  assert.match(totalBudget.error, /exceeds total budget/);
  assert.equal(hostReads, 3, 'only the first read may reach the host before total-budget rejection');
}

{
  const registry = new PlatformPluginRegistry();
  let hostReads = 0;
  registry.registerAnalyzer('legacy.read', {
    analyze: async (context) => context.read(0x1000n, 4),
  });
  const legacy = await registry.invoke(
    'analyzer',
    'legacy.read',
    'analyze',
    hostContext({ readRanges: [{ start: 0x1000n, size: 0x10n }] }, () => { hostReads++; }),
  );
  assert.equal(legacy.ok, true);
  assert.equal(legacy.value.byteLength, 4);
  assert.equal(hostReads, 1, 'legacy analyzer keeps its explicit binaryRead manifest permission');
}
