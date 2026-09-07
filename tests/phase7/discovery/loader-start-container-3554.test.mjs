import assert from 'node:assert/strict';
import test from 'node:test';

import { loaderProducer } from '../../../js/analysis/discovery/producers.js';

test('#3554 loader start containers fail closed unless they are Arrays', () => {
  for (const functions of ['10', new Set(['10']), new Uint8Array([1])]) {
    assert.throws(
      () => loaderProducer.produce({ image: { functions, functionStarts: [], unwindEntries: [] } }),
      /discovery-loader-invalid-functions/,
    );
  }
  for (const functionStarts of ['10', new Set(['10']), new Uint8Array([1])]) {
    assert.throws(
      () => loaderProducer.produce({ image: { functions: [], functionStarts, unwindEntries: [] } }),
      /discovery-loader-invalid-function-starts/,
    );
  }
});

test('#3554 normal Arrays preserve canonical functions priority and deduplication', () => {
  const evidence = loaderProducer.produce({
    image: {
      functions: [
        { address: '16', source: 'function_starts', name: 'canonical', sizeBytes: 4 },
        { address: '48', source: 'entrypoint', name: 'not-function-starts' },
      ],
      functionStarts: [
        { address: '16', name: 'legacy-duplicate' },
        '32',
      ],
      unwindEntries: [],
    },
  });

  assert.deepEqual(evidence.map((item) => item.start), ['16', '32']);
  assert.equal(evidence[0].name, 'canonical');
  assert.equal(evidence[0].regions[0].start, '16');
  assert.equal(evidence[0].regions[0].end, '20');
  assert.deepEqual(loaderProducer.produce({ image: { functions: null, functionStarts: undefined, unwindEntries: [] } }), []);
});
