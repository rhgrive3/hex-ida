import assert from 'node:assert/strict';
import test from 'node:test';

import { createDirectCall, createMemoryEffect } from '../../../js/analysis/summary/contract.js';

const SOURCES = ['proven-summary', 'library-model', 'abi-rule', 'unknown-call-fallback'];

test('#3411 canonical primitive effect sources retain existing trim/default semantics', () => {
  for (const source of SOURCES) {
    assert.equal(createMemoryEffect({ source }).source, source);
    assert.equal(createMemoryEffect({ source:`  ${source}  ` }).source, source);
    assert.equal(createDirectCall({ callSiteId:'call', effectSource:source }).effectSource, source);
    assert.equal(createDirectCall({ callSiteId:'call', effectSource:`  ${source}  ` }).effectSource, source);
  }
  assert.equal(createMemoryEffect({}).source, 'proven-summary');
  assert.equal(createDirectCall({ callSiteId:'call' }).effectSource, 'unknown-call-fallback');
});

test('#3411 structured effect sources cannot mint authority', () => {
  const structured = [
    ['proven-summary'],
    ['library-model'],
    ['abi-rule'],
    ['unknown-call-fallback'],
    { toString: () => 'proven-summary' },
    true,
    1,
  ];
  for (const source of structured) {
    assert.throws(
      () => createMemoryEffect({ source }),
      (error) => error?.code === 'function-summary-invalid-effect-source'
        || error?.message === 'function-summary-invalid-effect-source',
    );
    assert.throws(
      () => createDirectCall({ callSiteId:'call', effectSource:source }),
      (error) => error?.code === 'function-summary-invalid-effect-source'
        || error?.message === 'function-summary-invalid-effect-source',
    );
  }
});
