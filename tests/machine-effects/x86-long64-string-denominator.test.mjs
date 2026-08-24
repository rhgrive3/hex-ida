import assert from 'node:assert/strict';

import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { liftX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import { liftX86StringEffects } from '../../js/targets/architecture/x86_64/effects/string.js';
import { createCapstoneX86Session } from '../phase5/helpers/capstone-session.mjs';
import {
  validateX86Long64RepeatedStringSummary,
  x86Long64StringDenominatorCases,
  x86Long64StringDenominatorIdentity,
} from '../../tools/validation/machine-effects/x86-long64-string-denominator.mjs';

const identity = x86Long64StringDenominatorIdentity();
assert.equal(identity.denominatorId, 'x86_64:long-64:effect-family:string:v1');
assert.equal(identity.semanticCaseCount, 672);
assert.deepEqual(identity.negativeContracts, [
  'malformed-prefix',
  'missing-implicit-state',
  'ambiguous-movsd-cmpsd-shape',
  'invalid-address-size',
  'unsupported-form',
  'rep-semantic-truncation',
]);

const session = await createCapstoneX86Session();
let decodedCaseCount = 0;
let repeatedCaseCount = 0;

function operations(bundle, kind) { return bundle.operations.filter((operation) => operation.kind === kind); }
function expectedReadSpaces(item) {
  const spaces = [];
  if (item.sourceBehavior.present) spaces.push(item.sourceBehavior.space);
  if (item.operation === 'cmps' || item.operation === 'scas') spaces.push('memory');
  return [...new Set(spaces)].sort();
}
function expectedWriteSpaces(item) { return item.operation === 'movs' || item.operation === 'stos' ? ['memory'] : []; }
function assertMemoryScope(scope, spaces, message) {
  if (spaces.length === 0) { assert.equal(scope.scope, 'none', message); return; }
  assert.equal(scope.scope, 'all', message);
  assert.deepEqual(scope.spaces, spaces, message);
  assert.equal(scope.detail.kind, 'strided-runtime-count', message);
  assert.equal(scope.detail.zeroCount, 'no memory access', message);
}
function assertSingle(item, instruction, bundle) {
  assert.ok(bundle.completeness === 'exact' || bundle.completeness === 'exact-with-intrinsic', `single case not exact: ${item.id}:${bundle.completeness}`);
  assert.equal(bundle.unknownEffects, undefined, `single case has unknown effects: ${item.id}`);
  assert.equal(bundle.metadata.operation, item.operation, `single operation: ${item.id}`);
  assert.equal(bundle.metadata.elementWidthBits, item.elementWidthBits, `single width: ${item.id}`);
  assert.equal(bundle.metadata.addressSizeBits, item.addressSizeBits, `single address size: ${item.id}`);
  assert.equal(bundle.metadata.repeatKind, null, `single repeat: ${item.id}`);
  assert.equal(operations(bundle,'intrinsic').filter((operation) => operation.metadata?.summaryContractVersion === 'x86-repeated-string-summary/v1').length, 0, `single unexpectedly used repeated-string intrinsic: ${item.id}`);
  if (item.sourceBehavior.present) {
    const sourceRead = operations(bundle,'memory-read').find((operation) => operation.metadata?.stringRole === 'source');
    assert.ok(sourceRead, `source read missing: ${item.id}`);
    assert.equal(sourceRead.access.widthBits, item.elementWidthBits, `source width: ${item.id}`);
    assert.equal(sourceRead.access.space, item.sourceBehavior.space, `source space: ${item.id}`);
    assert.equal(sourceRead.metadata.segment, item.sourceBehavior.segment, `source segment: ${item.id}`);
    assert.equal(sourceRead.metadata.addressSizeBits, item.addressSizeBits, `source address size: ${item.id}`);
  }
  if (item.destinationBehavior.present) {
    const destinationAccess = [...operations(bundle,'memory-read'),...operations(bundle,'memory-write')].find((operation) => operation.metadata?.stringRole === 'destination');
    assert.ok(destinationAccess, `destination access missing: ${item.id}`);
    assert.equal(destinationAccess.access.space, 'memory', `destination space: ${item.id}`);
    assert.equal(destinationAccess.metadata.segment, 'es', `destination segment: ${item.id}`);
    assert.equal(destinationAccess.metadata.addressSizeBits, item.addressSizeBits, `destination address size: ${item.id}`);
  }
  assert.ok(operations(bundle,'flag-read').some((operation) => operation.flag.flagId === 'RFLAGS.DF'), `DF input missing: ${item.id}`);
  if (item.flagsBehavior.compare) {
    const written = new Set(operations(bundle,'flag-write').map((operation) => operation.flag.flagId));
    for (const flag of ['CF','PF','AF','ZF','SF','OF']) assert.ok(written.has(`RFLAGS.${flag}`), `single compare ${flag} missing: ${item.id}`);
  }
  assert.equal(instruction.detail.addressSizeBits, item.addressSizeBits, `decoder address-size drift: ${item.id}`);
}
function assertRepeated(item, bundle) {
  repeatedCaseCount++;
  const proof = validateX86Long64RepeatedStringSummary(bundle,item);
  assert.deepEqual(proof.errors, [], `repeated summary incomplete: ${item.id}: ${proof.errors.join(',')}`);
  assert.equal(proof.ok, true, `repeated summary rejected: ${item.id}`);
  assert.equal(bundle.metadata.exactRepeatedSummary, true, `bundle repeated marker: ${item.id}`);
  assert.ok(bundle.operations.length <= 20, `runtime count was unrolled: ${item.id}`);
  assert.equal(operations(bundle,'memory-read').length, 0, `repeated memory read should remain summarized: ${item.id}`);
  assert.equal(operations(bundle,'memory-write').length, 0, `repeated memory write should remain summarized: ${item.id}`);
  const intrinsic = operations(bundle,'intrinsic')[0];
  assertMemoryScope(intrinsic.effectSummary.memoryRead,expectedReadSpaces(item),`read scope: ${item.id}`);
  assertMemoryScope(intrinsic.effectSummary.memoryWrite,expectedWriteSpaces(item),`write scope: ${item.id}`);
  assert.equal(intrinsic.metadata.flags.writes.length,item.flagsBehavior.compare ? 6 : 0,`flags write contract: ${item.id}`);
  assert.equal(intrinsic.metadata.count.decrement,'once after each fully completed element',`count decrement: ${item.id}`);
  assert.equal(intrinsic.metadata.memory.faultProgress,'only fully completed elements advance pointers/count; faulting element remains restart point',`fault restart: ${item.id}`);
  const writtenRegisters = new Set(operations(bundle,'register-write').map((operation) => operation.register.registerId));
  assert.ok(writtenRegisters.has('rcx'), `physical RCX output missing: ${item.id}`);
  if (item.sourceBehavior.present) assert.ok(writtenRegisters.has('rsi'), `physical RSI output missing: ${item.id}`);
  if (item.destinationBehavior.present) assert.ok(writtenRegisters.has('rdi'), `physical RDI output missing: ${item.id}`);
  if (item.operation === 'lods') assert.ok(writtenRegisters.has('rax'), `physical RAX output missing: ${item.id}`);
  if (item.addressSizeBits === 32) {
    assert.match(intrinsic.metadata.count.nonzeroWrite,/zero-extending RCX/,`ECX zero-extension contract: ${item.id}`);
    assert.match(intrinsic.metadata.direction.zeroCount,/full physical register values/,`a32 zero-count pointer preservation: ${item.id}`);
  }
  if (item.repeatKind === 'repe') assert.match(intrinsic.metadata.termination.continuation,/updated ZF == 1/,`REPE updated-ZF continuation: ${item.id}`);
  if (item.repeatKind === 'repne') assert.match(intrinsic.metadata.termination.continuation,/updated ZF == 0/,`REPNE updated-ZF continuation: ${item.id}`);
}

try {
  for (const item of x86Long64StringDenominatorCases()) {
    const decoded = session.decode(item.bytes,0x400000n + BigInt(decodedCaseCount) * 0x20n);
    assert.equal(decoded.length,1,`denominator decode count: ${item.id}`);
    assert.equal(decoded[0].length,item.bytes.length,`denominator byte consumption: ${item.id}`);
    assert.equal(decoded[0].instructionFamily,item.family,`denominator family: ${item.id}`);
    const instruction = createX86DecodedInstruction({ ...decoded[0], instructionId:`x86-string:${item.id}` });
    const bundle = liftX86MachineEffects(instruction);
    assert.ok(bundle,`string effect ownership escaped: ${item.id}`);
    assert.equal(bundle.metadata.family,'string',`wrong effect owner: ${item.id}`);
    if (item.repeatKind == null) assertSingle(item,instruction,bundle);
    else assertRepeated(item,bundle);
    decodedCaseCount++;
  }

  assert.equal(decodedCaseCount,identity.semanticCaseCount);
  assert.ok(repeatedCaseCount > 0);

  // Malformed/conflicting repetition prefix state must fail closed even though
  // Capstone chooses the last group-1 prefix and still decodes an instruction.
  {
    const raw = Uint8Array.of(0xf3,0xf2,0xa6);
    const decoded = session.decode(raw,0x500000n);
    assert.equal(decoded.length,1);
    const instruction = createX86DecodedInstruction({ ...decoded[0], instructionId:'x86-string:negative:conflicting-repeat-prefix' });
    const bundle = liftX86MachineEffects(instruction);
    assert.equal(bundle.completeness,'partial');
    assert.match(bundle.unknownEffects.reason,/prefix-state-unmodelled/);
  }
  assert.equal(session.decode(Uint8Array.of(0xf0,0xa4),0x500010n).length,0,'LOCK string form must be decoder-invalid');

  // F2 on non-compare string forms is intentionally outside the exact lane.
  {
    const [decoded] = session.decode(Uint8Array.of(0xf2,0xa4),0x500020n);
    const instruction = createX86DecodedInstruction({ ...decoded, instructionId:'x86-string:negative:f2-movs' });
    const bundle = liftX86MachineEffects(instruction);
    assert.equal(bundle.completeness,'partial');
    assert.match(bundle.unknownEffects.reason,/f2-repeat-prefix/);
  }

  // Missing implicit count state cannot certify REP exactness.
  {
    const [decoded] = session.decode(Uint8Array.of(0xf3,0xa4),0x500030n);
    const detail = { ...decoded.detail, implicitReads:decoded.detail.implicitReads.filter((name) => name !== 'rcx') };
    const instruction = createX86DecodedInstruction({ ...decoded, detail, instructionId:'x86-string:negative:missing-rcx' });
    const bundle = liftX86MachineEffects(instruction);
    assert.equal(bundle.completeness,'partial');
    assert.match(bundle.unknownEffects.reason,/implicit-state-unmodelled/);
  }

  // Invalid address-size state is never guessed from mnemonic/opcode.
  {
    const [decoded] = session.decode(Uint8Array.of(0xa4),0x500040n);
    const instruction = createX86DecodedInstruction({ ...decoded, detail:{ ...decoded.detail, addressSizeBits:16 }, instructionId:'x86-string:negative:a16' });
    const bundle = liftX86MachineEffects(instruction);
    assert.equal(bundle.completeness,'partial');
    assert.match(bundle.unknownEffects.reason,/address-size-unmodelled/);
  }

  // A string family with a non-string structured operand shape fails closed.
  {
    const [decoded] = session.decode(Uint8Array.of(0xa4),0x500050n);
    const detail = { ...decoded.detail, operands:[
      { type:'register', register:'rax', widthBits:64, access:'write' },
      { type:'register', register:'rbx', widthBits:64, access:'read' },
    ], operandCount:2 };
    const instruction = createX86DecodedInstruction({ ...decoded, detail, instructionId:'x86-string:negative:unsupported-shape' });
    const bundle = liftX86MachineEffects(instruction);
    assert.equal(bundle.completeness,'partial');
    assert.match(bundle.unknownEffects.reason,/operand-shape-unmodelled/);
  }

  // Ambiguous MOVSD/CMPSD vector shapes must remain available to the SIMD owner.
  {
    const [decoded] = session.decode(Uint8Array.of(0xf2,0x0f,0x10,0xc1),0x500060n);
    assert.equal(decoded?.instructionFamily,'movsd','ambiguous MOVSD decode');
    const instruction = createX86DecodedInstruction({ ...decoded, instructionId:'x86-string:negative:movsd-simd' });
    assert.equal(liftX86StringEffects(instruction),null,'MOVSD SIMD shape stolen by string owner');
  }
  {
    const instruction = createX86DecodedInstruction({
      instructionId:'x86-string:negative:cmpsd-simd', instructionCode:0x7fff, instructionFamily:'cmpsd',
      address:0x500070n, length:5, rawBytes:Uint8Array.of(0xf2,0x0f,0xc2,0xc1,0x00), mode:'long-64',
      detailAvailable:true, detailStatus:'complete', mnemonic:'cmpsd', opStr:'xmm0, xmm1, 0',
      detail:{ addressSizeBits:64, prefixes:{legacy:[0xf2],rex:null,vector:null}, operands:[
        {type:'register',register:'xmm0',widthBits:128,access:'read-write'},
        {type:'register',register:'xmm1',widthBits:128,access:'read'},
        {type:'immediate',value:0n,widthBits:8,encodedWidthBits:8,access:'unknown'},
      ], operandCount:3, implicitReads:[], implicitWrites:[] },
    });
    assert.equal(liftX86StringEffects(instruction),null,'CMPSD SIMD shape stolen by string owner');
  }

  // The proof gate is intentionally independent from production.  Removing a
  // required repetition contract must make an otherwise-valid bundle fail.
  {
    const item = [...x86Long64StringDenominatorCases()].find((entry) => entry.operation === 'cmps' && entry.repeatKind === 'repe' && entry.addressSizeBits === 32 && entry.elementWidthBits === 32 && entry.sourceBehavior.segment === 'fs');
    assert.ok(item);
    const [decoded] = session.decode(item.bytes,0x500080n);
    const instruction = createX86DecodedInstruction({ ...decoded, instructionId:'x86-string:negative:truncated-summary' });
    const bundle = liftX86MachineEffects(instruction);
    const truncated = {
      ...bundle,
      operations:bundle.operations.map((operation) => operation.kind !== 'intrinsic' ? operation : { ...operation, metadata:{ ...operation.metadata, termination:null } }),
    };
    const proof = validateX86Long64RepeatedStringSummary(truncated,item);
    assert.equal(proof.ok,false);
    assert.ok(proof.errors.includes('termination-entry'));
    assert.ok(proof.errors.includes('termination-control'));
  }
} finally {
  session.close();
}

console.log(JSON.stringify({
  denominator:identity.denominatorId,
  semanticCases:decodedCaseCount,
  repeatedCases:repeatedCaseCount,
  negatives:identity.negativeContracts.length,
  status:'exact-closed',
}));
