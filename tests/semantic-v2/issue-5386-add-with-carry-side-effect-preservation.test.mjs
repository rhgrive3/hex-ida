import assert from 'node:assert/strict';
import test from 'node:test';

import { OP } from '../../js/ir-core.js';
import { parseOperands } from '../../js/arm64.js';
import { ARM64_ARCHITECTURE } from '../../js/targets/architecture/index.js';
import { buildSemanticV2CompatibilityPipeline } from '../../js/semantics/compat/index.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../js/semantics/compat/semantic-ir-v2-to-v1.js';

function decoded(address, mnemonic, operands) {
  return { address, mnemonic, operands, ops: parseOperands(operands), mode: 'a64' };
}

function exactAddWithCarryIr() {
  const result = buildSemanticV2CompatibilityPipeline({
    architecturePlugin: ARM64_ARCHITECTURE,
    decoderSemanticVersion: 'issue-5386-add-with-carry-effects-1',
    binaryId: 'binary_5386_add_with_carry',
    sliceId: 'slice_5386_add_with_carry',
    addressWidthBits: 64,
    entryBlockKey: 'entry',
    blocks: [{
      key: 'entry',
      startAddress: 0x1000n,
      instructions: [
        { decoded: decoded(0x1000n, 'add', 'w8, w8, #10') },
        { decoded: decoded(0x1004n, 'ret', '') },
      ],
      successors: [],
    }],
  });
  return structuredClone(result.semanticIr);
}

function projectWithIntrinsicEffects(overrides = {}) {
  const ir = exactAddWithCarryIr();
  const node = ir.nodes.find((candidate) => candidate.kind === 'intrinsic' && candidate.operator === 'add-with-carry');
  assert.ok(node, 'fixture must contain canonical add-with-carry intrinsic');
  node.intrinsic = { ...node.intrinsic, ...overrides };
  const out = projectSemanticIrV2ToLegacyV1(ir);
  const inst = out.instructions.find((candidate) => candidate.sourceEntityId === node.id);
  assert.ok(inst, 'projection must retain the intrinsic source entity');
  return inst;
}

test('#5386: add-with-carry with memoryWrite:all preserves the side effect', () => {
  const inst = projectWithIntrinsicEffects({ memoryWrite: { scope: 'all', addressSpaces: ['memory'] } });
  assert.equal(inst.op, OP.CLOBBER);
  assert.equal(inst.memoryBarrier, true);
  assert.ok(inst.extra?.intrinsic);
});

test('#5386: add-with-carry with stateWrites preserves clobbers', () => {
  const inst = projectWithIntrinsicEffects({
    stateWrites: [{
      key: 'state:nzcv',
      kind: 'physical-state',
      scope: 'function',
      physicalIdentity: { kind: 'flag', flagId: 'nzcv' },
    }],
  });
  assert.equal(inst.op, OP.CLOBBER);
  assert.deepEqual(inst.clobbers, ['nzcv']);
  assert.ok(inst.extra?.intrinsic);
});

test('#5386: pure add-with-carry keeps the exact arithmetic projection', () => {
  const inst = projectWithIntrinsicEffects();
  assert.equal(inst.op, OP.BIN);
  assert.equal(inst.sub, 'add');
  assert.equal(inst.extra?.compatSource, 'exact-add-with-carry-intrinsic');
});
