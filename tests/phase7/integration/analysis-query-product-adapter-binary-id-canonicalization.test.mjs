import assert from 'node:assert/strict';
import { createAppAnalysisQueryAdapter } from '../../../js/analysis/query/product-adapter.js';

const app = {
  backend: { binaryId: ' abc ', gen: 0 },
  store: {
    get(key) {
      if (key === 'project') return { revision: 0 };
      return null;
    },
  },
};

const adapter = createAppAnalysisQueryAdapter(app);
const identity = await adapter.currentIdentity();

assert.equal(identity.binaryId, 'abc');
assert.equal(identity.projectRevision, 0);
assert.equal(identity.analysisEpoch, 0);

console.log('analysis query product adapter binary id canonicalization: ok');
