import assert from 'node:assert/strict';
import { aliasMemoryRegions } from '../../../js/analysis/alias/legacy-safety-floor.js';
import { deriveMemoryRegion } from '../../../js/analysis/alias/index-v2.js';

const origin = { instructionIds: ['instruction_4440'] };

function tlsRegion({ functionId, binaryId, valueId = 'v0', widthBits = 64 }) {
  return {
    kind: 'tls',
    functionId,
    binaryId,
    addressSpace: 'tls',
    rootIdentity: { addressValueId: valueId },
    widthBits,
    origin,
  };
}

// #4440 minimal repro: same addressValueId string across functions/binaries.
const a = tlsRegion({ functionId: 'func-A', binaryId: 'bin-A' });
const b = tlsRegion({ functionId: 'func-B', binaryId: 'bin-B' });
assert.notEqual(
  aliasMemoryRegions(a, b),
  'must',
  'cross-function function-local rootIdentity must not be MustAlias',
);

// Same function / same proven root / same width keeps the existing MustAlias.
const same = tlsRegion({ functionId: 'func-A', binaryId: 'bin-A' });
assert.equal(aliasMemoryRegions(a, same), 'must', 'same-scope identical TLS region stays must');

// Different binary with the same root spelling is not proven identical.
const c = tlsRegion({ functionId: 'func-A', binaryId: 'bin-B' });
assert.notEqual(
  aliasMemoryRegions(a, c),
  'must',
  'cross-binary identical root spelling must not be MustAlias without global proof',
);

// Missing scope cannot prove identity either (fail closed).
const noScope = tlsRegion({ functionId: null, binaryId: null });
assert.notEqual(
  aliasMemoryRegions(noScope, { ...noScope }),
  'must',
  'scope-less physical identity must not be MustAlias',
);

// Address-space separation is preserved.
const io = tlsRegion({ functionId: 'func-A', binaryId: 'bin-A' });
io.kind = 'io';
io.addressSpace = 'io';
assert.equal(aliasMemoryRegions(a, io), 'no', 'distinct address spaces stay NoAlias');

// End-to-end through the production constructor: inferred addressValueId
// roots from different functions must not become MustAlias via A1's floor.
const prodA = deriveMemoryRegion({
  functionId: 'func-A',
  binaryId: 'bin-A',
  memory: { addressSpace: 'tls', addressExpr: { valueId: 'v0' }, widthBits: 64 },
  origin,
});
const prodB = deriveMemoryRegion({
  functionId: 'func-B',
  binaryId: 'bin-B',
  memory: { addressSpace: 'tls', addressExpr: { valueId: 'v0' }, widthBits: 64 },
  origin,
});
assert.equal(prodA.kind, 'tls');
assert.equal(prodB.kind, 'tls');
assert.notEqual(
  aliasMemoryRegions(prodA, prodB),
  'must',
  'production-derived cross-function TLS roots must not be MustAlias',
);
const prodSame = deriveMemoryRegion({
  functionId: 'func-A',
  binaryId: 'bin-A',
  memory: { addressSpace: 'tls', addressExpr: { valueId: 'v0' }, widthBits: 64 },
  origin,
});
assert.equal(aliasMemoryRegions(prodA, prodSame), 'must', 'production same-scope TLS stays must');

console.log('issue #4440 physical cross-scope MustAlias guard: PASS');
