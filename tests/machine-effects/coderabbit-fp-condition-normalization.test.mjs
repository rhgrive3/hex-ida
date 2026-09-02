import assert from 'node:assert/strict';

import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

const ops = parseOperands('s0, s1, s2, eq').map((op) =>
  op?.k === 'cond' ? { ...op, text: ' EQ ' } : op
);
const effects = liftArm64MachineEffects({
  instructionId: 'coderabbit:fp-condition-trim',
  mnemonic: 'fcsel',
  ops,
  mode: 'a64',
});

assert.ok(effects, 'fcsel must remain owned by the FP lifter');
assert.ok(['exact', 'exact-with-intrinsic'].includes(effects.completeness),
  `padded canonical condition must not fail closed: ${effects.completeness}`);

console.log('ARM64 FP conditional evidence normalization: PASS');