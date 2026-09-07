import assert from 'node:assert/strict';
import test from 'node:test';

import { createPhase8ArtifactDescriptor } from '../../../js/decompiler/phase8/artifact-identity.js';

const BASE = Object.freeze({
  kind: 'phase8.constants',
  binaryId: 'binary_issue_3930',
  functionId: 'function_issue_3930',
  architectureId: 'arm64',
  snapshotId: 'snapshot_issue_3930',
  semanticSchemaVersion: 'semantic-ir/v2',
  cfgVersion: 'cfg/1',
  ssaVersion: 'ssa/1',
  producerId: 'phase8.sccp',
  producerVersion: '1.0.0',
  passRegistryDigest: 'digest-3930',
});

test('presentation-only fields cannot hide inside option arrays', () => {
  assert.throws(
    () => createPhase8ArtifactDescriptor({ ...BASE, options: { rows: [{ columnWidth: 80 }] } }),
    /presentation-state-in-key:columnWidth/,
  );
  assert.throws(
    () => createPhase8ArtifactDescriptor({ ...BASE, options: { groups: [[{ theme: 'dark' }]] } }),
    /presentation-state-in-key:theme/,
  );
  assert.throws(
    () => createPhase8ArtifactDescriptor({ ...BASE, options: [{ locale: 'ja-JP' }] }),
    /presentation-state-in-key:locale/,
  );
});

test('semantic option arrays remain valid artifact-key material', () => {
  const descriptor = createPhase8ArtifactDescriptor({
    ...BASE,
    options: {
      modes: ['exact', 'bounded'],
      rows: [{ semanticMode: 'signed' }, { semanticMode: 'unsigned' }],
    },
  });
  assert.ok(descriptor.artifactId);
});

test('cyclic option containers fail closed without overflowing the stack', () => {
  const objectCycle = {};
  objectCycle.self = objectCycle;
  assert.throws(
    () => createPhase8ArtifactDescriptor({ ...BASE, options: objectCycle }),
    /phase8-artifact-options-cycle/,
  );

  const arrayCycle = [];
  arrayCycle.push(arrayCycle);
  assert.throws(
    () => createPhase8ArtifactDescriptor({ ...BASE, options: { rows: arrayCycle } }),
    /phase8-artifact-options-cycle/,
  );
});

test('shared acyclic option objects are not mistaken for cycles', () => {
  const shared = { semanticMode: 'exact' };
  const descriptor = createPhase8ArtifactDescriptor({
    ...BASE,
    options: { left: shared, right: shared },
  });
  assert.ok(descriptor.artifactId);
});

test('stateful option accessors are rejected before they can drift into artifact hashing', () => {
  let reads = 0;
  const options = {};
  Object.defineProperty(options, 'rows', {
    enumerable: true,
    get() {
      reads += 1;
      return reads === 1 ? [{ semanticMode: 'exact' }] : [{ columnWidth: 80 }];
    },
  });

  assert.throws(
    () => createPhase8ArtifactDescriptor({ ...BASE, options }),
    /phase8-artifact-options-accessor:rows/,
  );
  assert.equal(reads, 0, 'descriptor snapshot must not execute caller-owned accessors');
});

test('proxy get traps cannot change options between validation and hashing', () => {
  let reads = 0;
  const stable = { rows: [{ semanticMode: 'exact' }] };
  const options = new Proxy(stable, {
    get(target, key, receiver) {
      if (key === 'rows') {
        reads += 1;
        return [{ columnWidth: 80 }];
      }
      return Reflect.get(target, key, receiver);
    },
  });

  const proxied = createPhase8ArtifactDescriptor({ ...BASE, options });
  const plain = createPhase8ArtifactDescriptor({ ...BASE, options: stable });
  assert.equal(proxied.artifactId, plain.artifactId);
  assert.equal(reads, 0, 'snapshot must use own data descriptors rather than proxy property reads');
});

test('shared-memory option buffers fail closed before artifact hashing', () => {
  if (typeof SharedArrayBuffer !== 'function') return;

  const shared = new SharedArrayBuffer(8);
  const bytes = new Uint8Array(shared);
  const view = new DataView(shared);
  bytes[0] = 0x41;

  assert.throws(
    () => createPhase8ArtifactDescriptor({ ...BASE, options: { bytes } }),
    /phase8-artifact-options-shared-buffer/,
  );
  assert.throws(
    () => createPhase8ArtifactDescriptor({ ...BASE, options: { view } }),
    /phase8-artifact-options-shared-buffer/,
  );
  assert.throws(
    () => createPhase8ArtifactDescriptor({ ...BASE, options: { shared } }),
    /phase8-artifact-options-shared-buffer/,
  );

  const shadowed = new Uint8Array(shared);
  Object.defineProperty(shadowed, 'buffer', {
    value: new ArrayBuffer(shared.byteLength),
    enumerable: false,
  });
  assert.throws(
    () => createPhase8ArtifactDescriptor({ ...BASE, options: { shadowed } }),
    /phase8-artifact-options-shared-buffer/,
  );
});

test('built-in containers with enumerable own properties fail closed instead of colliding', () => {
  const signed = new Map([['a', 1]]);
  signed.semanticMode = 'signed';
  const unsigned = new Map([['a', 1]]);
  unsigned.semanticMode = 'unsigned';

  let signedId = null;
  assert.throws(
    () => {
      const d = createPhase8ArtifactDescriptor({ ...BASE, options: { map: signed } });
      signedId = d.artifactId;
    },
    /phase8-artifact-options-embedded-own-property/,
  );

  assert.throws(
    () => createPhase8ArtifactDescriptor({ ...BASE, options: { map: unsigned } }),
    /phase8-artifact-options-embedded-own-property/,
  );
  assert.equal(signedId, null, 'colliding artifactId must never be produced');

  assert.throws(
    () => createPhase8ArtifactDescriptor({ ...BASE, options: { set: Object.assign(new Set([1]), { mode: 'x' }) } }),
    /phase8-artifact-options-embedded-own-property:set/,
  );
  assert.throws(
    () => createPhase8ArtifactDescriptor({ ...BASE, options: { view: Object.assign(new Uint8Array([1]), { mode: 'x' }) } }),
    /phase8-artifact-options-embedded-own-property:view/,
  );
  const ab = new ArrayBuffer(4);
  ab.tag = 't';
  assert.throws(
    () => createPhase8ArtifactDescriptor({ ...BASE, options: { ab } }),
    /phase8-artifact-options-embedded-own-property:arraybuffer/,
  );
  assert.throws(
    () => createPhase8ArtifactDescriptor({ ...BASE, options: { date: Object.assign(new Date(0), { mode: 'x' }) } }),
    /phase8-artifact-options-embedded-own-property:date/,
  );

  const plain = new Map([['a', 1]]);
  assert.doesNotThrow(() => createPhase8ArtifactDescriptor({ ...BASE, options: { map: plain } }));

  assert.doesNotThrow(
    () => createPhase8ArtifactDescriptor({ ...BASE, options: { view: new Uint8Array([1, 2, 3, 4]) } }),
    'in-range index properties of typed-array views are intrinsic state and stay accepted',
  );
});
