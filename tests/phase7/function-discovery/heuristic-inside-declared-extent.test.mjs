import test from 'node:test';
import assert from 'node:assert/strict';

import { SymbolIndex } from '../../../js/symbols.js';

const HEURISTIC = Object.freeze({ source:'heuristic', confidence:0.55, confirmed:false });

test('unconfirmed heuristic starts cannot split a loader-proven declared function extent', () => {
  const symbols = new SymbolIndex({
    funcs: new BigUint64Array([0x1000n, 0x2000n]),
    funcEnds: new BigUint64Array([0x1100n, 0x2100n]),
  });

  assert.equal(symbols.addFunctions([0x1040n, 0x1080n], HEURISTIC), 0);
  assert.equal(symbols.isFunctionStart(0x1040n), false);
  assert.equal(symbols.isFunctionStart(0x1080n), false);
  assert.equal(symbols.functionAt(0x1080n)?.start, 0x1000n);
  assert.equal(symbols.functionEvidence(0x1080n), null);
});

test('heuristic starts at or outside the declared end remain discoverable', () => {
  const symbols = new SymbolIndex({
    funcs: new BigUint64Array([0x1000n]),
    funcEnds: new BigUint64Array([0x1100n]),
  });

  assert.equal(symbols.addFunctions([0x1100n, 0x1200n], HEURISTIC), 2);
  assert.equal(symbols.isFunctionStart(0x1100n), true);
  assert.equal(symbols.isFunctionStart(0x1200n), true);
});

test('confirmed evidence may still introduce an interior start', () => {
  const symbols = new SymbolIndex({
    funcs: new BigUint64Array([0x1000n]),
    funcEnds: new BigUint64Array([0x1100n]),
  });

  assert.equal(symbols.addFunctions([0x1080n], { source:'objc-runtime', confidence:1, confirmed:true }), 1);
  assert.equal(symbols.isFunctionStart(0x1080n), true);
  assert.equal(symbols.functionEvidence(0x1080n)?.confirmed, true);
});

test('heuristic discovery remains available when the containing extent is unproven', () => {
  const symbols = new SymbolIndex({ funcs: new BigUint64Array([0x1000n]) });
  assert.equal(symbols.addFunctions([0x1080n], HEURISTIC), 1);
  assert.equal(symbols.isFunctionStart(0x1080n), true);
});
