import test from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisCache } from '../../js/cache/analysis-cache.js';

function makeView() {
  const sab = new SharedArrayBuffer(16);
  new Uint8Array(sab).set([0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]);
  return { view: new Uint8Array(sab, 8, 4), dataView: new DataView(sab, 4, 8) };
}

test('#8933 preserves SAB-backed view offsets and constructors while owning bytes', async () => {
  const cache = new AnalysisCache({});
  const { view, dataView } = makeView();
  await cache.put('bin_8933_offset', { formatMetadata: { view, dataView } });
  const hit = await cache.get('bin_8933_offset');
  assert.ok(hit.formatMetadata.view instanceof Uint8Array);
  assert.equal(hit.formatMetadata.view.byteOffset, 8);
  assert.equal(hit.formatMetadata.view.byteLength, 4);
  assert.ok(hit.formatMetadata.dataView instanceof DataView);
  assert.equal(hit.formatMetadata.dataView.byteOffset, 4);
  assert.equal(hit.formatMetadata.dataView.byteLength, 8);
  assert.ok(!(hit.formatMetadata.view.buffer instanceof SharedArrayBuffer));
  assert.ok(!(hit.formatMetadata.dataView.buffer instanceof SharedArrayBuffer));
});

test('#8933 preserves repeated references for SAB-backed views', async () => {
  const cache = new AnalysisCache({});
  const { view } = makeView();
  await cache.put('bin_8933_refs', { formatMetadata: { pair: [view, view] } });
  const hit = await cache.get('bin_8933_refs');
  assert.strictEqual(hit.formatMetadata.pair[0], hit.formatMetadata.pair[1]);
  assert.equal(hit.formatMetadata.pair[0].byteOffset, 8);
});
