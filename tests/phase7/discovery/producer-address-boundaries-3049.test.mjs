import assert from 'node:assert/strict';
import test from 'node:test';

import {
  callGraphProducer,
  createDebugEvidenceProducer,
  createPatternProducer,
  exportProducer,
  loaderProducer,
  referenceProducer,
} from '../../../js/analysis/discovery/producers.js';

test('discovery producers reject structured address coercion before evidence authority', () => {
  assert.deepEqual(exportProducer.produce({
    image: { exports: [{ address: ['4096'], isFunction: true, name: 'bad' }], symbols: [] },
  }), []);

  const validExport = exportProducer.produce({
    image: { exports: [{ address: '4096', isFunction: true, name: 'good' }], symbols: [] },
  });
  assert.equal(validExport.length, 1);
  assert.equal(validExport[0].start, '4096');

  assert.deepEqual(referenceProducer.produce({
    image: { relocationTargets: [{ address: ['4096'] }], vtableEntries: [], exceptionMetadata: [] },
  }), []);

  assert.deepEqual(callGraphProducer.produce({
    callTargets: [{ address: { valueOf: () => 4096 }, callSiteId: 'bad' }],
  }), []);
});

test('unwind end and pattern code base use the same strict primitive address boundary', () => {
  const unwind = loaderProducer.produce({
    image: {
      functions: [],
      functionStarts: [],
      unwindEntries: [{ start: '8192', end: ['8208'], primary: true }],
    },
  });
  assert.equal(unwind.length, 1);
  assert.equal(unwind[0].start, '8192');
  assert.deepEqual(unwind[0].regions, []);

  const pattern = createPatternProducer({
    id: 'strict-base',
    architectureId: null,
    alignment: 1,
    patterns: [{ id: 'one-byte', bytes: [0xaa] }],
  });
  assert.deepEqual(pattern.produce({ image: { code: Uint8Array.of(0xaa), codeBaseAddress: ['4096'] } }), []);
  assert.equal(pattern.produce({ image: { code: Uint8Array.of(0xaa), codeBaseAddress: '4096' } })[0].start, '4096');
});

test('debug evidence does not launder structured addresses into canonical proof', () => {
  const producer = createDebugEvidenceProducer([{ address: ['4096'], name: 'bad', evidenceIds: [] }]);
  assert.deepEqual(producer.produce(), []);
});
