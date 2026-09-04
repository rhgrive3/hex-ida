import assert from 'node:assert/strict';
import test from 'node:test';

import { OP } from '../../js/architecture/compat/ir-core-arm64-aapcs64-v1.js';
import { runSccpPass, SCCP_PASS } from '../../js/decompiler/phase8/sccp.js';
import { isFull } from '../../js/decompiler/phase8/range.js';
import { runPassTransaction, seedAnalysisState } from '../../js/decompiler/phase8/transaction.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../js/semantics/compat/semantic-ir-v2-to-v1.js';
import { serializeMachineEffectBundle } from '../../js/semantics/effects/index.js';
import { lowerMachineEffectBundleToSemanticIr } from '../../js/semantics/ir/from-machine-effects.js';
import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { liftX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import { createCapstoneX86Session } from '../phase5/helpers/capstone-session.mjs';

function one(session, bytes, address = 0x510000n) {
  const decoded = session.decode(Uint8Array.from(bytes), address);
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].length, bytes.length);
  return decoded[0];
}

function cloneDecoded(decoded, patch = {}) {
  const detailPatch = patch.detail ?? {};
  return {
    ...decoded,
    ...patch,
    rawBytes:Uint8Array.from(patch.rawBytes ?? decoded.rawBytes),
    detail:{
      ...decoded.detail,
      ...detailPatch,
      prefixes:{
        ...decoded.detail.prefixes,
        ...(detailPatch.prefixes ?? {}),
        legacy:Uint8Array.from(detailPatch.prefixes?.legacy ?? decoded.detail.prefixes.legacy),
      },
      operands:(detailPatch.operands ?? decoded.detail.operands).map((operand) => ({ ...operand })),
      implicitReads:[...(detailPatch.implicitReads ?? decoded.detail.implicitReads)],
      implicitWrites:[...(detailPatch.implicitWrites ?? decoded.detail.implicitWrites)],
    },
  };
}

function descriptorOperation(bundle) {
  const marked = bundle.operations.filter((operation) => operation.undefinedResult != null);
  assert.equal(marked.length, 1, 'the condition belongs only to the destination producer');
  return marked[0];
}

test('real BSF/BSR register and memory forms retain the conditional full-width destination boundary', async () => {
  const session = await createCapstoneX86Session();
  try {
    const cases = [
      { id:'bsf-r16', bytes:[0x66,0x0f,0xbc,0xc3], width:16, form:'register', writePolicy:'preserve-unaffected' },
      { id:'bsf-r32', bytes:[0x0f,0xbc,0xc3], width:32, form:'register', writePolicy:'zero-extend-32' },
      { id:'bsr-r64', bytes:[0x48,0x0f,0xbd,0xc3], width:64, form:'register', writePolicy:'replace' },
      { id:'bsf-m16', bytes:[0x66,0x0f,0xbc,0x03], width:16, form:'memory', writePolicy:'preserve-unaffected' },
      { id:'bsr-m32', bytes:[0x0f,0xbd,0x03], width:32, form:'memory', writePolicy:'zero-extend-32' },
      { id:'bsf-m64', bytes:[0x48,0x0f,0xbc,0x03], width:64, form:'memory', writePolicy:'replace' },
    ];
    for (const item of cases) {
      const decoded = one(session, item.bytes);
      const bundle = liftX86MachineEffects({ ...decoded, instructionId:`x86-bit-scan:${item.id}` });
      assert.equal(bundle.completeness, 'exact-with-intrinsic', item.id);
      assert.equal(bundle.unknownEffects, undefined, item.id);
      assert.equal(bundle.metadata.encodingValidated, true, item.id);
      assert.equal(bundle.metadata.sourceForm, item.form, item.id);

      const producer = descriptorOperation(bundle);
      assert.equal(producer.kind, 'intrinsic');
      assert.equal(producer.effectSummary.outputs.length, 1);
      assert.equal(producer.effectSummary.inputs.length, 1);
      assert.deepEqual(producer.undefinedResult, {
        schemaVersion:'machine-effects-undefined-result/v1',
        widthBits:item.width,
        mask:`0x${((1n << BigInt(item.width)) - 1n).toString(16)}`,
        class:'conditional',
        reason:`x86-${decoded.instructionFamily}-source-zero-destination-undefined`,
        condition:{ kind:'source-zero', operandIndex:0 },
      });
      assert.equal(Object.hasOwn(producer.undefinedResult, 'value'), false);
      assert.deepEqual(JSON.parse(serializeMachineEffectBundle(bundle)).operations.find((operation) => operation.undefinedResult)?.undefinedResult,
        producer.undefinedResult);

      const destinationWrite = bundle.operations.find((operation) => operation.kind === 'register-write'
        && operation.register.registerId === 'rax');
      assert.equal(destinationWrite?.metadata.writePolicy, item.writePolicy, item.id);
      const flagWrites = bundle.operations.filter((operation) => operation.kind === 'flag-write');
      assert.deepEqual(flagWrites.map((operation) => operation.flag.flagId).sort(),
        ['RFLAGS.AF','RFLAGS.CF','RFLAGS.OF','RFLAGS.PF','RFLAGS.SF','RFLAGS.ZF']);
      assert.equal(flagWrites.find((operation) => operation.flag.flagId === 'RFLAGS.ZF')?.metadata.definedness, 'defined');
      assert.ok(flagWrites.filter((operation) => operation.flag.flagId !== 'RFLAGS.ZF')
        .every((operation) => operation.metadata.definedness === 'undefined'));
      assert.equal(bundle.possibleFaults.length > 0, item.form === 'memory', item.id);
      assert.equal(bundle.operations.some((operation) => operation.kind === 'memory-read'), item.form === 'memory', item.id);
    }
  } finally {
    session.close();
  }
});

