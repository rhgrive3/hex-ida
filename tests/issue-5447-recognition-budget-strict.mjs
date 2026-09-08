import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRecognitionState } from '../js/app.js';

function fakeSym(count = 3000) {
  return {
    gen: 1,
    functionCount: count,
    funcs: Array.from({ length: count }, (_, i) => 0x1000n + BigInt(i)),
    functionStartsComplete: true,
    nameAt: (addr) => `sub_${addr.toString(16)}`,
    functionWindowBound: () => null,
  };
}

test('#5447 structured maxFunctions/knowledgeLimit must not become coverage authority', async () => {
  const structured = await buildRecognitionState({ sym: fakeSym(3000), maxFunctions: ['1000'], knowledgeLimit: ['1'] });
  const primitive = await buildRecognitionState({ sym: fakeSym(3000), maxFunctions: 1000, knowledgeLimit: 1 });
  assert.equal(structured.scannedCount, 3000, 'structured budget must fall back to the default scan width, not coerce to 1000');
  assert.equal(structured.knowledgeScanned, 512, 'structured knowledgeLimit must fall back to the default, not coerce to 1');
  assert.notEqual(structured.scannedCount, primitive.scannedCount);
});

test('#5447 junk budget shapes fall back to defaults instead of coercing', async () => {
  const state = await buildRecognitionState({ sym: fakeSym(3000), maxFunctions: true, knowledgeLimit: { a: 1 } });
  assert.equal(state.scannedCount, 3000, 'boolean budget must not coerce to 1000');
  assert.equal(state.knowledgeScanned, 512, 'object knowledgeLimit must not coerce to 0 (silent coverage loss)');
});

test('#5447 primitive budgets keep their existing clamp semantics', async () => {
  const clampedLow = await buildRecognitionState({ sym: fakeSym(3000), maxFunctions: 10, knowledgeLimit: 1 });
  assert.equal(clampedLow.scannedCount, 1000, 'maxFunctions below the floor clamps to 1000');
  assert.equal(clampedLow.knowledgeScanned, 1);
  const explicitZeroKnowledge = await buildRecognitionState({ sym: fakeSym(3000), maxFunctions: 1000, knowledgeLimit: 0 });
  assert.equal(explicitZeroKnowledge.knowledgeScanned, 0, 'an explicit numeric 0 knowledgeLimit stays honored');
});
