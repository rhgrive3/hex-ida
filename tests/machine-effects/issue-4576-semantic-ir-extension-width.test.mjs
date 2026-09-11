import assert from 'node:assert/strict';
import test from 'node:test';
import { createInstructionId } from '../../js/core/identity/index.js';
import {
  createBitVectorValue,
  createMachineEffectBundle,
  createMachineOperation,
  createMemoryAccess,
  createTemporaryValue,
} from '../../js/semantics/effects/index.js';
import { lowerMachineEffectBundleToSemanticIr } from '../../js/semantics/ir/from-machine-effects.js';
import { createSemanticIrFunction } from '../../js/semantics/ir/index.js';

/* MachineEffects address expressions may declare zero-extend/sign-extend
 * fromBits/toBits independently of the inner value they wrap. The Semantic IR
 * lowering accepted any fromBits <= toBits and minted a canonical zext/sext
 * node whose declared input width contradicted the actual lowered input value,
 * while the function stayed complete (#4576). The declared fromBits must equal
 * the proven width of the lowered input; otherwise the expression fails
 * closed and the consuming memory access degrades to an unknown projection. */

const INST = createInstructionId({
  binaryId: 'bin_4576', sliceId: 'slice_4576', virtualAddress: 0x1000n,
  decodeMode: 'a64', decoderSemanticVersion: '1',
});
const ORIGIN = {
  instructionIds: [INST],
  byteRanges: [{ binaryId: 'bin_4576', start: 0x20n, end: 0x24n }],
  virtualRanges: [{ imageId: 'image_4576', sliceId: 'slice_4576', start: 0x1000n, end: 0x1004n }],
};

function lowerAddressExpr(addressExpr) {
  const access = createMemoryAccess({ space: 'memory', addressExpr, widthBits: 64, endian: 'little' });
  const bundle = createMachineEffectBundle({
    instructionId: INST,
    architectureId: 'arm64',
    mode: 'a64',
    operations: [
      createMachineOperation({
        id: 'mem-read',
        kind: 'memory-read',
        access,
        value: createTemporaryValue('tmp_m', createBitVectorValue(64)),
      }),
    ],
    controlEffect: { kind: 'fallthrough' },
    possibleFaults: [],
    origin: ORIGIN,
    completeness: 'exact',
  });
  const lowered = lowerMachineEffectBundleToSemanticIr(bundle, { functionId: 'fn:4576', blockId: 'blk:0' });
  const fn = lowered?.function ?? lowered;
  return {
    nodes: fn?.nodes ?? [],
    completeness: fn?.completeness,
    unknowns: fn?.unknowns ?? [],
  };
}

test('#4576: zero-extend fromBits contradicting the inner width must not mint a zext node', () => {
  const out = lowerAddressExpr({
    kind: 'zero-extend',
    value: { kind: 'bitvector', widthBits: 8, value: '32' },
    fromBits: 32,
    toBits: 64,
  });
  assert.equal(out.nodes.some((n) => n.kind === 'zext'), false, 'width-contradictory zext is not canonical');
  assert.notEqual(out.completeness, 'complete', 'the mismatch must fail the bundle closed');
  assert.ok(
    out.unknowns.some((issue) => issue.reason === 'extension-expression-input-width-mismatch'),
    'the failure records the width-mismatch reason',
  );
  const unknownMemory = out.nodes.find((n) => n.kind === 'unknown-memory-effect');
  assert.ok(unknownMemory, 'the memory read degrades to an unknown projection');
  assert.equal(unknownMemory.unknown?.reason, 'extension-expression-input-width-mismatch');
});

test('#4576: sign-extend fromBits contradicting the inner width must not mint a sext node', () => {
  const out = lowerAddressExpr({
    kind: 'sign-extend',
    value: { kind: 'bitvector', widthBits: 8, value: '32' },
    fromBits: 16,
    toBits: 64,
  });
  assert.equal(out.nodes.some((n) => n.kind === 'sext'), false);
  assert.notEqual(out.completeness, 'complete');
});

test('#4576: a coherent extension still lowers to a canonical zext node', () => {
  const out = lowerAddressExpr({
    kind: 'zero-extend',
    value: { kind: 'bitvector', widthBits: 32, value: '32' },
    fromBits: 32,
    toBits: 64,
  });
  const zext = out.nodes.find((n) => n.kind === 'zext');
  assert.ok(zext, 'matching fromBits keeps the canonical extension');
  assert.equal(zext.attributes?.fromBits, 32);
  assert.equal(zext.attributes?.toBits, 64);
});

/* The canonical Semantic IR boundary itself must reject a directly
 * constructed zext/sext whose declared widths contradict its machine types —
 * createSemanticIrFunction() is the non-bypassable authority (#4576). */

const FN_ORIGIN = { instructionIds: ['instruction_4576'] };

