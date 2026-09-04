import assert from 'node:assert/strict';

import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { liftX86StringEffects } from '../../js/targets/architecture/x86_64/effects/string.js';

function memory(base, access, addressSizeBits, segment) {
  return {
    type:'memory', widthBits:8, access,
    memory:{ base, index:null, scale:1, displacement:0n, segment, addressSizeBits },
  };
}

function repeatedInstruction({ family = 'movsb', repeat = 'rep', addressSizeBits = 32, instructionId }) {
  const prefix = repeat === 'repne' ? 0xf2 : 0xf3;
  const opcode = family === 'cmpsb' ? 0xa6 : 0xa4;
  const pointerBits = addressSizeBits;
  const source = pointerBits === 32 ? 'esi' : 'rsi';
  const destination = pointerBits === 32 ? 'edi' : 'rdi';
  const rawBytes = addressSizeBits === 32
    ? Uint8Array.of(0x67,prefix,opcode)
    : Uint8Array.of(prefix,opcode);
  const operands = family === 'cmpsb'
    ? [memory(source,'read',addressSizeBits,'ds'),memory(destination,'read',addressSizeBits,'es')]
    : [memory(destination,'write',addressSizeBits,'es'),memory(source,'read',addressSizeBits,'ds')];
  const compare = family === 'cmpsb';
  return createX86DecodedInstruction({
    instructionId,
    instructionCode:0x4189,
    instructionFamily:family,
    address:0x401000n,
    length:rawBytes.length,
    rawBytes,
    mode:'long-64',
    detailAvailable:true,
    detailStatus:'complete',
    mnemonic:repeat === 'rep' ? `rep ${family}` : `${repeat} ${family}`,
    opStr:'',
    detail:{
      addressSizeBits,
      prefixes:{ legacy:addressSizeBits === 32 ? [prefix,0x67] : [prefix], rex:null, vector:null },
      operands,
      operandCount:operands.length,
      implicitReads:['rflags','rsi','rdi','rcx'],
      implicitWrites:compare ? ['rflags','rsi','rdi','rcx'] : ['rsi','rdi','rcx'],
    },
  });
}

function operations(bundle, kind) { return bundle.operations.filter((operation) => operation.kind === kind); }
function valueWidth(value) { return value?.kind === 'temporary' ? Number(value.valueType?.widthBits) : Number(value?.widthBits); }
function intrinsicOf(bundle) {
  const intrinsics = operations(bundle,'intrinsic');
  assert.equal(intrinsics.length,1);
  return intrinsics[0];
}

{
  const bundle = liftX86StringEffects(repeatedInstruction({ instructionId:'issue-4189:a32-rep-movsb' }));
  assert.equal(bundle.completeness,'exact-with-intrinsic');
  const intrinsic = intrinsicOf(bundle);
  assert.deepEqual(intrinsic.effectSummary.inputs.slice(0,4).map(valueWidth),[32,1,32,32],
    'addr32 REP value inputs must be ECX/DF/ESI/EDI width, not full RCX/RSI/RDI');
  assert.deepEqual(intrinsic.effectSummary.outputs.slice(0,3).map(valueWidth),[32,32,32],
    'addr32 REP count/pointer summary outputs must remain in the 32-bit address-size domain');
  assert.deepEqual(intrinsic.metadata.outputRoles.slice(0,3).map(({ role, registerName, widthBits }) => ({ role, registerName, widthBits })),[
    { role:'count', registerName:'rcx', widthBits:32 },
    { role:'source-pointer', registerName:'rsi', widthBits:32 },
    { role:'destination-pointer', registerName:'rdi', widthBits:32 },
  ]);
  assert.equal(intrinsic.metadata.count.view,'ecx');
  assert.equal(intrinsic.metadata.count.widthBits,32);
  assert.equal(intrinsic.metadata.direction.arithmeticWidthBits,32);

  const entryPredicate = operations(bundle,'value').filter((operation) => operation.metadata?.repeatedStringEntry === true);
  assert.equal(entryPredicate.length,1);
  assert.equal(entryPredicate[0].opcode,'icmp.ne');
  assert.equal(valueWidth(entryPredicate[0].inputs[0]),32,'entry predicate must test ECX, not RCX');

  const commits = operations(bundle,'value').filter((operation) => operation.metadata?.semantic === 'x86-repeated-string-address32-physical-commit');
  assert.deepEqual(commits.map((operation) => operation.metadata.role).sort(),['count','destination','source']);
  for (const operation of commits) {
    assert.equal(operation.opcode,'select');
    assert.deepEqual(operation.inputs.map(valueWidth),[1,64,64]);
    assert.equal(valueWidth(operation.outputs[0]),64);
    assert.equal(operation.metadata.condition,'entry ECX != 0');
    assert.match(operation.metadata.falsePath,/preserve full (RCX|RSI|RDI) when ECX == 0/);
  }

  const physicalWrites = new Map(operations(bundle,'register-write').map((operation) => [operation.register.registerId,operation]));
  for (const name of ['rcx','rsi','rdi']) {
    assert.ok(physicalWrites.has(name),`missing physical ${name.toUpperCase()} commit`);
    assert.equal(valueWidth(physicalWrites.get(name).value),64,`${name.toUpperCase()} commit must remain physical-width`);
  }
}

{
  const bundle = liftX86StringEffects(repeatedInstruction({ addressSizeBits:64, instructionId:'issue-4189:a64-rep-movsb' }));
  const intrinsic = intrinsicOf(bundle);
  assert.deepEqual(intrinsic.effectSummary.inputs.slice(0,4).map(valueWidth),[64,1,64,64]);
  assert.deepEqual(intrinsic.effectSummary.outputs.slice(0,3).map(valueWidth),[64,64,64]);
  assert.equal(operations(bundle,'value').some((operation) => operation.metadata?.semantic === 'x86-repeated-string-address32-physical-commit'),false,
    'addr64 REP must keep the existing full-width state path');
}

for (const repeat of ['repe','repne']) {
  const bundle = liftX86StringEffects(repeatedInstruction({ family:'cmpsb', repeat, instructionId:`issue-4189:a32-${repeat}-cmpsb` }));
  const intrinsic = intrinsicOf(bundle);
  assert.equal(bundle.completeness,'exact-with-intrinsic');
  assert.deepEqual(intrinsic.effectSummary.inputs.slice(0,4).map(valueWidth),[32,1,32,32],`${repeat} must use ECX/ESI/EDI authority`);
  assert.deepEqual(intrinsic.effectSummary.outputs.slice(0,3).map(valueWidth),[32,32,32],`${repeat} must update 32-bit address-size views`);
}

console.log(JSON.stringify({ issue:4189, status:'addr32-rep-state-authority-closed' }));
