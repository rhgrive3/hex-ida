import assert from 'node:assert/strict';
import { SymbolIndex } from '../js/symbols.js';

// Primitive string arrays remain the canonical structured transport.
{
  const index = new SymbolIndex({
    addrs: new BigUint64Array([0x1000n]),
    kinds: new Uint8Array([0]),
    flags: new Uint8Array([0]),
    names: ['target'],
    funcs: new BigUint64Array([0x1000n]),
  });
  assert.equal(index.symbolTransportValid, true);
  assert.equal(index.symbolTransportError, null);
  assert.equal(index.nameAt(0x1000n), 'target');
  assert.equal(index.nearest(0x1000n)?.name, 'target');
}

// Legacy newline-delimited strings remain supported for persisted/test callers.
{
  const index = new SymbolIndex({
    addrs: new BigUint64Array([0x1000n]),
    kinds: new Uint8Array([0]),
    flags: new Uint8Array([0]),
    names: 'target',
  });
  assert.equal(index.symbolTransportValid, true);
  assert.equal(index.nameAt(0x1000n), 'target');
}

// #4719: structured values must not be String()-coerced into trusted symbol
// identity. Invalid name transport fails closed without leaking into exact,
// nearest, or provenance lookups.
for (const malformedName of [
  ['target'],
  { toString() { return 'malloc'; } },
  42,
  true,
]) {
  const index = new SymbolIndex({
    addrs: new BigUint64Array([0x1000n]),
    kinds: new Uint8Array([0]),
    flags: new Uint8Array([0]),
    names: [malformedName],
    funcs: new BigUint64Array([0x1000n]),
  });
  assert.equal(index.symbolTransportValid, false, 'non-string array names must invalidate symbol transport');
  assert.equal(index.symbolTransportError, 'symbol-name-type-invalid');
  assert.equal(index.symbolCount, 0);
  assert.equal(index.nameAt(0x1000n), null);
  assert.equal(index.nearest(0x1000n), null);
  assert.equal(index.nameEvidence(0x1000n), null);
}

// The type check must not weaken the existing cardinality fail-closed policy.
{
  const index = new SymbolIndex({
    addrs: new BigUint64Array([0x1000n, 0x1004n]),
    kinds: new Uint8Array(2),
    flags: new Uint8Array(2),
    names: ['only-one'],
  });
  assert.equal(index.symbolTransportValid, false);
  assert.equal(index.symbolTransportError, 'symbol-cardinality-mismatch');
  assert.equal(index.symbolCount, 0);
}

console.log('issue #4719 SymbolIndex name transport regression: PASS');
