import assert from 'node:assert/strict';

import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

const DEFINITE_STATE_KINDS = new Set(['register-read', 'register-write', 'intrinsic']);

function withCondition(operandText, conditionText) {
  return parseOperands(operandText).map((op) =>
    op?.k === 'cond' ? { ...op, text: conditionText } : op
  );
}

function lift(mnemonic, ops, suffix) {
  return liftArm64MachineEffects({
    instructionId: `issue-3069:${suffix}`,
    mnemonic,
    ops,
    mode: 'a64',
  });
}

function assertPartialWithoutDefiniteState(effects, label) {
  assert.ok(effects, `${label}: FP lifter must retain ownership`);
  assert.equal(effects.completeness, 'partial', `${label}: malformed condition must fail closed`);
  assert.equal(
    effects.operations.some((operation) => DEFINITE_STATE_KINDS.has(operation.kind)),
    false,
    `${label}: malformed condition must not emit definite register/intrinsic state`,
  );
}

const paddedFcsel = lift('fcsel', withCondition('s0, s1, s2, eq', ' EQ '), 'fcsel-padded');
assert.ok(['exact', 'exact-with-intrinsic'].includes(paddedFcsel.completeness),
  `padded canonical FCSEL condition must not fail closed: ${paddedFcsel.completeness}`);
assert.equal(
  paddedFcsel.operations.find((operation) => operation.kind === 'intrinsic')?.metadata?.condition,
  'eq',
  'FCSEL must pass the canonicalized condition into the semantic core',
);

const paddedFccmp = lift('fccmp', withCondition('s0, s1, #0, eq', ' Eq '), 'fccmp-padded');
assert.ok(['exact', 'exact-with-intrinsic'].includes(paddedFccmp.completeness),
  `padded canonical FCCMP condition must not fail closed: ${paddedFccmp.completeness}`);
assert.equal(
  paddedFccmp.operations.find((operation) => operation.kind === 'intrinsic')?.metadata?.condition,
  'eq',
  'FCCMP must pass the canonicalized condition into the semantic core',
);

for (const [name, malformed] of [
  ['object', { toString() { return 'eq'; } }],
  ['array', ['eq']],
  ['boolean', true],
  ['number', 0],
  ['unknown-string', 'not-a-condition'],
  ['empty-string', ''],
]) {
  assertPartialWithoutDefiniteState(
    lift('fcsel', withCondition('s0, s1, s2, eq', malformed), `fcsel-${name}`),
    `FCSEL ${name}`,
  );
  assertPartialWithoutDefiniteState(
    lift('fccmp', withCondition('s0, s1, #0, eq', malformed), `fccmp-${name}`),
    `FCCMP ${name}`,
  );
}

const missingFcselCondition = parseOperands('s0, s1, s2, eq').filter((op) => op?.k !== 'cond');
assertPartialWithoutDefiniteState(
  lift('fcsel', missingFcselCondition, 'fcsel-missing-condition'),
  'FCSEL missing condition',
);

const duplicateFccmpCondition = withCondition('s0, s1, #0, eq', 'eq');
duplicateFccmpCondition.push({ k: 'cond', text: 'ne' });
assertPartialWithoutDefiniteState(
  lift('fccmp', duplicateFccmpCondition, 'fccmp-duplicate-condition'),
  'FCCMP duplicate condition',
);

console.log('ARM64 FP conditional evidence normalization (#3069): PASS');