import assert from 'node:assert/strict';
import test from 'node:test';

import { structureKnownSwitches } from '../../../js/decompiler/switch.js';

function run(cases, extra = {}) {
  const result = {
    lines: [
      { kind: 'stmt', row: 5, indent: 1, text: '__asm("br x0");' },
      { kind: 'stmt', row: 10, indent: 1, text: 'A();' },
      { kind: 'stmt', row: 20, indent: 1, text: 'B();' },
      { kind: 'ctrl', row: 30, indent: 0, text: '}' },
    ],
    ir: { blocks: [{ startRow: 10 }, { startRow: 20 }] },
    evidence: [],
    warnings: [],
    ctx: {},
  };
  const model = { instructions: [{ row: 10, address: 0x1000n }, { row: 20, address: 0x2000n }] };
  structureKnownSwitches(result, model, {
    switches: [{ row: 5, expr: 'x0', cases, ...extra }],
  });
  return result;
}

function assertNotStructured(result) {
  assert.equal(result.ctx.structuredSwitches, undefined);
  assert.ok(!result.lines.some((line) => /^switch \(/.test(line.text || '')));
  assert.ok(!result.evidence.some((entry) => entry.op === 'switch'));
}

test('#5926: primitive block indices still resolve through the verified path', () => {
  const result = run([{ value: 0, block: 0 }, { value: 1, block: 1 }]);
  assert.equal(result.ctx.structuredSwitches, 1);
  assert.ok(result.lines.some((line) => line.text === 'case 0: goto loc_1000;'));
  assert.ok(result.lines.some((line) => line.text === 'case 1: goto loc_2000;'));
  assert.ok(result.evidence.some((entry) => entry.op === 'switch' && entry.reason === 'verified jump-table/switch descriptor'));
});

test('#5926: structured case.block values are rejected as block identity', () => {
  for (const malformed of [[0], [['1']], [true], [{ index: 0 }]]) {
    const result = run([{ value: 0, block: malformed }, { value: 1, block: 1 }]);
    assertNotStructured(result);
  }
});

test('#5926: non-integer, negative, fractional and non-finite block values are rejected', () => {
  for (const malformed of ['1', true, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = run([{ value: 0, block: malformed }, { value: 1, block: 1 }]);
    assertNotStructured(result);
  }
});

test('#5926: malformed defaultBlock fails closed instead of coercing', () => {
  for (const defaultBlock of [['1'], '1', true]) {
    const result = run([{ value: 0, block: 0 }, { value: 1, block: 1 }], { defaultBlock });
    assertNotStructured(result);
    assert.ok(result.evidence.some((entry) => entry.op === 'switch-conflict' && entry.reason === 'invalid or unresolved explicit default target'));
  }
});

test('#5926: valid defaultBlock keeps working and direct address paths are untouched', () => {
  const blockDefault = run([{ value: 0, block: 0 }, { value: 1, block: 1 }], { defaultBlock: 1 });
  assert.equal(blockDefault.ctx.structuredSwitches, 1);
  assert.ok(blockDefault.lines.some((line) => line.text === 'default: goto loc_2000;'));

  const addressCases = run([{ value: 0, address: 0x1000n }, { value: 1, target: 0x2000n }]);
  assert.equal(addressCases.ctx.structuredSwitches, 1);
  assert.ok(addressCases.lines.some((line) => line.text === 'case 1: goto loc_2000;'));
});