test('a real x86 producer survives Semantic IR compatibility and prevents SCCP publication', async () => {
  const session = await createCapstoneX86Session();
  try {
    const decoded = one(session, [0x0f,0xbc,0xc3]);
    const bundle = liftX86MachineEffects({ ...decoded, instructionId:'x86-bit-scan:e2e-bsf' });
    const expected = descriptorOperation(bundle).undefinedResult;

    const semantic = lowerMachineEffectBundleToSemanticIr(bundle, {
      functionId:'fn-x86-bit-scan-e2e', blockId:'block-x86-bit-scan-e2e', addressWidthBits:64,
    });
    const semanticProducer = semantic.nodes.find((node) => node.attributes?.machineEffects?.undefinedResult != null);
    assert.equal(semanticProducer?.kind, 'intrinsic');
    assert.deepEqual(semanticProducer.attributes.machineEffects.undefinedResult, expected);
    const projected = projectSemanticIrV2ToLegacyV1(semantic);
    const projectedProducer = projected.instructions.find((instruction) => instruction.extra?.undefinedResult != null);
    assert.equal(projectedProducer?.op, OP.CLOBBER);
    assert.deepEqual(projectedProducer.extra.undefinedResult, expected);

    const result = projected.values.find((value) => value.semanticValueId === semanticProducer.outputs[0]);
    assert.ok(result);
    const state = seedAnalysisState(projected);
    const outcome = runPassTransaction(state, { descriptor:SCCP_PASS, run:runSccpPass }, { analysis:state, ir:projected }, {});
    assert.equal(outcome.committed, true);
    const facts = state.get('ranges');
    assert.equal(facts.constants.has(result.id), false);
    assert.equal(isFull(facts.ranges.get(result.id)), true);
    assert.match(facts.overdefinedReasons.get(result.id) ?? '', /architecturally undefined result bits/);
  } finally {
    session.close();
  }
});

test('family labels cannot authorize inconsistent or unsupported BSF/BSR forms', async () => {
  const session = await createCapstoneX86Session();
  try {
    const valid = one(session, [0x0f,0xbc,0xc3]);
    const memory = one(session, [0x0f,0xbc,0x03]);
    const tzcnt = one(session, [0xf3,0x0f,0xbc,0xc3]);
    const address32 = one(session, [0x67,0x0f,0xbc,0x03]);
    const fsMemory = one(session, [0x64,0x0f,0xbc,0x03]);
    const malformed = [
      address32,
      fsMemory,
      cloneDecoded(valid, { rawBytes:Uint8Array.from([0x0f,0xbd,0xc3]) }),
      cloneDecoded(valid, { length:4, size:4, rawBytes:Uint8Array.from([0x0f,0xbc,0xc3,0x90]) }),
      cloneDecoded(valid, { decoderSemanticVersion:'untrusted-decoder/v1' }),
      cloneDecoded(valid, { detail:{ operands:[
        { ...valid.detail.operands[0], access:'read' }, valid.detail.operands[1],
      ] } }),
      cloneDecoded(valid, { detail:{ operands:[
        { type:'memory', widthBits:32, access:'write', memory:{ ...memory.detail.operands[1].memory } },
        valid.detail.operands[1],
      ] } }),
      cloneDecoded(valid, { detail:{ operands:[
        { type:'register', register:'al', widthBits:8, access:'write' },
        { type:'register', register:'bl', widthBits:8, access:'read' },
      ] } }),
      cloneDecoded(tzcnt, { instructionFamily:'bsf' }),
    ];
    for (const [index, candidate] of malformed.entries()) {
      const normalized = createX86DecodedInstruction({ ...candidate, instructionId:`x86-bit-scan:near-miss:${index}` });
      const bundle = liftX86MachineEffects(normalized);
      assert.equal(bundle.completeness, 'partial', `near-miss ${index}`);
      assert.equal(bundle.metadata.encodingValidated, false, `near-miss ${index}`);
      assert.equal(bundle.operations.some((operation) => operation.undefinedResult != null), false, `near-miss ${index}`);
      if (candidate.detail.operands[1]?.type === 'memory') {
        assert.ok(bundle.possibleFaults.some((fault) => fault.kind === 'memory-access-fault'), `near-miss ${index}`);
      }
    }
  } finally {
    session.close();
  }
});