function extensionFunction({ inputWidth, outputWidth, fromBits, toBits, withAttributes = true }) {
  return {
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId: 'fn_4576',
    entryBlockId: 'blk_0',
    blocks: [{ id: 'blk_0', nodeIds: ['node_zext'], origin: FN_ORIGIN }],
    values: [
      { id: 'value_in', kind: 'entry', machineType: { kind: 'bitvector', widthBits: inputWidth }, sourceEntityId: 'fn_4576', origin: FN_ORIGIN },
      { id: 'value_out', kind: 'definition', machineType: { kind: 'bitvector', widthBits: outputWidth }, definitionNodeId: 'node_zext', sourceEntityId: 'node_zext', origin: FN_ORIGIN },
    ],
    nodes: [{
      id: 'node_zext',
      kind: 'zext',
      blockId: 'blk_0',
      inputs: ['value_in'],
      outputs: ['value_out'],
      operator: 'zero-extend',
      attributes: withAttributes ? { fromBits, toBits } : {},
      origin: FN_ORIGIN,
    }],
    completeness: 'complete',
    unknowns: [],
    origin: FN_ORIGIN,
  };
}

test('#4576: the canonical boundary rejects a zext whose input width contradicts fromBits', () => {
  assert.throws(
    () => createSemanticIrFunction(extensionFunction({ inputWidth: 8, outputWidth: 64, fromBits: 32, toBits: 64 })),
    /semantic-ir-extension-input-width-mismatch/,
  );
});

test('#4576: the canonical boundary rejects a zext whose output width contradicts toBits', () => {
  assert.throws(
    () => createSemanticIrFunction(extensionFunction({ inputWidth: 32, outputWidth: 128, fromBits: 32, toBits: 64 })),
    /semantic-ir-extension-output-width-mismatch/,
  );
});

test('#4576: the canonical boundary rejects an inverted fromBits/toBits relation', () => {
  assert.throws(
    () => createSemanticIrFunction(extensionFunction({ inputWidth: 64, outputWidth: 32, fromBits: 64, toBits: 32 })),
    /semantic-ir-extension-width-relation-invalid/,
  );
});

test('#4576: the canonical boundary requires declared extension widths', () => {
  assert.throws(
    () => createSemanticIrFunction(extensionFunction({ inputWidth: 32, outputWidth: 64, fromBits: 32, toBits: 64, withAttributes: false })),
    /semantic-ir-extension-width-attributes-required/,
  );
});

test('#4576: a coherent canonical zext still constructs', () => {
  const fn = createSemanticIrFunction(extensionFunction({ inputWidth: 32, outputWidth: 64, fromBits: 32, toBits: 64 }));
  assert.equal(fn.completeness, 'complete');
  assert.equal(fn.nodes[0].kind, 'zext');
});

function lowerValueOperationBundle(opcode, inputWidth, outputWidth) {
  const bundle = createMachineEffectBundle({
    instructionId: INST,
    architectureId: 'arm64',
    mode: 'a64',
    operations: [
      createMachineOperation({
        id: 'extension-op',
        kind: 'value',
        opcode,
        inputs: [createTemporaryValue('tmp_in', createBitVectorValue(inputWidth))],
        outputs: [createTemporaryValue('tmp_out', createBitVectorValue(outputWidth))],
      }),
    ],
    controlEffect: { kind: 'fallthrough' },
    possibleFaults: [],
    origin: ORIGIN,
    completeness: 'exact',
  });
  const lowered = lowerMachineEffectBundleToSemanticIr(bundle, { functionId: 'fn:4576-op', blockId: 'blk:0' });
  const fn = lowered?.function ?? lowered;
  return {
    nodes: fn?.nodes ?? [],
    completeness: fn?.completeness,
    unknowns: fn?.unknowns ?? [],
  };
}

test('#4576: a provable value-operation zext declares its machine-type-matched widths', () => {
  const out = lowerValueOperationBundle('zext', 32, 64);
  const zext = out.nodes.find((n) => n.kind === 'zext');
  assert.ok(zext, 'a provable widening stays a canonical zext');
  assert.equal(zext.attributes?.fromBits, 32);
  assert.equal(zext.attributes?.toBits, 64);
});

test('#4576: a mislabeled shrink value operation must not mint a canonical zext', () => {
  const out = lowerValueOperationBundle('zext', 64, 32);
  assert.equal(out.nodes.some((n) => n.kind === 'zext' || n.kind === 'sext'), false);
  const intrinsic = out.nodes.find((n) => n.kind === 'intrinsic');
  assert.ok(intrinsic, 'the unprovable extension stays observable as an intrinsic');
  assert.equal(intrinsic.unknown?.reason, 'extension-machine-value-width-unproven');
  assert.notEqual(out.completeness, 'complete');
  assert.ok(out.unknowns.some((issue) => issue.reason === 'extension-machine-value-width-unproven'));
});
