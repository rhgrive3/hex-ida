import assert from 'node:assert/strict';

import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { liftX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import { createCapstoneX86Session } from '../phase5/helpers/capstone-session.mjs';
import {
  x86Long64LeaDenominatorIdentity,
  x86Long64LeaEncodingCases,
} from '../../tools/validation/machine-effects/x86-long64-lea-denominator.mjs';

const identity = x86Long64LeaDenominatorIdentity();
assert.equal(identity.encodingCaseCount, 302976);

const session = await createCapstoneX86Session();
let count = 0;
try {
  function verifyBatch(batch) {
    const byteLength = batch.reduce((sum, item) => sum + item.bytes.length, 0);
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const item of batch) { bytes.set(item.bytes, offset); offset += item.bytes.length; }
    const decoded = session.decode(bytes, 0x100000n + BigInt(count));
    assert.equal(decoded.length, batch.length, `LEA batch decode count drift at ${batch[0].id}`);
    for (let index = 0; index < batch.length; index++) {
      const item = batch[index];
      const decodedItem = decoded[index];
      assert.equal(decodedItem.length, item.bytes.length, `LEA did not consume its encoding: ${item.id}`);
      assert.equal(decodedItem.instructionFamily, 'lea', `wrong family: ${item.id}`);
      const instruction = createX86DecodedInstruction({ ...decodedItem, instructionId:`x86-lea:${item.id}` });
      const effects = liftX86MachineEffects(instruction);
      assert.ok(effects, `LEA escaped effect ownership: ${item.id}`);
      assert.equal(effects.completeness, 'exact', `LEA became partial: ${item.id}:${effects.partialReason}`);
      assert.equal(effects.metadata.operation, 'lea');
      assert.equal(effects.metadata.semanticMemoryAccess, false);
      count++;
    }
  }

  let batch = [];
  for (const item of x86Long64LeaEncodingCases()) {
    batch.push(item);
    if (batch.length === 1024) { verifyBatch(batch); batch = []; }
  }
  if (batch.length) verifyBatch(batch);

  // Prefixes are orthogonal to the ModRM/SIB discriminator sweep. Every legal
  // segment override remains address-calculation-only for LEA; REP/REPNE are
  // accepted hints with no state effect, while LOCK and register-source forms
  // are invalid and must not enter the effect registry.
  for (const prefix of [0x26,0x2e,0x36,0x3e,0x64,0x65,0xf2,0xf3]) {
    const [decoded] = session.decode(Uint8Array.of(prefix,0x48,0x8d,0x43,0x10), 0x2000n);
    assert.equal(decoded?.instructionFamily, 'lea', `legal LEA prefix rejected: ${prefix.toString(16)}`);
    const instruction = createX86DecodedInstruction({ ...decoded, instructionId:`x86-lea:prefix:${prefix}` });
    assert.equal(liftX86MachineEffects(instruction)?.completeness, 'exact');
  }
  assert.equal(session.decode(Uint8Array.of(0xf0,0x48,0x8d,0x43,0x10), 0x3000n).length, 0, 'LOCK LEA must be rejected');
  assert.equal(session.decode(Uint8Array.of(0x48,0x8d,0xc0), 0x3000n).length, 0, 'ModRM register source must be rejected');
} finally {
  session.close();
}

assert.equal(count, identity.encodingCaseCount);
console.log(`x86 long-64 LEA denominator (${count} encoding discriminators): PASS`);
