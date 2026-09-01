import assert from 'node:assert/strict';
import { createAppAnalysisQueryAdapter } from '../../../js/analysis/query/product-evidence-adapter.js';

let functionCalls = 0;
const app = {
  backend: { binaryId: 'bin-1', gen: 0 },
  store: {
    get(key) {
      if (key === 'project') return { revision: 0 };
      return null;
    },
  },
  async getEvidence() { return []; },
  async analyzeFunction(id) {
    functionCalls += 1;
    return { startAddress: BigInt(id), evidence: [] };
  },
};

const adapter = createAppAnalysisQueryAdapter(app);
const snapshot = await adapter.currentIdentity();

for (const address of [-1, -1n, '-1', 'function:-1']) {
  functionCalls = 0;
  const result = await adapter.evidence(snapshot, { address });
  assert.equal(functionCalls, 0, `negative address ${String(address)} must not reach function lookup`);
  assert.equal(result.value.length, 0);
}

functionCalls = 0;
await adapter.evidence(snapshot, { address: '0x10' });
assert.equal(functionCalls, 1, 'valid non-negative address must preserve function lookup');

console.log('analysis query product evidence negative address validation: PASS');
