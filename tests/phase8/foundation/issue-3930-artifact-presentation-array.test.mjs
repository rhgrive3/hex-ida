import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

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

test('clean built-in contents remain part of artifact identity', () => {
  const descriptor = (options) => createPhase8ArtifactDescriptor({ ...BASE, options }).artifactId;

  assert.notEqual(
    descriptor({ map: new Map([['mode', 'signed']]) }),
    descriptor({ map: new Map([['mode', 'unsigned']]) }),
    'Map entries must remain key material after the owned clone',
  );
  assert.notEqual(
    descriptor({ set: new Set(['signed']) }),
    descriptor({ set: new Set(['unsigned']) }),
    'Set entries must remain key material after the owned clone',
  );
  assert.notEqual(
    descriptor({ date: new Date(0) }),
    descriptor({ date: new Date(1) }),
    'Date timestamps must remain key material after the owned clone',
  );

  const firstBytes = new ArrayBuffer(4);
  new Uint8Array(firstBytes)[0] = 1;
  const secondBytes = new ArrayBuffer(4);
  new Uint8Array(secondBytes)[0] = 2;
  assert.notEqual(
    descriptor({ bytes: firstBytes }),
    descriptor({ bytes: secondBytes }),
    'ArrayBuffer bytes must remain key material after the owned clone',
  );
});

test('cross-realm built-ins retain intrinsic key material', () => {
  const descriptor = (options) => createPhase8ArtifactDescriptor({ ...BASE, options }).artifactId;

  const mapSigned = vm.runInNewContext("new Map([['mode', 'signed']])");
  const mapUnsigned = vm.runInNewContext("new Map([['mode', 'unsigned']])");
  assert.notEqual(
    descriptor({ map: mapSigned }),
    descriptor({ map: mapUnsigned }),
    'cross-realm Map entries must not be dropped as plain-object options',
  );

  const setSigned = vm.runInNewContext("new Set(['signed'])");
  const setUnsigned = vm.runInNewContext("new Set(['unsigned'])");
  assert.notEqual(
    descriptor({ set: setSigned }),
    descriptor({ set: setUnsigned }),
    'cross-realm Set entries must not be dropped as plain-object options',
  );

  const bufferSigned = vm.runInNewContext(
    '(() => { const value = new ArrayBuffer(4); new Uint8Array(value)[0] = 1; return value; })()',
  );
  const bufferUnsigned = vm.runInNewContext(
    '(() => { const value = new ArrayBuffer(4); new Uint8Array(value)[0] = 2; return value; })()',
  );
  assert.notEqual(
    descriptor({ buffer: bufferSigned }),
    descriptor({ buffer: bufferUnsigned }),
    'cross-realm ArrayBuffer bytes must remain key material',
  );

  const dateSigned = vm.runInNewContext('new Date(0)');
  const dateUnsigned = vm.runInNewContext('new Date(1)');
  assert.notEqual(
    descriptor({ date: dateSigned }),
    descriptor({ date: dateUnsigned }),
    'cross-realm Date timestamps must remain key material',
  );
});

test('cross-realm DataViews use the intrinsic DataView classification', () => {
  const foreign = vm.runInNewContext('new DataView(new ArrayBuffer(8))');
  Object.defineProperty(foreign, '0', { value: 'foreign-payload', enumerable: true });

  assert.throws(
    () => createPhase8ArtifactDescriptor({ ...BASE, options: { view: foreign } }),
    /phase8-artifact-options-embedded-own-property:dataview/,
  );
});

