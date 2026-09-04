import assert from 'node:assert/strict';

import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { liftX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import { createCapstoneX86Session } from '../phase5/helpers/capstone-session.mjs';

function valueWidth(value) {
  return value?.kind === 'temporary' ? Number(value.valueType?.widthBits || 0) : Number(value?.widthBits || 0);
}
function temporaryId(value) { return value?.temporaryId ?? value?.id ?? null; }
function producingOperation(bundle, value) {
  const id = temporaryId(value);
  if (!id) return null;
  return bundle.operations.find((operation) => {
    if (temporaryId(operation.value) === id) return true;
    return (operation.outputs || []).some((output) => temporaryId(output) === id);
  }) ?? null;
}
function onlyIntrinsic(bundle) {
  const intrinsics = bundle.operations.filter((operation) => operation.kind === 'intrinsic');
  assert.equal(intrinsics.length,1);
  return intrinsics[0];
}

const session = await createCapstoneX86Session();
let sequence = 0;
function lift(bytes, label) {
  const decoded = session.decode(Uint8Array.from(bytes),0x710000n + BigInt(sequence++) * 0x20n);
  assert.equal(decoded.length,1,`${label}: decode count`);
  const instruction = createX86DecodedInstruction({ ...decoded[0], instructionId:`issue-4189:${label}` });
  const bundle = liftX86MachineEffects(instruction);
  assert.ok(bundle,`${label}: effects missing`);
  assert.equal(bundle.completeness,'exact-with-intrinsic',`${label}: completeness`);
  return bundle;
}

try {
  // Minimal counterexample: address-size=32 REP MOVSB.  The opaque repeated
  // summary must depend on ECX/ESI/EDI values, never their upper 32 bits.
  const addr32 = lift([0x67,0xf3,0xa4],'addr32-rep-movsb');
  const addr32Intrinsic = onlyIntrinsic(addr32);
  assert.equal(addr32Intrinsic.metadata.addressSizeBits,32);
  assert.deepEqual(addr32Intrinsic.effectSummary.inputs.slice(0,4).map(valueWidth),[32,1,32,32],
    'addr32 intrinsic inputs must be ECX, DF, ESI, EDI widths');
  assert.deepEqual(addr32Intrinsic.effectSummary.outputs.slice(0,3).map(valueWidth),[32,32,32],
    'addr32 count/pointer outputs must remain modulo 2^32');
  assert.deepEqual(addr32Intrinsic.metadata.outputRoles.slice(0,3),[
    { role:'count', registerName:'rcx', widthBits:32 },
    { role:'source-pointer', registerName:'rsi', widthBits:32 },
    { role:'destination-pointer', registerName:'rdi', widthBits:32 },
  ]);
  assert.equal(addr32Intrinsic.metadata.count.view,'ecx');
  assert.equal(addr32Intrinsic.metadata.count.widthBits,32);
  assert.equal(addr32Intrinsic.metadata.direction.arithmeticWidthBits,32);

  const addressInputs = [
    ['count','rcx','ecx',addr32Intrinsic.effectSummary.inputs[0]],
    ['source','rsi','esi',addr32Intrinsic.effectSummary.inputs[2]],
    ['destination','rdi','edi',addr32Intrinsic.effectSummary.inputs[3]],
  ];
  for (const [role,physical,view,input] of addressInputs) {
    const producer = producingOperation(addr32,input);
    assert.ok(producer,`${role}: missing view producer`);
    assert.equal(producer.kind,'value',`${role}: producer kind`);
    assert.equal(producer.opcode,'extract',`${role}: producer opcode`);
    assert.equal(producer.metadata.semantic,'x86-repeated-string-address-view',`${role}: view semantic`);
    assert.equal(producer.metadata.physicalId,physical,`${role}: physical authority`);
    assert.equal(producer.metadata.view,view,`${role}: architectural view`);
    assert.equal(valueWidth(producer.outputs[0]),32,`${role}: view width`);
  }

  const entryPredicate = addr32.operations.find((operation) =>
    operation.kind === 'value' && operation.metadata?.semantic === 'x86-repeated-string-entry-count-nonzero');
  assert.ok(entryPredicate,'addr32 entry ECX predicate missing');
  assert.equal(entryPredicate.opcode,'ne');
  assert.equal(valueWidth(entryPredicate.inputs[0]),32);
  assert.equal(valueWidth(entryPredicate.inputs[1]),32);
  assert.equal(temporaryId(entryPredicate.inputs[0]),temporaryId(addr32Intrinsic.effectSummary.inputs[0]),
    'entry predicate must use the exact ECX summary input');
  assert.equal(valueWidth(entryPredicate.outputs[0]),1);

  // An addr32 architectural subregister write zero-extends only after at least
  // one completed iteration.  ECX==0 therefore selects the original full
  // physical register, preserving upper RCX/RSI/RDI bits exactly.
  const commits = addr32.operations.filter((operation) =>
    operation.kind === 'value' && operation.metadata?.semantic === 'x86-repeated-string-address-state-commit');
  assert.equal(commits.length,3,'addr32 MOVSB must conditionally commit count/source/destination');
  const expectedPhysical = new Map([['count','rcx'],['source','rsi'],['destination','rdi']]);
  for (const commit of commits) {
    const role = commit.metadata.role, physical = expectedPhysical.get(role);
    assert.ok(physical,`unexpected commit role ${role}`);
    assert.equal(commit.opcode,'select');
    assert.equal(commit.metadata.condition,'entry ECX != 0');
    assert.equal(temporaryId(commit.inputs[0]),temporaryId(entryPredicate.outputs[0]),`${role}: commit condition`);
    assert.equal(valueWidth(commit.inputs[1]),64,`${role}: nonzero zero-extended state width`);
    assert.equal(valueWidth(commit.inputs[2]),64,`${role}: zero-count preserved state width`);
    const zext = producingOperation(addr32,commit.inputs[1]);
    assert.ok(zext,`${role}: zero-extension producer missing`);
    assert.equal(zext.kind,'value');
    assert.equal(zext.opcode,'zext');
    assert.equal(zext.metadata.fromBits,32);
    assert.equal(zext.metadata.toBits,64);
    const preserved = producingOperation(addr32,commit.inputs[2]);
    assert.ok(preserved,`${role}: preserved physical read missing`);
    assert.equal(preserved.kind,'register-read');
    assert.equal(preserved.register.registerId,physical,`${role}: preserved physical register`);
  }
  const physicalWrites = new Map(addr32.operations
    .filter((operation) => operation.kind === 'register-write' && ['rcx','rsi','rdi'].includes(operation.register.registerId))
    .map((operation) => [operation.register.registerId,operation]));
  assert.equal(physicalWrites.size,3);
  for (const [role,physical] of expectedPhysical) {
    const write = physicalWrites.get(physical);
    assert.ok(write,`${role}: physical write missing`);
    const producer = producingOperation(addr32,write.value);
    assert.equal(producer?.metadata?.semantic,'x86-repeated-string-address-state-commit',`${role}: write must be conditional commit`);
    assert.equal(producer?.metadata?.role,role);
  }
  assert.equal(addr32.operations.filter((operation) => operation.kind === 'memory-read' || operation.kind === 'memory-write').length,0,
    'repeated data-memory behavior must remain summarized rather than unrolled');
  assert.equal(addr32Intrinsic.metadata.memory.zeroCount,'no memory access');
  assert.match(addr32Intrinsic.metadata.count.zeroCount,/preserve full RCX/);
  assert.match(addr32Intrinsic.metadata.direction.zeroCount,/full physical register values/);

  // REPE/REPNE use the same ECX count authority in addr32 mode; the initial ZF
  // still does not gate the first iteration.
  for (const [label,bytes,repeatKind] of [
    ['addr32-repe-cmpsb',[0x67,0xf3,0xa6],'repe'],
    ['addr32-repne-cmpsb',[0x67,0xf2,0xa6],'repne'],
  ]) {
    const bundle = lift(bytes,label), intrinsic = onlyIntrinsic(bundle);
    assert.equal(intrinsic.metadata.repeatKind,repeatKind);
    assert.equal(valueWidth(intrinsic.effectSummary.inputs[0]),32,`${label}: ECX input width`);
    assert.equal(valueWidth(intrinsic.effectSummary.outputs[0]),32,`${label}: ECX output width`);
    const producer = producingOperation(bundle,intrinsic.effectSummary.inputs[0]);
    assert.equal(producer?.metadata?.view,'ecx',`${label}: ECX value authority`);
    assert.equal(intrinsic.metadata.termination.initialConditionFlagUsedBeforeFirstIteration,false);
  }

  // Address-size=64 stays on full physical RCX/RSI/RDI and does not need the
  // addr32 preservation merge.
  const addr64 = lift([0xf3,0xa4],'addr64-rep-movsb');
  const addr64Intrinsic = onlyIntrinsic(addr64);
  assert.equal(addr64Intrinsic.metadata.addressSizeBits,64);
  assert.deepEqual(addr64Intrinsic.effectSummary.inputs.slice(0,4).map(valueWidth),[64,1,64,64]);
  assert.deepEqual(addr64Intrinsic.effectSummary.outputs.slice(0,3).map(valueWidth),[64,64,64]);
  assert.deepEqual(addr64Intrinsic.metadata.outputRoles.slice(0,3),[
    { role:'count', registerName:'rcx', widthBits:64 },
    { role:'source-pointer', registerName:'rsi', widthBits:64 },
    { role:'destination-pointer', registerName:'rdi', widthBits:64 },
  ]);
  assert.equal(addr64.operations.some((operation) => operation.metadata?.semantic === 'x86-repeated-string-entry-count-nonzero'),false);
  assert.equal(addr64.operations.some((operation) => operation.metadata?.semantic === 'x86-repeated-string-address-state-commit'),false);
} finally {
  session.close();
}

console.log('issue-4189 x86 addr32 REP state regression: PASS');
