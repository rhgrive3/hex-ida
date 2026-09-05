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
