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
