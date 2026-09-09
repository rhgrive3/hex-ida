import assert from 'node:assert/strict';
import test from 'node:test';
import { PlatformPluginRegistry } from '../js/platform/plugin-api.js';
import { ResourceBudget } from '../js/core/budgets/index.js';

function registerProbe(registry, id, onAnalyze) {
  registry.registerAnalyzer(id, {
    async analyze(context) {
      context.resourceBudget.consume('workUnits', 1);
      return onAnalyze(context.resourceBudget.scopePath);
    },
  });
}

test('issue #5151 repeated invocations retain plugin-specific budget scopes', async () => {
  const registry = new PlatformPluginRegistry();
  const root = new ResourceBudget({ workUnits: 100 });
  const seen = [];
  registerProbe(registry, 'issue5151.repeat', (scopePath) => {
    seen.push(scopePath);
    return scopePath;
  });

  for (let i = 0; i < 10; i += 1) {
    const result = await registry.invoke('analyzer', 'issue5151.repeat', 'analyze', { resourceBudget: root }, {});
    assert.equal(result.ok, true);
  }

  assert.equal(seen.length, 10);
  assert.ok(seen.every((path) => path !== 'root'), 'no invocation may fall back to the root budget');
  assert.ok(seen.every((path) => path.startsWith('root/analyzer.issue5151.repeat.analyze')));
  assert.equal(new Set(seen).size, 10, 'each invocation gets collision-free scope identity');
  assert.equal(root.used.workUnits, 10);

  const snapshot = root.snapshot({ recursive: true });
  assert.equal(snapshot.children.length, 10);
  assert.ok(snapshot.children.every((child) => child.scopePath.startsWith('root/analyzer.issue5151.repeat.analyze')));
  assert.deepEqual(snapshot.children.map((child) => child.used.workUnits), Array(10).fill(1));
});

test('issue #5151 concurrent invocations cannot collide or widen to root', async () => {
  const registry = new PlatformPluginRegistry();
  const root = new ResourceBudget({ workUnits: 100 });
  const seen = [];
  registerProbe(registry, 'issue5151.concurrent', async (scopePath) => {
    await Promise.resolve();
    seen.push(scopePath);
    return scopePath;
  });

  const results = await Promise.all(Array.from({ length: 10 }, () =>
    registry.invoke('analyzer', 'issue5151.concurrent', 'analyze', { resourceBudget: root }, {})));

  assert.ok(results.every((result) => result.ok === true));
  assert.equal(new Set(seen).size, 10);
  assert.ok(seen.every((path) => path !== 'root'));
  assert.equal(root.used.workUnits, 10);
});

test('issue #5151 separate registries sharing one root do not reuse scope identity', async () => {
  const root = new ResourceBudget({ workUnits: 100 });
  const paths = [];
  const registries = [new PlatformPluginRegistry(), new PlatformPluginRegistry()];
  for (const [index, registry] of registries.entries()) {
    registerProbe(registry, 'issue5151.shared-root', (scopePath) => {
      paths.push(scopePath);
      return index;
    });
  }

  const results = await Promise.all(registries.map((registry) =>
    registry.invoke('analyzer', 'issue5151.shared-root', 'analyze', { resourceBudget: root }, {})));

  assert.ok(results.every((result) => result.ok === true));
  assert.equal(new Set(paths).size, 2);
  assert.ok(paths.every((path) => path !== 'root'));
  assert.equal(root.used.workUnits, 2);
});

test('issue #5151 root limits remain cumulative across unique invocation scopes', async () => {
  const registry = new PlatformPluginRegistry();
  const root = new ResourceBudget({ workUnits: 1 });
  registerProbe(registry, 'issue5151.limit', (scopePath) => scopePath);

  const first = await registry.invoke('analyzer', 'issue5151.limit', 'analyze', { resourceBudget: root }, {});
  const second = await registry.invoke('analyzer', 'issue5151.limit', 'analyze', { resourceBudget: root }, {});

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.match(second.error, /Resource budget exceeded/);
  assert.equal(root.used.workUnits, 1, 'failed ancestor preflight must not weaken or increment the root limit');
  assert.equal(root.children.size, 2);
});

test('issue #5151 scope creation failure is isolated instead of falling back to root', async () => {
  const registry = new PlatformPluginRegistry();
  let ran = false;
  registry.registerAnalyzer('issue5151.failclosed', {
    analyze() {
      ran = true;
      return { ok: true };
    },
  });

  const brokenRoot = {
    scopePath: 'root',
    scope() { throw new Error('synthetic-scope-failure'); },
    consume() { throw new Error('root budget must not be exposed to plugin'); },
  };
  const result = await registry.invoke(
    'analyzer',
    'issue5151.failclosed',
    'analyze',
    { resourceBudget: brokenRoot },
    {},
  );

  assert.equal(result.ok, false);
  assert.equal(result.isolated, true);
  assert.match(result.error, /synthetic-scope-failure/);
  assert.equal(ran, false, 'plugin must not run with widened root authority');
});
