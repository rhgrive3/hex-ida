import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AnalysisQueryAPI, createAppAnalysisQueryAdapter } from '../../../js/analysis/query/index.js';

function apiFor(value) {
  const app = {
    store: { get: () => null },
    backend: { binaryId: 'bin-decompiler-projection', gen: 1 },
    async getDecompile() { return value; },
  };
  return new AnalysisQueryAPI(createAppAnalysisQueryAdapter(app));
}

test('decompile query omits only the runtime def-use callback', async () => {
  const producerValue = {
    pseudocode: 'int f(void) { return 1; }',
    ir: {
      nodes: [{ id: 'n0', opcode: 'return' }],
      provenance: { source: 'semantic-ir/v2' },
      defUse: () => new Map([['n0', []]]),
    },
  };
  const api = apiFor(producerValue);
  const snapshot = await api.snapshot();
  const result = await api.decompile(snapshot, '0x1000');

  assert.equal(result.value.pseudocode, producerValue.pseudocode);
  assert.deepEqual(result.value.ir.nodes, producerValue.ir.nodes);
  assert.deepEqual(result.value.ir.provenance, producerValue.ir.provenance);
  assert.equal(result.value.ir.defUse, undefined);
  assert.equal(typeof producerValue.ir.defUse, 'function');
  assert.equal(Object.isFrozen(result.value.ir), true);
});

test('decompile query still rejects unrelated unclonable fields', async () => {
  const producerValue = {
    pseudocode: 'int f(void) { return 1; }',
    ir: {
      nodes: [{ id: 'n0' }],
      defUse: () => new Map([['n0', []]]),
    },
    metadata: { callback: () => 'must remain fail-closed' },
  };
  const api = apiFor(producerValue);
  const snapshot = await api.snapshot();

  await assert.rejects(
    api.decompile(snapshot, '0x1000'),
    /analysis-query-value-unclonable/,
  );
  assert.equal(typeof producerValue.ir.defUse, 'function');
  assert.equal(typeof producerValue.metadata.callback, 'function');
});