test('arrays and DataViews cannot carry invisible semantic payload into artifact keys', () => {
  const signed = [1, 2, 3];
  signed.semanticMode = 'signed';
  const unsigned = [1, 2, 3];
  unsigned.semanticMode = 'unsigned';

  let minted = null;
  assert.throws(
    () => {
      const d = createPhase8ArtifactDescriptor({ ...BASE, options: { rows: signed } });
      minted = d.artifactId;
    },
    /phase8-artifact-options-embedded-own-property:array:semanticMode/,
  );
  assert.throws(
    () => createPhase8ArtifactDescriptor({ ...BASE, options: { rows: unsigned } }),
    /phase8-artifact-options-embedded-own-property:array:semanticMode/,
  );
  assert.equal(minted, null, 'colliding artifactId must never be minted for arrays');

  const sym = Symbol('tag');
  const symbolic = [1];
  symbolic[sym] = 'payload';
  assert.throws(
    () => createPhase8ArtifactDescriptor({ ...BASE, options: { rows: symbolic } }),
    /phase8-artifact-options-embedded-own-property:array:Symbol\(tag\)/,
  );

  const dvSigned = new DataView(new ArrayBuffer(8));
  dvSigned.setUint8(0, 1);
  Object.defineProperty(dvSigned, '0', { value: 'signed', enumerable: true });
  const dvUnsigned = new DataView(new ArrayBuffer(8));
  dvUnsigned.setUint8(0, 1);
  Object.defineProperty(dvUnsigned, '0', { value: 'unsigned', enumerable: true });
  assert.throws(
    () => createPhase8ArtifactDescriptor({ ...BASE, options: { dv: dvSigned } }),
    /phase8-artifact-options-embedded-own-property:dataview/,
  );
  assert.throws(
    () => createPhase8ArtifactDescriptor({ ...BASE, options: { dv: dvUnsigned } }),
    /phase8-artifact-options-embedded-own-property:dataview/,
  );

  assert.doesNotThrow(
    () => createPhase8ArtifactDescriptor({ ...BASE, options: { rows: [1, 2, 3] } }),
    'plain arrays without attached props stay accepted',
  );
  assert.doesNotThrow(
    () => createPhase8ArtifactDescriptor({ ...BASE, options: { dv: new DataView(new ArrayBuffer(8)) } }),
    'plain DataViews stay accepted',
  );
});

test('classification never executes caller-owned Symbol.toStringTag getters', () => {
  let reads = 0;
  const options = new Map([['mode', 'signed']]);
  Object.defineProperty(options, Symbol.toStringTag, {
    get() {
      reads += 1;
      return 'Map';
    },
    enumerable: true,
  });

  const plainProbe = {};
  Object.defineProperty(plainProbe, Symbol.toStringTag, {
    get() {
      reads += 1;
      return 'Map';
    },
    enumerable: true,
  });

  let descriptorId = null;
  assert.throws(
    () => {
      const d = createPhase8ArtifactDescriptor({ ...BASE, options: { map: options } });
      descriptorId = d.artifactId;
    },
    /phase8-artifact-options-embedded-own-property:map:Symbol\(Symbol.toStringTag\)/,
    'a real Map carrying a Symbol.toStringTag own property fails closed',
  );
  assert.equal(reads, 0, 'caller-owned toStringTag getter must never run');
  assert.equal(descriptorId, null);

  assert.throws(
    () => createPhase8ArtifactDescriptor({ ...BASE, options: { decoy: plainProbe } }),
    /phase8-artifact-options-embedded-own-property:object:Symbol\(Symbol.toStringTag\)/,
    'plain objects spoofing the Map tag carry an enumerable symbol-key payload and fail closed',
  );

  const tagged = [1, 2, 3];
  Object.defineProperty(tagged, Symbol.toStringTag, {
    get() {
      reads += 1;
      return 'Array';
    },
    enumerable: true,
  });
  assert.throws(
    () => createPhase8ArtifactDescriptor({ ...BASE, options: { rows: tagged } }),
    /phase8-artifact-options-embedded-own-property/,
    'arrays carrying Symbol.toStringTag fail closed without reading it',
  );
  assert.equal(reads, 0);
});

test('plain objects cannot carry enumerable symbol-key payload into artifact keys', () => {
  const s = Symbol('semanticMode');
  const signed = { mode: 1 };
  signed[s] = 'signed';
  const unsigned = { mode: 1 };
  unsigned[s] = 'unsigned';

  let minted = null;
  assert.throws(
    () => {
      const d = createPhase8ArtifactDescriptor({ ...BASE, options: signed });
      minted = d.artifactId;
    },
    /phase8-artifact-options-embedded-own-property:object:Symbol\(semanticMode\)/,
  );
  assert.throws(
    () => createPhase8ArtifactDescriptor({ ...BASE, options: unsigned }),
    /phase8-artifact-options-embedded-own-property:object:Symbol\(semanticMode\)/,
  );
  assert.equal(minted, null, 'colliding artifactId must never be minted for symbol payload');

  assert.doesNotThrow(
    () => createPhase8ArtifactDescriptor({ ...BASE, options: { mode: 1 } }),
    'plain string-keyed objects stay accepted',
  );
});
