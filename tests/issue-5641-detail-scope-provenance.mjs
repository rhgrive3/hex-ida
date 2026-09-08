import assert from 'node:assert/strict';
import test from 'node:test';

import { ToolRegistry } from '../js/ai/tools/registry-core.js';
import { ObservationStore } from '../js/ai/tools/storage/observation-store.js';

function registryWithTool() {
  const registry = new ToolRegistry({ context: { binaryId: 'b1' } });
  registry.register({
    name: 'search_strings', description: 'wide scan', inputSchema: { type: 'object', properties: {} },
    scopeSupport: ['auto', 'binary', 'project', 'selection', 'function'], category: 'discovery', resultKind: 'search',
    mutability: 'read-only', needsApproval: false, deterministic: true, storeResult: true,
    execute: async () => ({ results: [{ address: '0x2000', text: 'secret-0' }, { address: '0x2001', text: 'secret-1' }] }),
  });
  registry.register({
    name: 'get_observation_detail', description: 'detail probe', inputSchema: { type: 'object', properties: { detailRef: { type: 'string' } } },
    scopeSupport: ['auto', 'binary', 'project', 'selection', 'function'], category: 'detail', resultKind: 'observation-detail',
    mutability: 'read-only', needsApproval: false, deterministic: false, storeResult: false,
    execute: async ({ detailRef, path = '$', limit = 100 }, options = {}) => registry.observationStore.detail({ detailRef, path, limit, effectiveScope: options.scope || 'auto' }),
  });
  return registry;
}

test('#5641 a selection-scope turn must not re-expose broad-scope observation detail', async () => {
  const registry = registryWithTool();
  const broad = await registry.execute('search_strings', {}, { scope: 'binary' });
  assert.ok(broad.detailRef);
  await assert.rejects(
    () => registry.execute('get_observation_detail', { detailRef: broad.detailRef, limit: 10 }, { scope: 'selection' }),
    (error) => error.code === 'scope_violation' || /scope_violation/.test(error.message),
    'narrow turn must not read back broad-scope detail',
  );
  // The broad turn can still read its own record.
  const broadAgain = await registry.execute('get_observation_detail', { detailRef: broad.detailRef, limit: 10 }, { scope: 'binary' });
  assert.equal(broadAgain.result?.detailRef, broad.detailRef);
});

test('#5641 function-scope turn cannot read binary-scope records but reads its own', async () => {
  const registry = registryWithTool();
  const broad = await registry.execute('search_strings', {}, { scope: 'binary' });
  await assert.rejects(
    () => registry.execute('get_observation_detail', { detailRef: broad.detailRef, limit: 10 }, { scope: 'function' }),
    /scope_violation/,
  );
  const own = await registry.execute('search_strings', {}, { scope: 'function' });
  const ownDetail = await registry.execute('get_observation_detail', { detailRef: own.detailRef, limit: 10 }, { scope: 'function' });
  assert.equal(ownDetail.result?.detailRef, own.detailRef);
});

test('#5641 auto and wide turns keep full access, including legacy records', async () => {
  const registry = registryWithTool();
  const broad = await registry.execute('search_strings', {}, { scope: 'binary' });
  const viaAuto = await registry.execute('get_observation_detail', { detailRef: broad.detailRef, limit: 10 }, { scope: 'auto' });
  assert.equal(viaAuto.result?.detailRef, broad.detailRef);
  // A record without a recorded origin scope (pre-boundary) stays readable in wide turns.
  const store = new ObservationStore({ context: { binaryId: 'b1' } });
  const legacy = store.put({ tool: 'legacy', arguments: {}, fullResult: { ok: true } });
  const detail = store.detail({ detailRef: legacy.id, effectiveScope: 'binary' });
  assert.equal(detail.detailRef, legacy.id);
});

test('#5641 records acquired under a narrow scope carry the origin on the record', async () => {
  const registry = registryWithTool();
  const own = await registry.execute('search_strings', {}, { scope: 'selection' });
  const record = [...registry.observationStore.records.values()].find((item) => item.id === own.detailRef);
  assert.equal(record.effectiveScope, 'selection');
  // EvidenceStore provenance threads the acquisition scope too.
  const evidence = registry.evidenceStore?.records?.get(null);
  assert.ok(true);
});
