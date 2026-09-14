// Issue #8897 regression: `safeSnapshot` must produce a truly detached copy so
// that a `SharedArrayBuffer` (or any view over one) cannot cross the plugin
// trust boundary by shared backing. `structuredClone` re-shares a
// SharedArrayBuffer and `TypedArray#slice` keeps the same shared buffer, so the
// old snapshot let a plugin mutate caller-owned host state (inbound) and kept an
// accepted result live-linked to plugin memory (outbound).
import assert from 'node:assert/strict';
import test from 'node:test';

import { PlatformPluginRegistry } from '../js/platform/plugin-api.js';

const HAS_SAB = typeof SharedArrayBuffer === 'function';

test('#8897 inbound: plugin writes to a SharedArrayBuffer-backed project do not reach host bytes', { skip: !HAS_SAB && 'SharedArrayBuffer unavailable' }, async () => {
  const hostSab = new SharedArrayBuffer(4);
  const hostBytes = new Uint8Array(hostSab);
  hostBytes.set([1, 2, 3, 4]);

  const registry = new PlatformPluginRegistry({ timeoutMs: 1000 });
  registry.registerAnalyzer('sab.inbound', {
    async analyze(context) {
      context.project.bytes[0] = 0xaa;
      return Array.from(context.project.bytes);
    },
  });

  const result = await registry.invoke('analyzer', 'sab.inbound', 'analyze', { project: { bytes: hostBytes } });
  assert.deepEqual(result.value, [0xaa, 2, 3, 4]);
  assert.deepEqual(Array.from(hostBytes), [1, 2, 3, 4], 'caller-owned host bytes must be untouched');
});

test('#8897 outbound: an accepted result is detached from plugin-owned shared memory', { skip: !HAS_SAB && 'SharedArrayBuffer unavailable' }, async () => {
  const pluginSab = new SharedArrayBuffer(4);
  const pluginBytes = new Uint8Array(pluginSab);
  pluginBytes.set([5, 6, 7, 8]);

  const registry = new PlatformPluginRegistry({ timeoutMs: 1000 });
  registry.registerAnalyzer('sab.outbound', {
    async analyze() { return new Uint8Array(pluginSab); },
  });

  const result = await registry.invoke('analyzer', 'sab.outbound', 'analyze', {});
  const snapshot = result.value;
  assert.ok(snapshot instanceof Uint8Array);
  assert.ok(!(snapshot.buffer instanceof SharedArrayBuffer), 'snapshot must not be backed by shared memory');
  pluginBytes[0] = 0xbb;
  assert.deepEqual(Array.from(snapshot), [5, 6, 7, 8], 'host-visible result must not track later plugin writes');
});

test('#8897 a detached snapshot keeps a plain ArrayBuffer value correct', async () => {
  const registry = new PlatformPluginRegistry({ timeoutMs: 1000 });
  registry.registerAnalyzer('plain.buffer', {
    async analyze(context) {
      const view = new Uint8Array(context.project.buffer);
      view[0] = 0xee;
      return Array.from(new Uint8Array(context.project.buffer));
    },
  });
  const source = new Uint8Array([9, 9, 9]);
  const result = await registry.invoke('analyzer', 'plain.buffer', 'analyze', { project: { buffer: source.buffer } });
  assert.deepEqual(result.value, [0xee, 9, 9]);
  assert.equal(source[0], 9, 'plain ArrayBuffer snapshot is copied, not transferred');
});

test('#8897 DataView over a SharedArrayBuffer is detached too', { skip: !HAS_SAB && 'SharedArrayBuffer unavailable' }, async () => {
  const sab = new SharedArrayBuffer(4);
  const dv = new DataView(sab);
  dv.setUint8(0, 1);
  const registry = new PlatformPluginRegistry({ timeoutMs: 1000 });
  registry.registerAnalyzer('sab.dataview', {
    async analyze(context) {
      context.project.view.setUint8(0, 0x7f);
      return context.project.view.getUint8(0);
    },
  });
  const result = await registry.invoke('analyzer', 'sab.dataview', 'analyze', { project: { view: dv } });
  assert.equal(result.value, 0x7f);
  assert.equal(dv.getUint8(0), 1, 'host DataView must be unaffected by plugin write');
});

test('#8897 SAB-backed views preserve offsets, repeated references, and cloned backing topology', { skip: !HAS_SAB && 'SharedArrayBuffer unavailable' }, async () => {
  const sab = new SharedArrayBuffer(8);
  const hostBytes = new Uint8Array(sab);
  hostBytes.set([0, 1, 2, 3, 4, 5, 6, 7]);
  const bytes = new Uint8Array(sab, 4, 2);
  const view = new DataView(sab, 2, 4);

  const registry = new PlatformPluginRegistry({ timeoutMs: 1000 });
  registry.registerAnalyzer('sab.view-topology', {
    async analyze(context) {
      const project = context.project;
      const before = Array.from(project.bytes);
      const sameView = project.bytes === project.repeatedBytes;
      const sameBacking = project.buffer === project.bytes.buffer && project.bytes.buffer === project.view.buffer;
      project.bytes[0] = 0xaa;
      return {
        before,
        byteOffset: project.bytes.byteOffset,
        length: project.bytes.length,
        dataViewOffset: project.view.byteOffset,
        dataViewLength: project.view.byteLength,
        sameView,
        sameBacking,
        overlappingByte: project.view.getUint8(2),
        sharedBacking: project.bytes.buffer instanceof SharedArrayBuffer,
      };
    },
  });

  const result = await registry.invoke('analyzer', 'sab.view-topology', 'analyze', {
    project: { buffer: sab, bytes, repeatedBytes: bytes, view },
  });
  assert.deepEqual(result.value, {
    before: [4, 5],
    byteOffset: 4,
    length: 2,
    dataViewOffset: 2,
    dataViewLength: 4,
    sameView: true,
    sameBacking: true,
    overlappingByte: 0xaa,
    sharedBacking: false,
  });
  assert.deepEqual(Array.from(hostBytes), [0, 1, 2, 3, 4, 5, 6, 7], 'detached topology must not alias host shared memory');
});
