import assert from 'node:assert/strict';
import test from 'node:test';
import { SymbolIndex } from '../js/symbols.js';

function index() {
  return new SymbolIndex({
    funcs: new BigUint64Array([0x1000n, 0x1800n]),
    addrs: new BigUint64Array([0x1000n, 0x1800n]),
    names: ['main', 'next'],
    kinds: new Uint8Array([0, 0]),
    flags: new Uint8Array([0, 0]),
  });
}

test('#9494 functionList accepts Number region size with BigInt vmAddr', () => {
  const rows = index().functionList({ vmAddr: 0x1000n, size: 0x1000 });
  assert.deepEqual(rows.map((row) => row.addr), [0x1000n, 0x1800n]);
});

test('#9494 symbolList accepts Number region size with BigInt vmAddr', () => {
  const rows = index().symbolList({ region: { vmAddr: 0x1000n, size: 0x1000 } });
  assert.deepEqual(rows.map((row) => row.addr), [0x1000n, 0x1800n]);
});
