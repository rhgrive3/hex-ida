import assert from 'node:assert/strict';

import { createCapstoneX86Session } from '../phase5/helpers/capstone-session.mjs';
import {
  buildX86CapstoneRegistryEvidence,
  verifyX86CapstoneRegistryEvidence,
} from '../../tools/validation/machine-effects/x86-capstone-registry.mjs';

const session = await createCapstoneX86Session();
try {
  const evidence = buildX86CapstoneRegistryEvidence(session.instructionName);
  assert.equal(evidence.instructionCount, 1523);
  assert.equal(evidence.rows[0].name, 'aaa');
  assert.equal(evidence.rows.at(-1).name, 'xtest');
  assert.equal(evidence.long64EncodingDenominator, false);
  assert.deepEqual(evidence.missingAuthority, [
    'instruction-id-to-valid-long-64-encoding-discriminators',
    'prefix-and-alias-mode-validity',
    'operand-and-implicit-state-variant-enumeration',
  ]);

  // The all-mode registry contains legacy-only AAA, while the same deployed
  // handle rejects its byte encoding in long mode. This prevents a registry
  // count from being promoted to a long-64 decoder denominator.
  const aaa = evidence.rows.find(({ name }) => name === 'aaa');
  assert.ok(aaa);
  assert.equal(session.decode(Uint8Array.of(0x37), 0x1000n).length, 0);

  verifyX86CapstoneRegistryEvidence(evidence);
} finally {
  session.close();
}

console.log('x86 deployed Capstone instruction-name registry identity: PASS');
