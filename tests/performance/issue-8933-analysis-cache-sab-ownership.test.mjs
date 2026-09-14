import test from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisCache } from '../../js/cache/analysis-cache.js';

// #8933: AnalysisCache must take an *owned* byte snapshot. Native
// structuredClone re-wraps a SharedArrayBuffer (or a view over one) onto the same
// shared memory block, so a caller could silently rewrite the authoritative
// cached payload after put()/get() while every identity key stayed stable.

function sharedBackedData(bytes) {
  const sab = new SharedArrayBuffer(4);
  const view = new Uint8Array(sab);
  view.set(bytes);
  return { sab, view, data: { formatMetadata: { raw: view } } };
}

test('#8933 put/get own a SharedArrayBuffer view: source mutation cannot poison the entry', async () => {
  const cache = new AnalysisCache({});
  const { view, data } = sharedBackedData([1, 2, 3, 4]);

  await cache.put('bin_8933_a', data);
  view[0] = 99; // mutate the shared backing after put()

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
  returned.formatMetadata.raw[0] = 0; // attempt to mutate through the returned snapshot

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
  new Uint8Array(sab).set([0, 0, 0, 0]); // clobber the shared source after put()

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
  source.formatMetadata.raw[0] = 42; // ordinary ArrayBuffer view source
  const hit = await cache.get('bin_8933_e');
  assert.equal(hit.formatMetadata.raw[0], 1, 'existing copy-on-put behavior for plain buffers is preserved');
  assert.deepEqual(hit.imports, ['a', 'b']);
});
