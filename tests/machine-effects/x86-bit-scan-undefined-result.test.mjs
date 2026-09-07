import assert from 'node:assert/strict';
import test from 'node:test';

import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { liftX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import { createCapstoneX86Session } from '../phase5/helpers/capstone-session.mjs';

const CASES = [
  { id:'bsf-r16', bytes:[0x66,0x0f,0xbc,0xc3], width:16, form:'register' },
  { id:'bsf-r32', bytes:[0x0f,0xbc,0xc3], width:32, form:'register' },
  { id:'bsr-r64', bytes:[0x48,0x0f,0xbd,0xc3], width:64, form:'register' },
  { id:'bsf-m16', bytes:[0x66,0x0f,0xbc,0x03], width:16, form:'memory' },
  { id:'bsr-m32', bytes:[0x0f,0xbd,0x03], width:32, form:'memory' },
  { id:'bsf-m64', bytes:[0x48,0x0f,0xbc,0x03], width:64, form:'memory' },
];

function conditionalProducer(bundle) {
  const marked = bundle.operations.filter((operation) => operation.undefinedResult?.class === 'conditional');
  assert.equal(marked.length, 1, 'only the destination producer carries source-zero undefinedness');
  return marked[0];
}

test('real BSF/BSR forms preserve destination and flag definedness', async () => {
  const session = await createCapstoneX86Session();
  try {
    for (const item of CASES) {
      const decoded = session.decode(Uint8Array.from(item.bytes), 0x510000n)[0];
      const bundle = liftX86MachineEffects({ ...decoded, instructionId:`x86-bit-scan:${item.id}` });
      assert.equal(bundle.completeness, 'exact-with-intrinsic', item.id);
      assert.equal(bundle.metadata.encodingValidated, true, item.id);
      assert.equal(bundle.metadata.sourceForm, item.form, item.id);
      const producer = conditionalProducer(bundle);
      assert.equal(producer.kind, 'intrinsic', item.id);
      assert.deepEqual(producer.undefinedResult, {
        schemaVersion:'machine-effects-undefined-result/v1',
        widthBits:item.width,
        mask:`0x${((1n << BigInt(item.width)) - 1n).toString(16)}`,
        class:'conditional',
        reason:`x86-${decoded.instructionFamily}-source-zero-destination-undefined`,
        condition:{ kind:'source-zero', operandIndex:0 },
      });
      assert.equal(bundle.operations.some((operation) => operation.kind === 'memory-read'), item.form === 'memory', item.id);
      const flagWrites = bundle.operations.filter((operation) => operation.kind === 'flag-write');
      assert.deepEqual(flagWrites.map((operation) => operation.flag.flagId).sort(),
        ['RFLAGS.AF','RFLAGS.CF','RFLAGS.OF','RFLAGS.PF','RFLAGS.SF','RFLAGS.ZF']);
      assert.equal(flagWrites.find((operation) => operation.flag.flagId === 'RFLAGS.ZF')?.metadata.definedness, 'defined', item.id);
      assert.ok(flagWrites.filter((operation) => operation.flag.flagId !== 'RFLAGS.ZF')
        .every((operation) => operation.metadata.definedness === 'undefined'), item.id);
    }
  } finally {
    session.close();
  }
});

test('untrusted or inconsistent BSF/BSR records remain partial', async () => {
  const session = await createCapstoneX86Session();
  try {
    const decoded = session.decode(Uint8Array.of(0x0f,0xbc,0xc3), 0x520000n)[0];
    for (const [id, patch] of [
      ['decoder', { decoderSemanticVersion:'untrusted-decoder/v1' }],
      ['operands', { detail:{ ...decoded.detail, operands:[
        { ...decoded.detail.operands[0], registerId:'ecx' }, decoded.detail.operands[1],
      ] } }],
    ]) {
      const candidate = createX86DecodedInstruction({ ...decoded, ...patch, instructionId:`x86-bit-scan:near-miss:${id}` });
      const bundle = liftX86MachineEffects(candidate);
      assert.equal(bundle.completeness, 'partial', id);
      assert.equal(bundle.metadata.encodingValidated, false, id);
      assert.equal(bundle.operations.some((operation) => operation.undefinedResult != null), false, id);
    }
  } finally {
    session.close();
  }
});
