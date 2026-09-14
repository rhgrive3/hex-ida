import assert from 'node:assert/strict';
import test from 'node:test';

import { OP } from '../../js/architecture/compat/ir-core-arm64-aapcs64-v1.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../js/semantics/compat/semantic-ir-v2-to-v1.js';

// `exact-machine-bitfield-metadata` is an exact semantic promotion, so the
// metadata must already satisfy the primitive contract before the compat
// consumer reads it. String()/Number() coercion must not mint lsb/width/
// signedness that the producer never proved (#4582).

const origin = { instructionIds: ['instruction_0'] };

function irFor(operationMetadata, outputBits = 32) {
  return {
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId: 'f',
    entryBlockId: 'b0',
    blocks: [{ id: 'b0', nodeIds: ['src', 'ext'] }],
    values: [
      {
        id: 'vin', kind: 'definition',
        machineType: { kind: 'bitvector', widthBits: 64 },
        definitionNodeId: 'src', sourceEntityId: null, variableKey: null, origin,
      },
      {
        id: 'vout', kind: 'definition',
        machineType: { kind: 'bitvector', widthBits: outputBits },
        definitionNodeId: 'ext', sourceEntityId: null, variableKey: null, origin,
      },
    ],
    nodes: [
      {
        id: 'src', kind: 'const', blockId: 'b0', inputs: [], outputs: ['vin'],
        attributes: { value: 7n }, completeness: 'complete', origin,
      },
      {
        id: 'ext', kind: 'intrinsic', blockId: 'b0', operator: 'bitfield-extract',
        inputs: ['vin'], outputs: ['vout'],
        intrinsic: {
          inputs: ['vin'], outputs: ['vout'], stateReads: [], stateWrites: [],
          memoryRead: { scope: 'none' }, memoryWrite: { scope: 'none' },
          controlEffects: [], determinism: 'deterministic', symbolicDetail: 'available',
        },
        attributes: { machineEffects: { operationMetadata } },
        completeness: 'complete',
        origin,
      },
    ],
    completeness: 'complete', unknowns: [], origin,
  };
}

function projectionFor(operationMetadata, outputBits) {
  const out = projectSemanticIrV2ToLegacyV1(irFor(operationMetadata, outputBits));
  return out.instructions.find((candidate) => candidate.semanticNodeId === 'ext');
}

function assertGenericIntrinsic(inst, label) {
  assert.equal(inst.op, OP.CLOBBER, `${label}: non-primitive metadata must stay a generic intrinsic`);
  assert.notEqual(inst.extra?.compatSource, 'exact-machine-bitfield-metadata', `${label}: exact provenance must not be published`);
  assert.equal(inst.extra?.lsb, undefined, `${label}: unproven lsb must not be published`);
  assert.equal(inst.extra?.width, undefined, `${label}: unproven width must not be published`);
  assert.equal(inst.extra?.signed, undefined, `${label}: unproven signedness must not be published`);
  assert.equal(inst.extra?.bitfieldKind, undefined, `${label}: unproven bitfield kind must not be published`);
}

test('#4582: primitive ubfx metadata keeps the exact BFX projection', () => {
  const inst = projectionFor({ alias: 'ubfx', immr: 8, imms: 15 });
  assert.equal(inst.op, OP.BFX);
  assert.equal(inst.sub, 'extract');
  assert.equal(inst.extra.lsb, 8);
  assert.equal(inst.extra.width, 8);
  assert.equal(inst.extra.signed, false);
  assert.equal(inst.extra.bitfieldKind, 'ubfx');
  assert.equal(inst.extra.compatSource, 'exact-machine-bitfield-metadata');
});

test('#4582: primitive sbfx metadata keeps the exact signed BFX projection', () => {
  const inst = projectionFor({ alias: 'sbfx', immr: 8, imms: 15 });
  assert.equal(inst.op, OP.BFX);
  assert.equal(inst.extra.signed, true);
  assert.equal(inst.extra.bitfieldKind, 'sbfx');
  assert.equal(inst.extra.compatSource, 'exact-machine-bitfield-metadata');
});