test('raw BSF/BSR bytes must bind every decoded register and memory-address field', async () => {
  const session = await createCapstoneX86Session();
  try {
    const register = one(session, [0x0f,0xbc,0xc3]);
    const memory = one(session, [0x0f,0xbc,0x03]);
    const extended = one(session, [0x45,0x0f,0xbc,0xc1]);
    const sibDisp = one(session, [0x48,0x0f,0xbc,0x44,0x8b,0x7f]);
    const forged = [
      cloneDecoded(register, { detail:{ operands:[
        { ...register.detail.operands[0], registerId:'ecx' }, register.detail.operands[1],
      ] } }),
      cloneDecoded(register, { detail:{ operands:[
        register.detail.operands[0], { ...register.detail.operands[1], registerId:'ecx' },
      ] } }),
      cloneDecoded(memory, { detail:{ operands:[
        memory.detail.operands[0], {
          ...memory.detail.operands[1],
          memory:{ ...memory.detail.operands[1].memory, base:'rax' },
        },
      ] } }),
      cloneDecoded(extended, { detail:{ operands:[
        { ...extended.detail.operands[0], registerId:'eax' }, extended.detail.operands[1],
      ] } }),
      cloneDecoded(extended, { detail:{ operands:[
        extended.detail.operands[0], { ...extended.detail.operands[1], registerId:'ecx' },
      ] } }),
      cloneDecoded(sibDisp, { detail:{ operands:[
        sibDisp.detail.operands[0], {
          ...sibDisp.detail.operands[1],
          memory:{ ...sibDisp.detail.operands[1].memory, base:'rax' },
        },
      ] } }),
      cloneDecoded(sibDisp, {
        rawBytes:Uint8Array.from([0x48,0x0f,0xbc,0x44,0x8b,0x7e]),
      }),
      cloneDecoded(sibDisp, { detail:{ operands:[
        sibDisp.detail.operands[0], {
          ...sibDisp.detail.operands[1],
          memory:{ ...sibDisp.detail.operands[1].memory, index:'rdx' },
        },
      ] } }),
      cloneDecoded(sibDisp, { detail:{ operands:[
        sibDisp.detail.operands[0], {
          ...sibDisp.detail.operands[1],
          memory:{ ...sibDisp.detail.operands[1].memory, scale:2 },
        },
      ] } }),
      cloneDecoded(sibDisp, { detail:{ operands:[
        sibDisp.detail.operands[0], {
          ...sibDisp.detail.operands[1],
          memory:{ ...sibDisp.detail.operands[1].memory, displacement:126n },
        },
      ] } }),
    ];

    for (const [index, candidate] of forged.entries()) {
      const normalized = createX86DecodedInstruction({ ...candidate, instructionId:`x86-bit-scan:raw-binding:${index}` });
      const bundle = liftX86MachineEffects(normalized);
      assert.equal(bundle.completeness, 'partial', `forged decoded operand ${index}`);
      assert.equal(bundle.metadata.encodingValidated, false, `forged decoded operand ${index}`);
      assert.equal(bundle.operations.some((operation) => operation.undefinedResult != null), false,
        `forged decoded operand ${index}`);
    }

    for (const [id, decoded] of [['rex-extended', extended], ['sib-displacement', sibDisp]]) {
      const bundle = liftX86MachineEffects({ ...decoded, instructionId:`x86-bit-scan:${id}` });
      assert.equal(bundle.completeness, 'exact-with-intrinsic', id);
      assert.equal(bundle.metadata.encodingValidated, true, id);
      descriptorOperation(bundle);
    }
  } finally {
    session.close();
  }
});
