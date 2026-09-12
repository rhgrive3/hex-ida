import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeWorkerFixture } from './native-worker-fixture.mjs';
import { ScopedAnalysisService } from '../../js/analysis/query/scoped-service.js';

const rowsByLocator = { '0x1000': [['uxtb', 'w0, w0', 0x53001c00], ['ret', '', 0xd65f03c0]] };
async function nativeReceipt(t) {
  const f = await nativeWorkerFixture(t, { rowsByLocator });
  const view = await f.invoke('explainTransformChain', { functionId: '0x1000', includePremises: true });
  assert.equal(view.verifiedStatementCount, 1);
  assert.equal(view.statements[0].chain.minimumCheck, 'derivation-checked');
  return { f, receipt: view.statements[0].chain.receipts[0] };
}

test('native architecture availability is not a resolver for explicit receipt IDs', async t => {
  const { f, receipt } = await nativeReceipt(t), workers = f.counters.workers;
  const result = await f.invoke('explainTransformChain', { functionId: receipt.functionId, stepIds: [receipt.id] });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.reason, 'canonical-transform-receipt-owner-unbound');
  assert.equal(result.exact, false);
  assert.equal(f.counters.workers, workers, 'explicit IDs cannot silently request unrelated native transforms');
  const again = await f.invoke('explainTransformChain', { functionId: '0x1000' });
  assert.equal(again.verifiedStatementCount, 1, 'normal native projection remains executable after unsupported lookup');
});

test('explicit receipt lookup uses the configured current owner and inherits no prior native verdict', async t => {
  const { f, receipt } = await nativeReceipt(t), calls = [];
  let current = true;
  const service = new ScopedAnalysisService({
    worldInput: f.world, snapshot: { snapshotId: 'snap', binaryId: f.world.binarySet[0].binaryId },
    host: { canonicalArchitecture: 'arm64', isCurrent: () => true,
      loadPipeline: async () => { throw new Error('explicit receipt query must use its configured owner'); },
      configuration: { maximumSessions: 2, sessionTtlMs: 120000,
        resolveTransformReceipt: (id, context) => {
          calls.push({ id, functionId: context.functionId, worldId: context.world.id, snapshotId: context.snapshotId });
          return id === receipt.id ? { data: receipt, isCurrent: () => current } : null;
        } } },
  });
  t.after(() => service.close());
  const query = { functionId: receipt.functionId, stepIds: [receipt.id], includePremises: true };
  const result = (await service.invoke('explainTransformChain', query)).value;
  assert.deepEqual(calls, [{ id: receipt.id, functionId: receipt.functionId, worldId: f.world.id, snapshotId: 'snap' }]);
  assert.equal(result.receipts[0].id, receipt.id); assert.equal(result.status, 'unknown');
  assert.equal(result.checks[0].reason, 'transform-semantic-checker-unbound');
  assert.equal(result.exact, false);
  current = false;
  await assert.rejects(service.invoke('explainTransformChain', query), /transform-receipt-owner-not-current/);
});