test('#4582: array metadata does not coerce into exact BFX semantics', () => {
  assertGenericIntrinsic(projectionFor({ alias: ['ubfx'], immr: 8, imms: 15 }), 'alias array');
  assertGenericIntrinsic(projectionFor({ alias: 'ubfx', immr: ['8'], imms: 15 }), 'immr array');
  assertGenericIntrinsic(projectionFor({ alias: 'ubfx', immr: 8, imms: ['15'] }), 'imms array');
  assertGenericIntrinsic(projectionFor({ alias: ['sbfx'], immr: ['8'], imms: ['15'] }), 'all arrays');
});

test('#4582: numeric strings are not integer metadata facts', () => {
  assertGenericIntrinsic(projectionFor({ alias: 'ubfx', immr: '8', imms: '15' }), 'both strings');
  assertGenericIntrinsic(projectionFor({ alias: 'ubfx', immr: 8, imms: '15' }), 'imms string');
  assertGenericIntrinsic(projectionFor({ alias: 'ubfx', immr: '8', imms: 15 }), 'immr string');
});

test('#4582: boolean/null/object metadata never mints BFX', () => {
  assertGenericIntrinsic(projectionFor({ alias: 'ubfx', immr: true, imms: 15 }), 'immr boolean');
  assertGenericIntrinsic(projectionFor({ alias: 'ubfx', immr: 8, imms: true }), 'imms boolean');
  assertGenericIntrinsic(projectionFor({ alias: 'ubfx', immr: null, imms: 15 }), 'immr null');
  assertGenericIntrinsic(projectionFor({ alias: 'ubfx', immr: 8, imms: null }), 'imms null');
  assertGenericIntrinsic(projectionFor({ alias: 'ubfx', immr: {}, imms: 15 }), 'immr object');
  assertGenericIntrinsic(projectionFor({ alias: 'ubfx', immr: 8, imms: {} }), 'imms object');
  assertGenericIntrinsic(projectionFor({ alias: {}, immr: 8, imms: 15 }), 'alias object');
  assertGenericIntrinsic(projectionFor({ alias: ['ubfx'], immr: 8, imms: 15 }), 'alias array');
});

test('#4582: non-string alias values do not reach the bitfield branch', () => {
  assertGenericIntrinsic(projectionFor({ alias: 0, immr: 8, imms: 15 }), 'numeric alias');
  assertGenericIntrinsic(projectionFor({ immr: 8, imms: 15 }), 'absent alias');
});

test('#4582: unsafe-integer and range-violating primitive metadata stays fail closed', () => {
  assertGenericIntrinsic(projectionFor({ alias: 'ubfx', immr: 2 ** 53, imms: 2 ** 53 + 1 }), 'immr unsafe');
  assertGenericIntrinsic(projectionFor({ alias: 'ubfx', immr: 8, imms: 2 ** 53 + 1 }), 'imms unsafe');
  assertGenericIntrinsic(projectionFor({ alias: 'ubfx', immr: 1.5, imms: 15 }), 'non-integer immr');
  assertGenericIntrinsic(projectionFor({ alias: 'ubfx', immr: 15, imms: 8 }), 'imms below immr');
  assertGenericIntrinsic(projectionFor({ alias: 'ubfx', immr: -1, imms: 15 }), 'negative immr');
  assertGenericIntrinsic(projectionFor({ alias: 'ubfx', immr: 20, imms: 40 }), 'field beyond output width');
});

test('#4582: exact projection remains available for a full-width primitive field', () => {
  const inst = projectionFor({ alias: 'ubfx', immr: 0, imms: 31 }, 32);
  assert.equal(inst.op, OP.BFX);
  assert.equal(inst.extra.lsb, 0);
  assert.equal(inst.extra.width, 32);
});
