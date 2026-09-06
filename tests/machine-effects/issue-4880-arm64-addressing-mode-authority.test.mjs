import assert from 'node:assert/strict';
import {
  Arm64AddressingError,
  buildArm64EffectiveAddress,
} from '../../js/targets/architecture/arm64/effects/addressing.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

function memory(modeFields = {}) {
  return {
    k:'mem',
    base:{ k:'reg', cls:'gp', num:1, bits:64, text:'x1' },
    disp:0n,
    ...modeFields,
  };
}

function decoded(mem, mnemonic = 'ldr') {
  return {
    instructionId:`issue-4880-${mnemonic}`,
    architectureId:'arm64',
    mnemonic,
    mode:'a64',
    ops:[
      { k:'reg', cls:'gp', num:0, bits:64, text:'x0' },
      mem,
    ],
    origin:{ instructionIds:[`issue-4880-${mnemonic}`] },
  };
}

function assertAddressingError(mem, code = 'arm64-unsupported-addressing-mode') {
  assert.throws(
    () => buildArm64EffectiveAddress(decoded(mem), { accessWidthBits:64 }),
    (error) => error instanceof Arm64AddressingError && error.code === code,
  );
}

for (const [mode, extra, writebackCount] of [
  ['offset', { disp:8n }, 0],
  ['pre', { disp:-8n }, 2],
  ['post', { disp:8n }, 2],
]) {
  const addressing = buildArm64EffectiveAddress(decoded(memory({ mode, ...extra })), { accessWidthBits:64 });
  assert.equal(addressing.mode, mode);
  assert.equal(addressing.writebackOperations.length, writebackCount);
}

assert.equal(
  buildArm64EffectiveAddress(decoded(memory({ mode:'PRE', disp:-8n })), { accessWidthBits:64 }).mode,
  'pre',
  'existing case-insensitive primitive-string normalization must remain supported',
);
assert.equal(
  buildArm64EffectiveAddress(decoded(memory({ addressingMode:'post', disp:8n })), { accessWidthBits:64 }).mode,
  'post',
  'legacy addressingMode alias must remain supported',
);
assert.equal(
  buildArm64EffectiveAddress(decoded(memory({ mode:'PRE', addressingMode:'pre', disp:-8n })), { accessWidthBits:64 }).mode,
  'pre',
  'equivalent primitive aliases must agree after normalization',
);

const structuredModes = [
  ['offset'],
  ['pre'],
  ['post'],
  true,
  false,
  0,
  1,
  { toString() { throw new Error('addressing mode coercion must not run'); } },
];
for (const mode of structuredModes) {
  assertAddressingError(memory({ mode, disp:8n }));
  const result = liftArm64MachineEffects(decoded(memory({ mode, disp:8n })));
  assert.equal(result.completeness, 'partial');
  assert.deepEqual(result.operations, []);
  assert.equal(result.unknownEffects?.reason, 'arm64-unsupported-addressing-mode');
}

assertAddressingError(memory({ addressingMode:['offset'], disp:8n }));
assertAddressingError(
  memory({ mode:'offset', addressingMode:'pre', disp:8n }),
  'arm64-conflicting-addressing-mode',
);

let modeReads = 0;
const driftingMode = memory({ disp:8n });
Object.defineProperty(driftingMode, 'mode', {
  enumerable:true,
  get() {
    modeReads += 1;
    if (modeReads <= 2) return 'offset';
    return { toLowerCase() { return 'pre'; } };
  },
});
const driftingAddress = buildArm64EffectiveAddress(decoded(driftingMode), { accessWidthBits:64 });
assert.equal(modeReads, 1, 'mode authority must be snapshotted exactly once');
assert.equal(driftingAddress.mode, 'offset', 'validated mode snapshot must determine semantics');
assert.equal(driftingAddress.writebackOperations.length, 0, 'later accessor values must not inject writeback');

let malformedModeReads = 0;
const malformedMode = memory({ disp:8n });
Object.defineProperty(malformedMode, 'mode', {
  enumerable:true,
  get() {
    malformedModeReads += 1;
    return malformedModeReads === 1 ? ['offset'] : 'offset';
  },
});
const malformedModeResult = liftArm64MachineEffects(decoded(malformedMode));
assert.equal(malformedModeReads, 1, 'malformed mode accessor must not be re-read after validation');
assert.equal(malformedModeResult.completeness, 'partial');
assert.deepEqual(malformedModeResult.operations, [], 'malformed mode must publish no definite operations');
assert.equal(malformedModeResult.unknownEffects?.reason, 'arm64-unsupported-addressing-mode');

let malformedAliasReads = 0;
const malformedAlias = memory({ disp:8n });
Object.defineProperty(malformedAlias, 'addressingMode', {
  enumerable:true,
  get() {
    malformedAliasReads += 1;
    return malformedAliasReads === 1 ? ['post'] : 'post';
  },
});
const malformedAliasResult = liftArm64MachineEffects(decoded(malformedAlias));
assert.equal(malformedAliasReads, 1, 'addressingMode authority must be snapshotted exactly once');
assert.equal(malformedAliasResult.completeness, 'partial');
assert.deepEqual(malformedAliasResult.operations, [], 'malformed addressingMode must publish no definite operations');
assert.equal(malformedAliasResult.unknownEffects?.reason, 'arm64-unsupported-addressing-mode');

console.log('issue-4880 arm64 addressing-mode authority regression: PASS');
