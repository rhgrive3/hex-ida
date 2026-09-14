import assert from 'node:assert/strict';
import { PlatformPluginRegistry } from '../js/platform/plugin-api.js';
import { ResourceBudget } from '../js/core/budgets/index.js';

function register(registry, id, analyze) {
  registry.registerAnalyzer(id, { analyze });
}

// The plugin-facing budget is a narrow capability, never the live host object.
{
  const registry = new PlatformPluginRegistry();
  const root = new ResourceBudget({ workUnits: 20 });
  let seen;
  register(registry, 'budget.shape', (ctx) => {
    seen = ctx.resourceBudget;
    return { keys: Object.keys(seen).sort() };
  });

  const result = await registry.invoke('analyzer', 'budget.shape', 'analyze', { resourceBudget: root }, {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.keys, ['consume', 'remaining', 'snapshot']);
  assert.equal(Object.getPrototypeOf(seen), null, 'facade must not inherit ResourceBudget/Object implementation surface');
  assert.equal(Object.isFrozen(seen), true);
  for (const hidden of ['parent', 'used', 'children', 'scope', 'scopePath', 'limits', 'signal', 'checkCancelled', 'name']) {
    assert.equal(seen[hidden], undefined, `plugin budget facade must hide ${hidden}`);
  }
}

// Detaching the plugin child cannot bypass an ancestor limit.
{
  const registry = new PlatformPluginRegistry();
  const root = new ResourceBudget({ bytesRead: 4 });
  let tamperRejected = false;
  register(registry, 'budget.detach', (ctx) => {
    try { ctx.resourceBudget.parent = null; } catch { tamperRejected = true; }
    ctx.resourceBudget.consume('bytesRead', 10);
    return { unreachable: true };
  });

  const result = await registry.invoke('analyzer', 'budget.detach', 'analyze', { resourceBudget: root }, {});
  assert.equal(tamperRejected, true);
  assert.equal(result.ok, false);
  assert.match(result.error, /Resource budget exceeded|budget/i);
  assert.equal(root.snapshot().used.bytesRead ?? 0, 0, 'failed ancestor preflight must not mutate usage');
}

// Root accounting cannot be reset through parent/used, and facade methods cannot be replaced.
{
  const registry = new PlatformPluginRegistry();
  const root = new ResourceBudget({ workUnits: 10 });
  root.consume('workUnits', 9);
  let parentTamperRejected = false;
  let methodTamperRejected = false;
  register(registry, 'budget.reset', (ctx) => {
    try { ctx.resourceBudget.parent.used.workUnits = 0; } catch { parentTamperRejected = true; }
    try { ctx.resourceBudget.consume = () => 0; } catch { methodTamperRejected = true; }
    ctx.resourceBudget.consume('workUnits', 1);
    return ctx.resourceBudget.snapshot();
  });

  const result = await registry.invoke('analyzer', 'budget.reset', 'analyze', { resourceBudget: root }, {});
  assert.equal(result.ok, true);
  assert.equal(parentTamperRejected, true);
  assert.equal(methodTamperRejected, true);
  assert.equal(root.snapshot().used.workUnits, 10);
  assert.equal(result.value.used.workUnits, 1, 'plugin snapshot reports only its child-scope usage');
}

// ctx.read() keeps charging the private backing scope and therefore its root ancestor.
{
  const registry = new PlatformPluginRegistry();
  const root = new ResourceBudget({ bytesRead: 4 });
  let hostReads = 0;
  register(registry, 'budget.read', async (ctx) => {
    const bytes = await ctx.read(0n, 4);
    return bytes.byteLength;
  });

  const result = await registry.invoke('analyzer', 'budget.read', 'analyze', {
    resourceBudget: root,
    pluginPolicy: { binaryRead: true, maxReadBytes: 4, maxTotalReadBytes: 4 },
    read: async (_address, length) => {
      hostReads += 1;
      return new Uint8Array(length);
    },
  }, {});
  assert.equal(result.ok, true);
  assert.equal(result.value, 4);
  assert.equal(hostReads, 1);
  assert.equal(root.snapshot().used.bytesRead, 4);
}

// Multiple invocations cannot reset cumulative root accounting even if a later core scope falls back/reuses authority.
{
  const registry = new PlatformPluginRegistry();
  const root = new ResourceBudget({ workUnits: 4 });
  register(registry, 'budget.repeat', (ctx) => {
    try { ctx.resourceBudget.used.workUnits = 0; } catch {}
    try { ctx.resourceBudget.parent.used.workUnits = 0; } catch {}
    ctx.resourceBudget.consume('workUnits', 2);
    return ctx.resourceBudget.remaining('workUnits');
  });

  const first = await registry.invoke('analyzer', 'budget.repeat', 'analyze', { resourceBudget: root }, {});
  const second = await registry.invoke('analyzer', 'budget.repeat', 'analyze', { resourceBudget: root }, {});
  const third = await registry.invoke('analyzer', 'budget.repeat', 'analyze', { resourceBudget: root }, {});
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(third.ok, false, 'cumulative root limit must remain authoritative across invocations');
  assert.equal(root.snapshot().used.workUnits, 4);
}

// Even concurrent invokes that currently take different backing-scope paths never expose a raw budget object.
{
  const registry = new PlatformPluginRegistry();
  const root = new ResourceBudget({ workUnits: 20 });
  register(registry, 'budget.concurrent', async (ctx) => {
    assert.equal(ctx.resourceBudget.parent, undefined);
    assert.equal(ctx.resourceBudget.used, undefined);
    assert.equal(ctx.resourceBudget.children, undefined);
    assert.equal(ctx.resourceBudget.scope, undefined);
    const consume = ctx.resourceBudget.consume;
    consume.call({ parent: null, used: { workUnits: -100 } }, 'workUnits', 1);
    await Promise.resolve();
    return true;
  });

  const results = await Promise.all(Array.from({ length: 8 }, () =>
    registry.invoke('analyzer', 'budget.concurrent', 'analyze', { resourceBudget: root }, {})));
  assert.equal(results.every((result) => result.ok), true);
  assert.equal(root.snapshot().used.workUnits, 8, 'rebinding a facade method must still charge the private backing budget');
}

// A captured facade remains invocation-scoped: after settlement it cannot mutate the host budget.
{
  const registry = new PlatformPluginRegistry();
  const root = new ResourceBudget({ workUnits: 10 });
  let leaked;
  register(registry, 'budget.revoke', (ctx) => {
    leaked = ctx.resourceBudget;
    ctx.resourceBudget.consume('workUnits', 1);
    return true;
  });

  const result = await registry.invoke('analyzer', 'budget.revoke', 'analyze', { resourceBudget: root }, {});
  assert.equal(result.ok, true);
  assert.equal(root.snapshot().used.workUnits, 1);
  assert.throws(() => leaked.consume('workUnits', 1), /no longer active/i);
  assert.throws(() => leaked.remaining('workUnits'), /no longer active/i);
  assert.throws(() => leaked.snapshot(), /no longer active/i);
  assert.equal(root.snapshot().used.workUnits, 1);
}

console.log('issue #5147 plugin budget facade regression: ok');
