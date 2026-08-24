import assert from 'node:assert/strict';
import test from 'node:test';

import { liftX86IntegerEffects } from '../../js/targets/architecture/x86_64/effects/integer.js';
import { liftX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import { x86DivisionFault, x86DivisionRules, x86ShiftCountMask } from '../../js/targets/architecture/x86_64/effects/scalar.js';
import { createCapstoneX86Session } from '../phase5/helpers/capstone-session.mjs';
import {
  validateX86Long64IntegerDecodedCase,
  validateX86Long64IntegerDenominator,
  x86Long64IntegerEncodingCases,
} from '../../tools/validation/machine-effects/x86-long64-integer-denominator.mjs';

function one(session, bytes, address = 0x1000n) {
  const decoded = session.decode(Uint8Array.from(bytes), address);
  assert.equal(decoded.length, 1, `expected exactly one instruction for ${bytes.map((v) => v.toString(16).padStart(2, '0')).join(' ')}`);
  assert.equal(decoded[0].length, bytes.length, 'decoder must consume the complete witness encoding');
  return decoded[0];
}
function effect(session, bytes, id) {
  return liftX86MachineEffects({ ...one(session, bytes), instructionId:id });
}
function writes(bundle, registerId = null) {
  return bundle.operations.filter((operation) => operation.kind === 'register-write'
    && (registerId == null || operation.register?.registerId === registerId));
}
function flagWrites(bundle, flagId = null) {
  return bundle.operations.filter((operation) => operation.kind === 'flag-write'
    && (flagId == null || operation.flag?.flagId === `RFLAGS.${flagId}`));
}
function partialReason(bundle) { return bundle?.unknownEffects?.reason ?? ''; }
function intrinsics(bundle, intrinsicId = null) {
  return bundle.operations.filter((operation) => operation.kind === 'intrinsic'
    && (intrinsicId == null || operation.intrinsicId === intrinsicId));
}
function cloneDecoded(decoded, detailPatch = {}) {
  return {
    ...decoded,
    rawBytes:Uint8Array.from(decoded.rawBytes),
    detail:{
      ...decoded.detail,
      prefixes:{ ...decoded.detail.prefixes, legacy:Uint8Array.from(decoded.detail.prefixes.legacy || []) },
      operands:decoded.detail.operands.map((operand) => ({ ...operand })),
      implicitReads:[...decoded.detail.implicitReads],
      implicitWrites:[...decoded.detail.implicitWrites],
      ...detailPatch,
    },
  };
}

const identity = validateX86Long64IntegerDenominator();
assert.equal(identity.valid, true);
assert.equal(identity.denominatorId, 'x86_64:long-64:effect-family:integer:v1');
assert.equal(identity.encodingCaseCount, 57294);
assert.equal(identity.integerOwnedCaseCount, 56666);
assert.equal(identity.memoryDelegationCaseCount, 628);
assert.deepEqual(identity.operandWidths, [8,16,32,64]);

test('finite long-64 integer denominator decodes completely and every integer-owned case lifts non-partially', async () => {
  const session = await createCapstoneX86Session();
  let integerOwned = 0;
  let memoryDelegated = 0;
  let count = 0;
  try {
    for (const candidate of x86Long64IntegerEncodingCases()) {
      const decoded = one(session, [...candidate.bytes], 0x100000n + BigInt(count * 16));
      assert.equal(validateX86Long64IntegerDecodedCase(candidate, decoded), true, candidate.id);

      if (candidate.owner === 'memory') {
        // This component records the canonical boundary rather than duplicating
        // memory semantics. The direct integer lifter must remain a deferral.
        const direct = liftX86IntegerEffects({ ...decoded, instructionId:`x86-int-den:memory:${candidate.id}` });
        assert.ok(direct, `integer boundary missing for ${candidate.id}`);
        assert.equal(direct.completeness, 'partial', `memory form was accidentally implemented in integer lane: ${candidate.id}`);
        assert.match(partialReason(direct), /memory-form-deferred/, candidate.id);
        memoryDelegated++;
      } else {
        const bundle = liftX86MachineEffects({ ...decoded, instructionId:`x86-int-den:${candidate.id}` });
        assert.ok(bundle, `integer effect ownership escaped: ${candidate.id}`);
        assert.notEqual(bundle.completeness, 'partial', `${candidate.id}:${partialReason(bundle) || 'partial'}`);
        assert.ok(['integer','flags'].includes(bundle.metadata?.family), `unexpected effect owner ${bundle.metadata?.family}: ${candidate.id}`);
        integerOwned++;
      }
      count++;
    }
  } finally {
    session.close();
  }
  assert.equal(count, identity.encodingCaseCount);
  assert.equal(integerOwned, identity.integerOwnedCaseCount);
  assert.equal(memoryDelegated, identity.memoryDelegationCaseCount);
});

test('MOV extension operand-size states preserve partial-register and 32-bit write semantics', async () => {
  const session = await createCapstoneX86Session();
  try {
    for (const [bytes, family, fromBits, toBits, physical, policy] of [
      [[0x66,0x0f,0xb7,0xc3], 'movzx', 16,16,'rax','preserve-unaffected'],
      [[0x66,0x0f,0xbf,0xc3], 'movsx', 16,16,'rax','preserve-unaffected'],
      [[0x66,0x63,0xc3], 'movsxd', 32,16,'rax','preserve-unaffected'],
      [[0x63,0xc3], 'movsxd', 32,32,'rax','zero-extend-32'],
      [[0x48,0x63,0xc3], 'movsxd', 32,64,'rax','replace'],
    ]) {
      const decoded = one(session, bytes);
      assert.equal(decoded.instructionFamily, family);
      const bundle = liftX86MachineEffects({ ...decoded, instructionId:`extend:${family}:${toBits}` });
      assert.notEqual(bundle.completeness, 'partial');
      assert.equal(bundle.metadata.fromBits, fromBits);
      assert.equal(bundle.metadata.toBits, toBits);
      const [write] = writes(bundle, physical);
      assert.ok(write, `${family} ${toBits} physical write`);
      assert.equal(write.metadata.writePolicy, policy);
    }

    const highByte = effect(session,[0x88,0xdc],'partial:ah'); // mov ah, bl
    const [ahWrite] = writes(highByte,'rax');
    assert.equal(ahWrite.metadata.writePolicy,'preserve-unaffected');
    const insert = highByte.operations.find((operation) => operation.kind === 'value' && operation.opcode === 'insert');
    assert.equal(insert?.metadata?.lsb,8);
    assert.equal(insert?.metadata?.widthBits,8);

    const rexLowByte = effect(session,[0x40,0x88,0xdc],'partial:spl'); // mov spl, bl
    const [splWrite] = writes(rexLowByte,'rsp');
    assert.equal(splWrite.metadata.writePolicy,'preserve-unaffected');
    const splInsert = rexLowByte.operations.find((operation) => operation.kind === 'value' && operation.opcode === 'insert');
    assert.equal(splInsert?.metadata?.lsb,0);
    assert.equal(splInsert?.metadata?.widthBits,8);
  } finally {
    session.close();
  }
});

test('implicit multiply/divide/sign-extension, flags, count masks and divide faults remain architectural', async () => {
  const session = await createCapstoneX86Session();
  try {
    const mul = effect(session,[0x48,0xf7,0xe3],'implicit:mul'); // mul rbx
    assert.equal(mul.metadata.form,'one-operand-implicit');
    assert.equal(writes(mul,'rax').length,1);
    assert.equal(writes(mul,'rdx').length,1);
    assert.equal(flagWrites(mul,'CF').length,1);
    assert.equal(flagWrites(mul,'OF').length,1);

    for (const [bytes,family,signed] of [
      [[0x48,0xf7,0xf3],'div',false],
      [[0x48,0xf7,0xfb],'idiv',true],
    ]) {
      const bundle = effect(session,bytes,`implicit:${family}`);
      assert.equal(bundle.metadata.form,'implicit-dividend-pair');
      assert.equal(bundle.metadata.signed,signed);
      assert.equal(writes(bundle,'rax').length,1);
      assert.equal(writes(bundle,'rdx').length,1);
      assert.equal(bundle.possibleFaults.length,1);
      const [fault] = bundle.possibleFaults;
      assert.equal(fault.kind,'divide-error');
      assert.equal(fault.detail.vector,'#DE');
      assert.deepEqual(fault.condition.anyOf.map((condition) => condition.kind), ['divisor-zero','quotient-out-of-range']);
      assert.equal(fault.condition.anyOf[1].signed,signed);
      assert.equal(flagWrites(bundle).length,6);
      assert.ok(flagWrites(bundle).every((operation) => operation.metadata.definedness === 'undefined'));
    }

    const cqo = effect(session,[0x48,0x99],'implicit:cqo');
    assert.equal(cqo.metadata.operation,'cqo');
    assert.equal(cqo.metadata.signExtension,true);
    assert.equal(writes(cqo,'rdx').length,1);
    assert.equal(flagWrites(cqo).length,0);

    assert.equal(x86ShiftCountMask(8),0x1fn);
    assert.equal(x86ShiftCountMask(32),0x1fn);
    assert.equal(x86ShiftCountMask(64),0x3fn);
    const shl64 = effect(session,[0x48,0xc1,0xe0,0x40],'count-mask:shl64'); // 64 & 63 = 0
    assert.equal(shl64.metadata.effectiveCount,0);
    assert.equal(shl64.metadata.destinationWrite,false);
    assert.equal(shl64.metadata.flagsPreserved,true);
    assert.equal(writes(shl64).length,0);
    assert.equal(flagWrites(shl64).length,0);

    const rol8 = effect(session,[0xc0,0xc0,0x09],'count-mask:rol8'); // (9 & 31) % 8 = 1
    assert.equal(rol8.metadata.effectiveCount,1);
    assert.equal(intrinsics(rol8,'x86.integer.rol').length,1);

    assert.match(x86DivisionRules(false).fault,/unsigned quotient/);
    assert.match(x86DivisionRules(true).fault,/signed quotient/);
    const syntheticFault = x86DivisionFault('idiv',{kind:'divisor'},{kind:'dividend'},32);
    assert.equal(syntheticFault.condition.anyOf[1].signed,true);
    assert.equal(syntheticFault.condition.anyOf[1].quotientWidthBits,32);
  } finally {
    session.close();
  }
});

test('denominator and production fail closed for malformed or unsupported integer evidence', async () => {
  const session = await createCapstoneX86Session();
  try {
    const mulCandidate = [...x86Long64IntegerEncodingCases()].find((candidate) => candidate.family === 'mul' && candidate.owner === 'integer' && candidate.operandWidthBits === 64);
    assert.ok(mulCandidate);
    const mulDecoded = one(session,[...mulCandidate.bytes]);

    const missingImplicit = cloneDecoded(mulDecoded,{ implicitReads:[] });
    assert.throws(() => validateX86Long64IntegerDecodedCase(mulCandidate,missingImplicit),/missing-implicit-read/);

    const truncated = cloneDecoded(mulDecoded,{ implicitReads:undefined });
    assert.throws(() => validateX86Long64IntegerDecodedCase(mulCandidate,truncated),/truncated-implicit-detail/);

    const malformedPrefix = cloneDecoded(mulDecoded,{ prefixes:{ ...mulDecoded.detail.prefixes, legacy:Uint8Array.of(0xf0) } });
    assert.throws(() => validateX86Long64IntegerDecodedCase(mulCandidate,malformedPrefix),/malformed-prefix/);

    const invalidWidthCandidate = Object.freeze({ ...mulCandidate, operandWidthBits:24 });
    assert.throws(() => validateX86Long64IntegerDecodedCase(invalidWidthCandidate,mulDecoded),/width-drift/);

    const movzx = one(session,[0x0f,0xb6,0xc3]);
    const invalidForm = cloneDecoded(movzx,{
      operands:[movzx.detail.operands[0],{ ...movzx.detail.operands[1], type:'immediate', value:1n }],
    });
    const invalidFormEffects = liftX86IntegerEffects({ ...invalidForm, instructionId:'negative:movzx-form' });
    assert.equal(invalidFormEffects.completeness,'partial');
    assert.match(partialReason(invalidFormEffects),/movzx-operand-shape-unmodelled/);

    const invalidWidth = cloneDecoded(movzx,{
      operands:[{ ...movzx.detail.operands[0], widthBits:8 },{ ...movzx.detail.operands[1], widthBits:8 }],
    });
    assert.throws(
      () => liftX86IntegerEffects({ ...invalidWidth, instructionId:'negative:movzx-width' }),
      /register-width-mismatch/,
    );

    assert.equal(liftX86IntegerEffects({ instructionFamily:'unsupported-integer-opcode' }),null);
    assert.equal(session.decode(Uint8Array.of(0xf0,0x48,0x01,0xd8),0x2000n).length,0,'LOCK register ADD is malformed and must not enter effects');
  } finally {
    session.close();
  }
});
