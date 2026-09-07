import test from 'node:test';
import assert from 'node:assert/strict';

import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { dispatchX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';

/* Issue #6058: Capstone 5.0 SKIPDATA emits `cs_insn.id == 0` for the
 * synthetic data record, and the structured bridge produces
 * `instructionCode:0, detailStatus:'skipdata'`.  The canonical decoder
 * required a positive id and rejected 'skipdata' as a status, so the record
 * threw before `dispatchX86MachineEffects()` could route it to the
 * conservative fallback.  The SKIPDATA sentinel is now canonical for exactly
 * that status and stays a schema error everywhere else. */

function skipdataRecord(overrides = {}) {
  return {
    address:0x1000n,
    size:1,
    length:1,
    rawBytes:new Uint8Array([0xff]),
    mode:'long-64',
    decoderSemanticVersion:'capstone-5-x86-structured-v2',
    instructionCode:0,
    opcodeId:0,
    instructionFamily:'.byte',
    mnemonic:'.byte',
    operandCount:0,
    operands:[],
    implicitReads:[],
    implicitWrites:[],
    detailAvailable:false,
    detailStatus:'skipdata',
    detail:{ unavailableFacts:['all-structured-x86-detail'] },
    ...overrides,
  };
}

test('#6058: a bridge-shaped SKIPDATA record canonicalizes with the zero sentinel', () => {
  const decoded = createX86DecodedInstruction(skipdataRecord());
  assert.equal(decoded.instructionCode, 0);
  assert.equal(decoded.detailStatus, 'skipdata');
  assert.equal(decoded.detailAvailable, false);
  assert.equal(decoded.mnemonic, '.byte');
});

test('#6058: dispatchX86MachineEffects routes SKIPDATA to the conservative fallback', () => {
  const result = dispatchX86MachineEffects(createX86DecodedInstruction(skipdataRecord()), {});
  assert.deepEqual(result, { ownerId:'fallback', result:null });
});

test('#6058: a zero instruction code stays invalid outside the SKIPDATA status', () => {
  const cases = [
    ['complete', true],
    ['unavailable', false],
    ['partial', false],
    ['malformed', false],
  ];
  for (const [detailStatus, detailAvailable] of cases) {
    assert.throws(
      () => createX86DecodedInstruction(skipdataRecord({ detailStatus, detailAvailable })),
      /x86-decoded-instruction-id-required/,
      `${detailStatus} + code 0 must be rejected`,
    );
  }
});

test('#6058: the SKIPDATA sentinel must be exactly zero', () => {
  assert.throws(
    () => createX86DecodedInstruction(skipdataRecord({ instructionCode:1, opcodeId:1 })),
    /x86-decoded-instruction-id-required/,
  );
});

test('#6058: normal instructions keep requiring a positive opcode id', () => {
  const decoded = createX86DecodedInstruction({
    address:0x1000n,
    length:3,
    rawBytes:new Uint8Array([0x48, 0x89, 0xd8]),
    mode:'long-64',
    instructionCode:618,
    instructionFamily:'mov',
    mnemonic:'mov',
    detailAvailable:true,
    detailStatus:'complete',
    detail:{
      addressSizeBits:64,
      operandCount:2,
      operands:[
        { type:'register', access:'write', widthBits:64, register:'rax' },
        { type:'register', access:'read', widthBits:64, register:'rbx' },
      ],
      implicitReads:[],
      implicitWrites:[],
    },
  });
  assert.equal(decoded.instructionCode, 618);
  assert.equal(decoded.detailStatus, 'complete');
  assert.throws(
    () => createX86DecodedInstruction({
      address:0x1000n,
      length:3,
      rawBytes:new Uint8Array([0x48, 0x89, 0xd8]),
      mode:'long-64',
      instructionCode:0,
      instructionFamily:'mov',
      mnemonic:'mov',
      detailAvailable:true,
      detailStatus:'complete',
      detail:{
        addressSizeBits:64,
        operandCount:2,
        operands:[
          { type:'register', access:'write', widthBits:64, register:'rax' },
          { type:'register', access:'read', widthBits:64, register:'rbx' },
        ],
        implicitReads:[],
        implicitWrites:[],
      },
    }),
    /x86-decoded-instruction-id-required/,
  );
});
