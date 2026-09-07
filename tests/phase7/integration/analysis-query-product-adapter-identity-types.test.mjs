import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppAnalysisQueryAdapter } from '../../../js/analysis/query/product-adapter.js';

function appWithSliceIndex(sliceIndex) {
  return {
    backend: { binaryId: 'deadbeef', gen: 1 },
    store: new Map([['sliceIndex', sliceIndex], ['architecture', 'x86-64']]),
  };
}

async function sliceDimension(sliceIndex) {
  const adapter = createAppAnalysisQueryAdapter(appWithSliceIndex(sliceIndex));
  const identity = await adapter.currentIdentity();
  return identity.artifactVersions.sliceIndex;
}

test('primitive identity dimensions keep their types distinct', async () => {
  const asNumber = await sliceDimension(1);
  const asString = await sliceDimension('1');
  const asBigint = await sliceDimension(1n);
  const asBoolean = await sliceDimension(true);
  assert.notEqual(asNumber, asString);
  assert.notEqual(asNumber, asBigint);
  assert.notEqual(asNumber, asBoolean);
  assert.notEqual(asString, asBigint);
  assert.notEqual(asString, asBoolean);
});

test('reserved-prefix strings cannot collide with typed primitive dimensions', async () => {
  assert.notEqual(await sliceDimension('number:1'), await sliceDimension(1));
  assert.notEqual(await sliceDimension('bigint:1'), await sliceDimension(1n));
  assert.notEqual(await sliceDimension('boolean:true'), await sliceDimension(true));
});

test('identical primitive states keep identical dimensions', async () => {
  assert.equal(await sliceDimension(1), await sliceDimension(1));
  assert.equal(await sliceDimension('1'), await sliceDimension('1'));
});

test('structured values never launder into a primitive dimension', async () => {
  const asNumber = await sliceDimension(1);
  const asStructured = await sliceDimension([1]);
  assert.ok(String(asStructured).startsWith('structured:'));
  assert.notEqual(asNumber, asStructured);
});
