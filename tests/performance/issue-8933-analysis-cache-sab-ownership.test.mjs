import test from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisCache } from '../../js/cache/analysis-cache.js';

function sharedBackedData(bytes) {
  const sab = new SharedArrayBuffer(bytes.length);
  const view = new Uint8Array(sab);
  view.set(bytes);
  return { sab, view, data: { formatMetadata: { raw: view } } };
}

function makeView() {
  const sab = new SharedArrayBuffer(16);
  new Uint8Array(sab).set([0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]);
  return { sab, view: new Uint8Array(sab, 8, 4), dataView: new DataView(sab, 4, 8) };
}

test('#8933 put/get own a SharedArrayBuffer view: source mutation cannot poison the entry', async () => {
  const cache = new AnalysisCache({});
  const { view, data } = sharedBackedData([1, 2, 3, 4]);

  await cache.put('bin_8933_a', data);
  view[0] = 99;

  const hit = await cache.get('bin_8933_a');
  assert.ok(hit, 'entry still present');
  assert.equal(hit.formatMetadata.raw[0], 1, 'cached byte must not reflect post-put shared-memory mutation');
});

test('#8933 mutating the value returned by put() cannot poison the stored record', async () => {
  const cache = new AnalysisCache({});
  const { data } = sharedBackedData([5, 6, 7, 8]);

  const returned = await cache.put('bin_8933_b', data);
  assert.ok(!(returned.formatMetadata.raw.buffer instanceof SharedArrayBuffer),
    'the buffer returned by put() must be an owned ArrayBuffer, not shared memory');
  returned.formatMetadata.raw[0] = 0;

  const hit = await cache.get('bin_8933_b');
  assert.equal(hit.formatMetadata.raw[0], 5, 'stored record must be independent of the returned snapshot');
});

test('#8933 mutating the value returned by get() cannot poison a later get()', async () => {
  const cache = new AnalysisCache({});
  const { data } = sharedBackedData([10, 11, 12, 13]);
  await cache.put('bin_8933_c', data);

  const first = await cache.get('bin_8933_c');
  assert.ok(!(first.formatMetadata.raw.buffer instanceof SharedArrayBuffer));
  first.formatMetadata.raw[1] = 0;

  const second = await cache.get('bin_8933_c');
  assert.equal(second.formatMetadata.raw[1], 11, 'each get() returns an independent owned snapshot');
});

test('#8933 direct SharedArrayBuffer field is owned and value-preserving', async () => {
  const cache = new AnalysisCache({});
  const sab = new SharedArrayBuffer(4);
  new Uint8Array(sab).set([7, 7, 7, 7]);
  await cache.put('bin_8933_d', { formatMetadata: { direct: sab } });
  new Uint8Array(sab).set([0, 0, 0, 0]);

  const hit = await cache.get('bin_8933_d');
  assert.ok(!(hit.formatMetadata.direct instanceof SharedArrayBuffer), 'cached direct SAB becomes an owned buffer');
  assert.deepEqual([...new Uint8Array(hit.formatMetadata.direct)], [7, 7, 7, 7], 'byte content preserved at snapshot time');
});

test('#8933 non-shared payloads keep the native structuredClone fast path (no behavior change)', async () => {
  const cache = new AnalysisCache({});
  const source = { formatMetadata: { raw: new Uint8Array([1, 2, 3, 4]), n: 7 }, imports: ['a', 'b'] };
  const stored = await cache.put('bin_8933_e', source);
  assert.ok(stored.formatMetadata.raw instanceof Uint8Array);
  assert.ok(!(stored.formatMetadata.raw.buffer instanceof SharedArrayBuffer));
  source.formatMetadata.raw[0] = 42;
  const hit = await cache.get('bin_8933_e');
  assert.equal(hit.formatMetadata.raw[0], 1, 'existing copy-on-put behavior for plain buffers is preserved');
  assert.deepEqual(hit.imports, ['a', 'b']);
});

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

test('#8933 preserves repeated references for SAB-backed views and shared backing', async () => {
  const cache = new AnalysisCache({});
  const { view, dataView } = makeView();
  await cache.put('bin_8933_refs', { formatMetadata: { pair: [view, view], dataView } });
  const hit = await cache.get('bin_8933_refs');
  assert.strictEqual(hit.formatMetadata.pair[0], hit.formatMetadata.pair[1]);
  assert.equal(hit.formatMetadata.pair[0].byteOffset, 8);
  assert.strictEqual(hit.formatMetadata.pair[0].buffer, hit.formatMetadata.dataView.buffer);
});
