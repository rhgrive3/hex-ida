import assert from 'node:assert/strict';

import { createCapstoneX86Session } from '../phase5/helpers/capstone-session.mjs';
import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { dispatchX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import { x86RegisterDescriptor, x86RegisterFile } from '../../js/targets/architecture/x86_64/registers.js';

for (const id of ['cr0','cr2','cr3','cr4','cr8','dr0','dr1','dr2','dr3','dr6','dr7']) {
  const descriptor = x86RegisterDescriptor(id);
  assert.ok(descriptor, `${id}: canonical descriptor`);
  assert.equal(descriptor.modeled, true, `${id}: modeled`);
  assert.equal(descriptor.viewBits, 64, `${id}: width`);
  assert.equal(descriptor.physicalId, id, `${id}: physical identity`);
}
const physicalIds = new Set(x86RegisterFile().map((item) => item.id));
assert.ok(physicalIds.has('cr0'));
assert.ok(physicalIds.has('cr8'));
assert.ok(physicalIds.has('dr0'));
assert.ok(physicalIds.has('dr7'));

const cases = [
  { bytes:[0x0f,0x20,0xc0], privileged:'cr0', direction:'system-to-gp' },
  { bytes:[0x0f,0x22,0xc0], privileged:'cr0', direction:'gp-to-system' },
  { bytes:[0x0f,0x21,0xf8], privileged:'dr7', direction:'system-to-gp' },
  { bytes:[0x0f,0x23,0xf8], privileged:'dr7', direction:'gp-to-system' },
  { bytes:[0x44,0x0f,0x20,0xc0], privileged:'cr8', direction:'system-to-gp' },
  { bytes:[0x44,0x0f,0x22,0xc0], privileged:'cr8', direction:'gp-to-system' },
];

const session = await createCapstoneX86Session();
try {
  for (const [index, item] of cases.entries()) {
    const decodedRows = session.decode(item.bytes, 0x790000n + BigInt(index) * 0x20n);
    assert.equal(decodedRows.length, 1, `${item.privileged}:${item.direction}: decode`);
    const instruction = createX86DecodedInstruction({
      ...decodedRows[0],
      instructionId:`system-register-move:${index}`,
    });
    assert.equal(instruction.instructionFamily, 'mov');
    assert.ok(instruction.detail.operands.some((operand) => operand?.register?.id === item.privileged), `${item.privileged}: decoder operand`);

    const dispatched = dispatchX86MachineEffects(instruction);
    assert.equal(dispatched.ownerId, 'system', `${item.privileged}:${item.direction}: owner`);
    assert.equal(dispatched.result.completeness, 'exact-with-intrinsic', `${item.privileged}:${item.direction}: completeness`);
    assert.equal(dispatched.result.unknownEffects, undefined);
    assert.equal(dispatched.result.metadata.systemRegisterMove, true);
    assert.equal(dispatched.result.metadata.privilegedRegister, item.privileged);
    assert.equal(dispatched.result.metadata.direction, item.direction);
    assert.equal(dispatched.result.metadata.physicalStateModeled, true);
    assert.ok(dispatched.result.operations.some((op) => op.kind === 'intrinsic' && op.intrinsicId.startsWith('x86.system.mov.')));
    assert.ok(dispatched.result.possibleFaults.some((fault) => fault.kind === 'general-protection'));
    assert.ok(dispatched.result.possibleFaults.some((fault) => fault.kind === 'undefined-opcode'));
    if (item.privileged.startsWith('dr')) {
      assert.ok(dispatched.result.possibleFaults.some((fault) => fault.kind === 'debug-exception'));
    }
  }
} finally {
  session.close();
}

console.log('x86 MOV CR/DR canonical system ownership: PASS');
