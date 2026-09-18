import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSemanticModel } from '../../../js/blocks.js';
import { irFor } from '../../../js/ir.js';
import { semanticFacts } from '../../../js/semantic.js';
import { createAgentTools } from '../../../js/agent/tools.js';
import { createHexToolRegistry } from '../../../js/ai/tools/index.js';

const BASE = 0x1000n;

function constantModel(count, base = BASE) {
  const model = buildSemanticModel([{ row:0, address:base, mn:'ret', ops:'' }], [], []);
  const ir = irFor(model);
  ir.values = Array.from({ length:count }, (_, i) => ({
    id:1000 + i,
    bits:64,
    const:7n,
    def:{ id:2000 + i, row:i, address:base + BigInt(i * 4) },
  }));
  ir.truncated = false;
  return model;
}

function evidenceModel(base = BASE) {
  const model = buildSemanticModel([
    { row:0, address:base, mn:'ldr', ops:'w8, [x0, #0x30]' },
    { row:1, address:base + 4n, mn:'ret', ops:'' },
  ], [], []);
  irFor(model).truncated = false;
  return model;
}

function evidenceIdWithMatches(model, wantedCount) {
  const facts = semanticFacts(irFor(model));
  const counts = new Map();
  for (const fact of facts) {
    for (const evidence of fact.evidence || []) {
      if (!evidence?.id) continue;
      counts.set(evidence.id, (counts.get(evidence.id) || 0) + 1);
    }
  }
  const found = [...counts].find(([, count]) => count === wantedCount)?.[0] ?? null;
  assert.ok(found, `fixture must contain an evidence id referenced by exactly ${wantedCount} fact(s)`);
  return found;
}

function agentFor(model) {
  return createAgentTools({ analyze:async () => model }, { maxFunctions:4 });
}

async function assertPage(result, { returned, total, complete, truncated }) {
  assert.equal(result.returned, returned);
  assert.equal(result.results.length, returned);
  assert.equal(result.total, total);
  assert.equal(result.complete, complete);
  assert.equal(result.truncated, truncated);
  assert.equal(result.reason, truncated ? 'result-limit' : null);
}

test('find_constant distinguishes exact-limit completion from a proven overflow', async () => {
  await assertPage(await agentFor(constantModel(0)).find_constant(7, { functions:[BASE], limit:1 }),
    { returned:0, total:0, complete:true, truncated:false });
  await assertPage(await agentFor(constantModel(1)).find_constant(7, { functions:[BASE], limit:1 }),
    { returned:1, total:1, complete:true, truncated:false });
  await assertPage(await agentFor(constantModel(2)).find_constant(7, { functions:[BASE], limit:1 }),
    { returned:1, total:null, complete:false, truncated:true });
  await assertPage(await agentFor(constantModel(3)).find_constant(7, { functions:[BASE], limit:3 }),
    { returned:3, total:3, complete:true, truncated:false });
  await assertPage(await agentFor(constantModel(4)).find_constant(7, { functions:[BASE], limit:3 }),
    { returned:3, total:null, complete:false, truncated:true });
});


test('find_constant proves exact completeness at the public maximum limit', async () => {
  await assertPage(await agentFor(constantModel(1000)).find_constant(7, { functions:[BASE], limit:1000 }),
    { returned:1000, total:1000, complete:true, truncated:false });
  await assertPage(await agentFor(constantModel(1001)).find_constant(7, { functions:[BASE], limit:1000 }),
    { returned:1000, total:null, complete:false, truncated:true });
});

test('exact-limit completion is not upgraded from truncated semantic IR', async () => {
  const model = constantModel(1);
  irFor(model).truncated = true;
  const result = await agentFor(model).find_constant(7, { functions:[BASE], limit:1 });
  assert.equal(result.returned, 1);
  assert.equal(result.total, null);
  assert.equal(result.complete, false);
  assert.equal(result.truncated, true);
  assert.equal(result.reason, 'semantic-ir-truncated');
});

test('find_constant probes later scoped functions before deciding exact-limit completeness', async () => {
  const second = BASE + 0x1000n;

  const exactModels = new Map([[BASE, constantModel(1, BASE)], [second, constantModel(0, second)]]);
  const exactTools = createAgentTools({ analyze:async (address) => exactModels.get(address) }, { maxFunctions:4 });
  await assertPage(await exactTools.find_constant(7, { functions:[BASE, second], limit:1 }),
    { returned:1, total:1, complete:true, truncated:false });

  const overflowModels = new Map([[BASE, constantModel(1, BASE)], [second, constantModel(1, second)]]);
  const overflowTools = createAgentTools({ analyze:async (address) => overflowModels.get(address) }, { maxFunctions:4 });
  await assertPage(await overflowTools.find_constant(7, { functions:[BASE, second], limit:1 }),
    { returned:1, total:null, complete:false, truncated:true });
});

test('explain_evidence distinguishes exact-limit completion from a proven overflow', async () => {
  const model = evidenceModel();
  const one = evidenceIdWithMatches(model, 1);
  const two = evidenceIdWithMatches(model, 2);
  const tools = agentFor(model);

  await assertPage(await tools.explain_evidence('missing', { functions:[BASE], limit:1 }),
    { returned:0, total:0, complete:true, truncated:false });
  await assertPage(await tools.explain_evidence(one, { functions:[BASE], limit:1 }),
    { returned:1, total:1, complete:true, truncated:false });
  await assertPage(await tools.explain_evidence(two, { functions:[BASE], limit:1 }),
    { returned:1, total:null, complete:false, truncated:true });
  await assertPage(await tools.explain_evidence(two, { functions:[BASE], limit:2 }),
    { returned:2, total:2, complete:true, truncated:false });
});

test('actual createHexToolRegistry preserves exact-limit completeness', async () => {
  const model = constantModel(1);
  const registry = createHexToolRegistry({
    addressExists:() => true,
    analyze:async () => model,
  }, { maxFunctions:4 });
  const observation = await registry.execute('find_constant', {
    value:'7', functions:['0x1000'], limit:1,
  }, { scope:'binary' });
  assert.equal(observation.result.returned, 1);
  assert.equal(observation.result.total, 1);
  assert.equal(observation.result.complete, true);
  assert.equal(observation.result.truncated, false);
  assert.equal(observation.completeness.complete, true);
});
