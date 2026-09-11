import assert from 'node:assert/strict';
import test from 'node:test';
import { CapabilityCatalog } from '../js/ai/capabilities/catalog.js';
import { assertSchema } from '../js/ai/validation.js';
import { CapabilityExecutor } from '../js/ai/capabilities/executor.js';
import { createActionRunner } from '../js/ai/interaction/actions.js';

function workbench() {
  const calls = [];
  const app = {
    store: { get: () => null, set: () => {} },
    goToAddress: (addr) => { calls.push(['goToAddress', String(addr)]); return true; },
    goToFunction: () => { calls.push(['goToFunction']); },
    viewer: null,
    semantic: null,
  };
  const ui = { router: { navigated: [], navigate(path) { this.navigated.push(path); } } };
  return { app, ui, calls, runAction: createActionRunner(app, { ui, assistant: null }) };
}

test("issue #5383 - schema-valid empty args do not crash open-evidence with a raw TypeError", async () => {
  const catalog = new CapabilityCatalog();
  const entry = catalog.get('navigation.open-evidence');
  const args = {};
  assert.doesNotThrow(() => assertSchema(args, entry.inputSchema), 'empty args pass the published schema');

  const { app, ui, calls, runAction } = workbench();
  const executor = new CapabilityExecutor({ app, catalog, actionRunner: runAction });
  // On main this escaped as `TypeError: Cannot convert null to a BigInt`.
  await executor.execute('navigation.open-evidence', args);
  assert.deepEqual(calls, [], 'no navigation without an address');
  assert.deepEqual(ui.router.navigated, []);
});

test("issue #5383 - valid address still navigates to the evidence row", async () => {
  const catalog = new CapabilityCatalog();
  const { app, ui, calls, runAction } = workbench();
  const executor = new CapabilityExecutor({ app, catalog, actionRunner: runAction });
  await executor.execute('navigation.open-evidence', { address: '0x1100' });
  assert.deepEqual(calls, [['goToAddress', '4352']]); // BigInt('0x1100')
  assert.deepEqual(ui.router.navigated, ['/code/4352']);
});

test("issue #5383 - other navigation actions keep their null guards", async () => {
  const catalog = new CapabilityCatalog();
  const { app, ui, calls, runAction } = workbench();
  const executor = new CapabilityExecutor({ app, catalog, actionRunner: runAction });
  for (const id of ['navigation.open-function', 'navigation.show-xrefs', 'navigation.show-cfg', 'navigation.trace-value']) {
    await executor.execute(id, {});
  }
  assert.deepEqual(calls, [], 'no navigation without an address');
  assert.deepEqual(ui.router.navigated, [], 'no routing without an address');
});
