import assert from 'node:assert/strict';
import test from 'node:test';

import {
  partitionDecodedFunction,
  semanticControlUnknowns,
} from '../../js/analysis/semantic-function-base.js';
import {
  partitionDecodedFunction as partitionPublic,
} from '../../js/analysis/semantic-function.js';

// A single, architecture-neutral plugin drives the shared middle-end that every
// ArchitecturePluginV2 route (arm64/x86-64/riscv64/...) uses. `semanticIr.completeness`
// and `legacyV1.truncated` are derived *solely* from `semanticControlUnknowns().length`
// (semantic-function-base.js and the public semantic-function.js route both import this
// checker), so exercising this authority is what governs the published artifact.
function plugin({ kinds = {}, targets = {} } = {}) {
  return Object.freeze({
    id: 'issue-9005-architecture',
    semanticVersion: 'issue-9005-1',
    classifyControlFlow(instruction) {
      return Object.hasOwn(kinds, instruction.address.toString())
        ? kinds[instruction.address.toString()]
        : 'fallthrough';
    },
    directControlTarget(instruction) {
      return Object.hasOwn(targets, instruction.address.toString())
        ? targets[instruction.address.toString()]
        : null;
    },
  });
}

function instruction(address, kind, target) {
  const kinds = {};
  const targets = {};
  kinds[address.toString()] = kind;
  if (target != null) targets[address.toString()] = target;
  return { address, length: 4n, mode: 'test', mnemonic: kind, kinds, targets };
}

function functionOf(instructions) {
  const kinds = {};
  const targets = {};
  for (const item of instructions) {
    kinds[item.address.toString()] = item.kinds[item.address.toString()];
    if (item.targets[item.address.toString()] != null) targets[item.address.toString()] = item.targets[item.address.toString()];
  }
  return {
    decoded: instructions.map((item) => ({ address: item.address, length: 4n, mode: 'test', mnemonic: 'x' })),
    architecture: plugin({ kinds, targets }),
  };
}

// `completeness` as published by both routes.
const derivedCompleteness = (blocks, architecture) =>
  semanticControlUnknowns(blocks, architecture).length ? 'partial' : 'complete';

test('#9005 A: an exact unconditional branch into an internal decoded hole is a control unknown', () => {
  // 0x1000: b 0x1008 (missing); 0x1004: ret; 0x100c: ret  => span [0x1000, 0x1010)
  const { decoded, architecture } = functionOf([
    instruction(0x1000n, 'branch', 0x1008n),
    instruction(0x1004n, 'return'),
    instruction(0x100cn, 'return'),
  ]);
  const blocks = partitionDecodedFunction(decoded, architecture);
  const unknowns = semanticControlUnknowns(blocks, architecture);
  assert.equal(blocks.find((block) => block.startAddress === 0x1000n).successors.length, 0,
    'the partitioner still mints no definite edge for an undecoded target');
  assert.equal(unknowns.length, 1);
  assert.deepEqual(unknowns[0], {
    reason: 'semantic-cfg-missing-direct-target',
    categories: ['control'],
    detail: {
      blockKey: 'block-1000',
      instructionAddress: '4096',
      missingTarget: '4104',
    },
  });
  assert.equal(derivedCompleteness(blocks, architecture), 'partial',
    'an empty placeholder target must not launder the artifact into complete');
});

test('#9005 B: a conditional taken target that is missing is checked independently of a valid fallthrough', () => {
  // 0x1000: b.cond 0x1008 (missing); 0x1004: ret (valid false path); 0x100c: ret
  const { decoded, architecture } = functionOf([
    instruction(0x1000n, 'conditional-branch', 0x1008n),
    instruction(0x1004n, 'return'),
    instruction(0x100cn, 'return'),
  ]);
  const blocks = partitionDecodedFunction(decoded, architecture);
  const unknowns = semanticControlUnknowns(blocks, architecture);
  assert.equal(unknowns.length, 1);
  assert.equal(unknowns[0].reason, 'semantic-cfg-missing-direct-target');
  assert.equal(unknowns[0].detail.missingTarget, '4104');
  assert.equal(unknowns.some((unknown) => unknown.reason === 'semantic-cfg-missing-fallthrough'), false,
    'the valid false path stays complete; only the missing taken path is reported');
  assert.equal(derivedCompleteness(blocks, architecture), 'partial');
});

test('#9005: a conditional missing BOTH taken target and fallthrough reports both unknowns', () => {
  // 0x1000: b.cond 0x1008 (missing); 0x1004 gap; 0x100c: ret  => fallthrough 0x1004 also absent
  const { decoded, architecture } = functionOf([
    instruction(0x1000n, 'conditional-branch', 0x1008n),
    instruction(0x100cn, 'return'),
  ]);
  const blocks = partitionDecodedFunction(decoded, architecture);
  const reasons = semanticControlUnknowns(blocks, architecture).map((unknown) => unknown.reason).sort();
  assert.deepEqual(reasons, ['semantic-cfg-missing-direct-target', 'semantic-cfg-missing-fallthrough']);
});

test('#9005: a present taken target stays complete', () => {
  const { decoded, architecture } = functionOf([
    instruction(0x1000n, 'branch', 0x1004n),
    instruction(0x1004n, 'return'),
  ]);
  const blocks = partitionDecodedFunction(decoded, architecture);
  assert.deepEqual(semanticControlUnknowns(blocks, architecture), []);
  assert.equal(derivedCompleteness(blocks, architecture), 'complete');
});

test('#9005: a conditional with a decoded taken target and decoded fallthrough stays complete', () => {
  const { decoded, architecture } = functionOf([
    instruction(0x1000n, 'conditional-branch', 0x1008n),
    instruction(0x1004n, 'return'),
    instruction(0x1008n, 'return'),
  ]);
  const blocks = partitionDecodedFunction(decoded, architecture);
  assert.deepEqual(semanticControlUnknowns(blocks, architecture), []);
  assert.equal(derivedCompleteness(blocks, architecture), 'complete');
});

test('#9005: a direct target outside the local decoded span stays a legitimate external/tail edge', () => {
  // span [0x1000, 0x1008); tail branch to 0x9000 is external -> no unknown.
  const { decoded, architecture } = functionOf([
    instruction(0x1000n, 'branch', 0x9000n),
    instruction(0x1004n, 'return'),
  ]);
  const blocks = partitionDecodedFunction(decoded, architecture);
  assert.deepEqual(semanticControlUnknowns(blocks, architecture), [],
    'a target beyond the observed span must not be laundered into a false internal hole');
});

test('#9005: the public partitioner route reports the same missing internal target', () => {
  const { decoded, architecture } = functionOf([
    instruction(0x1000n, 'branch', 0x1008n),
    instruction(0x1004n, 'return'),
    instruction(0x100cn, 'return'),
  ]);
  const blocks = partitionPublic(decoded, architecture);
  const unknowns = semanticControlUnknowns(blocks, architecture);
  assert.equal(unknowns.length, 1);
  assert.equal(unknowns[0].reason, 'semantic-cfg-missing-direct-target');
});
