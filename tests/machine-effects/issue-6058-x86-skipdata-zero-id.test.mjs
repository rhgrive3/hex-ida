import assert from 'node:assert/strict';
import test from 'node:test';

import { createX86DecodedInstruction, x86DecodedInstructionIsStructured } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { dispatchX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import { X86_64_ARCHITECTURE } from '../../js/targets/architecture/index.js';
import { classifyMachineEffectsCoverage } from '../../js/targets/architecture/coverage.js';

// #6058 — Capstone's SKIPDATA contract emits the sentinel instruction ID 0
// for bytes the decoder could not interpret, and the structured bridge
// publishes those records with `detailStatus:'skipdata'`. The canonical
// decoded-instruction normalizer rejected both the status token and the
// zero ID before the effects dispatcher's fail-closed fallback could run,
// so every SKIPDATA record became a lifter error instead of an
// unsupported/unknown row.

const SKIPDATA_BASE = Object.freeze({
  address: 0x1000n,
  length: 1,
  rawBytes: Uint8Array.of(0xff),
  mnemonic: '.byte',
  opStr: '0xff',
  architecture: 'x86_64',
  mode: 'long-64',
  decoderSemanticVersion: 'capstone-5-x86-structured-v2',
  instructionFamily: '(bad)',
  detail: Object.freeze({ unavailableFacts: Object.freeze(['all-structured-x86-detail']) }),
});

const skipdataRecord = () => ({
  ...SKIPDATA_BASE,
  instructionCode: 0,
  detailStatus: 'skipdata',
  detailAvailable: false,
});

test('#6058 bridge-equivalent SKIPDATA record canonicalizes', () => {
  const canonical = createX86DecodedInstruction(skipdataRecord());
  assert.equal(canonical.instructionCode, 0);
  assert.equal(canonical.detailStatus, 'skipdata');
  assert.equal(canonical.detailAvailable, false);
  // A skipdata row never carries exact-detail authority.
  assert.equal(x86DecodedInstructionIsStructured(skipdataRecord()), false);
});

test('#6058 SKIPDATA record dispatches fail-closed to the fallback owner', () => {
  const dispatch = dispatchX86MachineEffects(skipdataRecord(), {});
  assert.deepEqual(dispatch, { ownerId: 'fallback', result: null });
});

test('#6058 SKIPDATA records count as unsupported, not error, in coverage', () => {
  const coverage = classifyMachineEffectsCoverage(X86_64_ARCHITECTURE, createX86DecodedInstruction(skipdataRecord()));
  assert.equal(coverage.status, 'unsupported');
});

test('#6058 sentinel zero ID is only valid with skipdata status', () => {
  assert.throws(
    () => createX86DecodedInstruction({
      ...SKIPDATA_BASE,
      instructionCode: 0,
      detailStatus: 'complete',
      detailAvailable: true,
      detail: Object.freeze({ operands: Object.freeze([]), operandCount: 0 }),
    }),
    /x86-decoded-instruction-id-required/,
  );
  assert.throws(
    () => createX86DecodedInstruction({ ...SKIPDATA_BASE, instructionCode: 0, detailStatus: 'unavailable', detailAvailable: false }),
    /x86-decoded-instruction-id-required/,
  );
  assert.throws(
    () => createX86DecodedInstruction({ ...SKIPDATA_BASE, instructionCode: 0, detailStatus: 'malformed' }),
    /x86-decoded-instruction-id-required/,
  );
  // The inverse contradiction is rejected too: a non-zero ID is not a
  // SKIPDATA sentinel.
  assert.throws(
    () => createX86DecodedInstruction({ ...SKIPDATA_BASE, instructionCode: 42, detailStatus: 'skipdata', detailAvailable: false }),
    /x86-decoded-instruction-id-required/,
  );
  // The sentinel is a primitive numeric contract, not a Number()-coercible
  // value. Structured/boolean/string spellings must not mint ID 0 authority.
  for (const instructionCode of [false, [], ['0'], '0']) {
    assert.throws(
      () => createX86DecodedInstruction({ ...SKIPDATA_BASE, instructionCode, detailStatus: 'skipdata', detailAvailable: false }),
      /x86-decoded-instruction-id-required/,
    );
  }
});

test('#6058 normal instructions keep the positive-ID requirement', () => {
  const canonical = createX86DecodedInstruction({
    ...SKIPDATA_BASE,
    instructionCode: 1,
    instructionFamily: 'nop',
    mnemonic: 'nop',
    opStr: '',
    detailStatus: 'complete',
    detailAvailable: true,
    detail: Object.freeze({ operands: Object.freeze([]), operandCount: 0 }),
  });
  assert.equal(canonical.instructionCode, 1);
  assert.equal(canonical.detailStatus, 'complete');
  assert.equal(canonical.detailAvailable, true);
  assert.throws(
    () => createX86DecodedInstruction({
      ...SKIPDATA_BASE,
      instructionFamily: 'nop',
      mnemonic: 'nop',
      opStr: '',
      detailStatus: 'complete',
      detailAvailable: true,
      detail: Object.freeze({ operands: Object.freeze([]), operandCount: 0 }),
    }),
    /x86-decoded-instruction-id-required/,
  );
});
