// Regression for #5857: malformed Swift section descriptor address/size must
// fail closed as an incomplete scan, not abort buildSwiftMetadataModel with
// a raw BigInt conversion error.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildSwiftMetadataModel } from '../js/swift.js';

const reader = async () => null;

test('#5857 valid bigint section descriptors still scan', async () => {
  const model = await buildSwiftMetadataModel(reader, [{
    section: '__swift5_types',
    vmAddr: 0x1000n,
    size: 4n,
  }]);
  assert.ok(model, 'model builds');
  assert.equal(model.completeness.types.present, true);
});

test('#5857 numeric-string and safe-integer addresses canonicalize', async () => {
  for (const [vmAddr, size] of [['0x1000', '4'], [4096, 4]]) {
    const model = await buildSwiftMetadataModel(reader, [{ section: '__swift5_types', vmAddr, size }]);
    assert.ok(model, `model builds for vmAddr=${String(vmAddr)}`);
    assert.equal(model.completeness.types.present, true);
  }
});

test('#5857 malformed address/size no longer throws raw BigInt errors', async () => {
  const cases = [
    { section: '__swift5_types', vmAddr: 'not-an-address', size: 4 },
    { section: '__swift5_types', vmAddr: 0x1000n, size: 'bad-size' },
    { section: '__swift5_types', vmAddr: { lo: 1 }, size: 4 },
    { section: '__swift5_types', vmAddr: Symbol('x'), size: 4 },
    { section: '__swift5_types', vmAddr: -4096, size: 4 },
    { section: '__swift5_types', vmAddr: 1.5, size: 4 },
  ];
  for (const sections of cases.map((s) => [s])) {
    const model = await buildSwiftMetadataModel(reader, sections);
    assert.ok(model, 'analysis completes instead of throwing');
    assert.equal(model.completeness.types.complete, false, 'malformed section is not complete');
    assert.equal(model.completeness.types.present, true, 'malformed section is present, not absent');
    assert.equal(model.complete, false, 'model completeness is degraded');
  }
});
