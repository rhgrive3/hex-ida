import assert from 'node:assert/strict';

import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { liftX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import { createCapstoneX86Session } from '../phase5/helpers/capstone-session.mjs';
import { X86_LONG64_CONTROL_ALIAS_CASES, x86Long64ControlDenominatorIdentity, x86Long64ControlEncodingCases } from '../../tools/validation/machine-effects/x86-long64-control-denominator.mjs';

function ops(bundle, kind) { return bundle.operations.filter((operation) => operation.kind === kind); }
function regReads(bundle) { return ops(bundle,'register-read').map((operation) => operation.register.registerId); }
function regWrites(bundle) { return ops(bundle,'register-write').map((operation) => operation.register.registerId); }
function flagReads(bundle) { return ops(bundle,'flag-read').map((operation) => operation.flag.flagId.replace('RFLAGS.','')); }

const identity = x86Long64ControlDenominatorIdentity();
assert.equal(identity.encodingCaseCount, 63);
assert.equal(identity.aliasCaseCount, 14);
assert.equal(identity.selfOracle, false);

const session = await createCapstoneX86Session();
let count = 0;
try {
  for (const item of x86Long64ControlEncodingCases()) {
    const decoded = session.decode(item.bytes, 0x400000n + BigInt(count * 0x20));
    assert.equal(decoded.length, 1, `valid control encoding rejected: ${item.id}`);
    const raw = decoded[0];
    assert.equal(raw.length, item.bytes.length, `decoder did not consume exact bytes: ${item.id}`);
    assert.equal(raw.instructionFamily, item.expected.family, `${item.id}:family`);
    if (item.expected.addressSizeBits != null) assert.equal(raw.detail.addressSizeBits, item.expected.addressSizeBits, `${item.id}:address-size`);
    if (item.expected.prefix != null) assert.ok([...raw.detail.prefixes.legacy].includes(item.expected.prefix), `${item.id}:prefix`);
    if (item.expected.rex) assert.ok(raw.detail.prefixes.rex != null, `${item.id}:rex`);
    const instruction = createX86DecodedInstruction({ ...raw, instructionId:`x86-control-denominator:${item.id}` });
    const bundle = liftX86MachineEffects(instruction);
    assert.ok(bundle, `control ownership escaped: ${item.id}`);
    assert.ok(['exact','exact-with-intrinsic'].includes(bundle.completeness), `${item.id}:${bundle.unknownEffects?.reason}`);
    assert.equal(bundle.metadata.family, 'control', item.id);
    assert.equal(bundle.metadata.featureProfileId, 'x86_64:long-64', item.id);
    assert.equal(bundle.controlEffect.kind, item.expected.controlKind, item.id);
    if (item.expected.direct != null) assert.equal(bundle.metadata.direct, item.expected.direct, item.id);
    if (item.expected.memoryReads != null) assert.equal(ops(bundle,'memory-read').length, item.expected.memoryReads, item.id);
    if (item.expected.memoryWrites != null) assert.equal(ops(bundle,'memory-write').length, item.expected.memoryWrites, item.id);
    if (item.expected.rspDelta != null) assert.equal(Number(bundle.metadata.stackDelta), item.expected.rspDelta, item.id);
    if (item.expected.immediateAdjustment != null) assert.equal(Number(bundle.metadata.immediateAdjustment), item.expected.immediateAdjustment, item.id);
    if (item.expected.registerReads) for (const register of item.expected.registerReads) assert.ok(regReads(bundle).includes(register), `${item.id}:${register}-read`);
    if (item.expected.countRegister) {
      assert.equal(bundle.metadata.countRegister, item.expected.countRegister, item.id);
      assert.ok(regReads(bundle).includes('rcx'), `${item.id}:count-read`);
      if (item.expected.countWrite) assert.ok(regWrites(bundle).includes('rcx'), `${item.id}:count-write`);
    }
    assert.deepEqual(new Set(flagReads(bundle)), new Set(item.expected.flagReads ?? []), `${item.id}:flags`);
    if (item.expected.targetFault) assert.ok(bundle.possibleFaults.some((fault) => fault.kind === 'control-transfer-fault' && fault.detail.vector === '#GP(0)'), `${item.id}:target-fault`);
    if (item.expected.faultKind) assert.ok(bundle.possibleFaults.some((fault) => fault.kind === item.expected.faultKind), `${item.id}:${item.expected.faultKind}`);
    if (bundle.controlEffect.kind === 'conditional-branch' || bundle.controlEffect.kind === 'call') {
      assert.equal(bundle.controlEffect.fallthrough.value, String(BigInt(instruction.address) + BigInt(instruction.length)), `${item.id}:fallthrough`);
    }
    count++;
  }
} finally { session.close(); }
assert.equal(count, identity.encodingCaseCount);

// Decoder aliases are an independent semantic dimension: the bytes have a
// canonical decoder spelling, while structured aliases must map to the same
// architectural condition without changing the effect bundle.
for (const item of X86_LONG64_CONTROL_ALIAS_CASES) {
  const instruction = createX86DecodedInstruction({
    instructionId:`x86-control-alias:${item.alias}`,
    instructionCode:1,
    instructionFamily:item.alias,
    address:0x4800n,
    length:item.bytes.length,
    rawBytes:item.bytes,
    mode:'long-64',
    detailAvailable:true,
    detailStatus:'complete',
    detail:{
      operandCount:1,
      operands:[{type:'immediate',value:0x4900n,access:'read'}],
      implicitReads:[], implicitWrites:[], conditionCode:item.conditionCode, addressSizeBits:64,
      prefixes:{legacy:[],rex:null,vector:null},
    },
  });
  const bundle = liftX86MachineEffects(instruction);
  assert.ok(bundle, `${item.alias}:owned`);
  assert.ok(['exact','exact-with-intrinsic'].includes(bundle.completeness), `${item.alias}:exact`);
  assert.equal(bundle.controlEffect.kind, 'conditional-branch', item.alias);
  assert.deepEqual(new Set(flagReads(bundle)), new Set(item.flagReads), `${item.alias}:flags`);
}

// Truncated variable-length control encodings never reach exact lifting because
// the deployed decoder cannot produce a complete structured instruction.
const truncatedSession = await createCapstoneX86Session();
try {
  assert.equal(truncatedSession.decode(Uint8Array.from([0xe8,0,0]), 0x4a00n).length, 0, 'truncated CALL');
  assert.equal(truncatedSession.decode(Uint8Array.from([0x0f,0x84,0]), 0x4a00n).length, 0, 'truncated near Jcc');
  assert.equal(truncatedSession.decode(Uint8Array.from([0xc2,0]), 0x4a00n).length, 0, 'truncated RET imm16');
} finally { truncatedSession.close(); }

function malformed(raw) {
  return createX86DecodedInstruction({
    instructionId:`x86-control-negative:${Math.random()}`,
    instructionCode:1,
    instructionFamily:raw.family ?? 'jmp',
    address:0x5000n,
    length:raw.bytes?.length ?? 2,
    rawBytes:Uint8Array.from(raw.bytes ?? [0xeb,0]),
    mode:raw.mode ?? 'long-64',
    detailAvailable:true,
    detailStatus:'complete',
    featureProfileId:raw.featureProfileId,
    featureState:raw.featureState,
    detail:{
      operandCount:(raw.operands ?? []).length,
      operands:raw.operands ?? [],
      implicitReads:[], implicitWrites:[], conditionCode:raw.conditionCode ?? null,
      addressSizeBits:raw.addressSizeBits ?? 64,
      prefixes:{ legacy:Uint8Array.from(raw.prefixes ?? []), rex:null, vector:raw.vector ?? null },
    },
  });
}
const partialCases = [
  malformed({ family:'jmp', operands:[] }),
  malformed({ family:'je', operands:[{type:'immediate',value:0x6000n,access:'read'},{type:'immediate',value:0x6010n,access:'read'}], conditionCode:'e', bytes:[0x74,0] }),
  malformed({ family:'nop', operands:[{type:'register',register:'rax',access:'read'}], bytes:[0x90] }),
  malformed({ family:'ud2', operands:[{type:'register',register:'rax',access:'read'}], bytes:[0x0f,0x0b] }),
  malformed({ family:'jmp', operands:[{type:'register',register:'eax',access:'read'}] }),
  malformed({ family:'call', operands:[{type:'memory',widthBits:32,access:'read',memory:{base:'rax',scale:1,displacement:0n,addressSizeBits:64}}], bytes:[0xff,0x10] }),
  malformed({ family:'ret', operands:[{type:'immediate',value:0x10000n,access:'read'}], bytes:[0xc2,0,0] }),
  malformed({ family:'jcxz', operands:[{type:'immediate',value:0x6000n,access:'read'}], bytes:[0xe3,0] }),
  malformed({ family:'jrcxz', operands:[{type:'immediate',value:0x6000n,access:'read'}], prefixes:[0x67], addressSizeBits:32, bytes:[0x67,0xe3,0] }),
  malformed({ family:'je', operands:[{type:'immediate',value:0x6000n,access:'read'}], conditionCode:'e', prefixes:[0xf0], bytes:[0xf0,0x74,0] }),
  malformed({ family:'je', operands:[{type:'immediate',value:0x6000n,access:'read'}], conditionCode:'e', prefixes:[0xf2,0xf3], bytes:[0xf2,0xf3,0x74,0] }),
  malformed({ family:'je', operands:[{type:'immediate',value:0x6000n,access:'read'}], conditionCode:'e', addressSizeBits:16, bytes:[0x74,0] }),
  malformed({ family:'je', operands:[{type:'immediate',value:0x6000n,access:'read'}], conditionCode:'e', prefixes:[0x67], addressSizeBits:64, bytes:[0x67,0x74,0] }),
  malformed({ family:'je', operands:[{type:'immediate',value:0x6000n,access:'read'}], conditionCode:'e', vector:{kind:'vex2',bytes:[0xc5,0xf8]} }),
  createX86DecodedInstruction({ instructionId:'x86-control-negative:rex', instructionCode:1, instructionFamily:'je', address:0x5000n, length:2, rawBytes:Uint8Array.from([0x74,0]), mode:'long-64', detailAvailable:true, detailStatus:'complete', detail:{ operandCount:1, operands:[{type:'immediate',value:0x6000n,access:'read'}], implicitReads:[], implicitWrites:[], conditionCode:'e', addressSizeBits:64, prefixes:{legacy:[],rex:0xff,vector:null} } }),
  malformed({ family:'call', operands:[{type:'immediate',value:0x6000n,access:'read'}], featureState:{cet:{shadowStackEnabled:true}} }),
  malformed({ family:'ret', operands:[], featureState:{mpx:{enabled:true,bndPreserve:false}} }),
  malformed({ family:'jmp', operands:[{type:'immediate',value:0x6000n,access:'read'}], featureProfileId:'x86_64:long-64+cet-shadow-stack' }),
];
for (const instruction of partialCases) {
  const bundle = liftX86MachineEffects(instruction);
  assert.ok(bundle, 'negative control form must remain owned');
  assert.equal(bundle.completeness, 'partial', bundle.unknownEffects?.reason);
  assert.equal(bundle.controlEffect.kind, 'unknown', bundle.unknownEffects?.reason);
}

assert.throws(() => malformed({ mode:'legacy-32', family:'jmp', operands:[{type:'immediate',value:0x6000n,access:'read'}] }), /mode-unsupported/);
assert.throws(() => createX86DecodedInstruction({
  instructionId:'x86-control-negative:operand-count', instructionCode:1, instructionFamily:'jmp',
  address:0x5000n, length:2, rawBytes:Uint8Array.from([0xeb,0]), mode:'long-64', detailAvailable:true, detailStatus:'complete',
  detail:{ operandCount:2, operands:[{type:'immediate',value:0x6000n,access:'read'}], implicitReads:[], implicitWrites:[], addressSizeBits:64, prefixes:{legacy:[],rex:null,vector:null} },
}), /operand-count-mismatch/);
console.log(`x86 long-64 control denominator (${count} finite discriminator cases): PASS`);
