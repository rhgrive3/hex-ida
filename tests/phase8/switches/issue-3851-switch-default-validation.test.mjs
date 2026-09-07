import assert from 'node:assert/strict';
import test from 'node:test';

import { structureKnownSwitches } from '../../../js/decompiler/switch.js';

function run(overrides = {}, { instructions = null, blocks = [] } = {}) {
  const result = {
    lines: [
      { row: 0, kind: 'stmt', indent: 1, text: '__asm("br x8");' },
      { row: 1, kind: 'stmt', indent: 1, text: 'case0_body();' },
      { row: 2, kind: 'stmt', indent: 1, text: 'case1_body();' },
      { row: 3, kind: 'stmt', indent: 1, text: 'default_body();' },
      { row: 4, kind: 'ctrl', indent: 0, text: '}' },
    ],
    ir: { blocks },
    evidence: [],
    warnings: [],
    ctx: {},
  };
  const model = {
    instructions: instructions || [
      { row: 1, address: 0x1004n },
      { row: 2, address: 0x1008n },
      { row: 3, address: 0x100cn },
    ],
  };
  const sw = {
    row: 0,
    expr: 'x0',
    cases: [
      { value: 0, address: 0x1004n },
      { value: 1, address: 0x1008n },
    ],
    ...overrides,
  };
  structureKnownSwitches(result, model, { switches: [sw] });
  return result;
}

function assertNotStructured(result) {
  assert.equal(result.ctx.structuredSwitches, undefined);
  assert.equal(result.lines[0].text, '__asm("br x8");');
  assert.ok(!result.lines.some((line) => /^switch \(/.test(line.text || '')));
}

test('#3851/#4906: valid explicit default remains structured', () => {
  const result = run({ defaultAddress: 0x100cn });
  assert.equal(result.ctx.structuredSwitches, 1);
  assert.ok(result.lines.some((line) => line.text === 'default: goto loc_100C;'));
  assert.ok(result.evidence.some((entry) => entry.op === 'switch'));
});

test('#3851/#4906: descriptor without a default remains eligible', () => {
  const result = run();
  assert.equal(result.ctx.structuredSwitches, 1);
  assert.ok(!result.lines.some((line) => /^default:/.test(line.text || '')));
});

test('#3851/#4906: malformed explicit default fails closed', () => {
  const result = run({ defaultAddress: 'not-an-address' });
  assertNotStructured(result);
  assert.ok(result.warnings.some((warning) => /explicit default target is invalid or unresolved/.test(warning)));
  assert.ok(result.evidence.some((entry) => entry.op === 'switch-conflict' && entry.reason === 'invalid or unresolved explicit default target'));
});

test('#3851/#4906: unresolved explicit defaultBlock fails closed', () => {
  const result = run({ defaultBlock: 99 }, { blocks: [{ startRow: 3 }] });
  assertNotStructured(result);
  assert.ok(result.evidence.some((entry) => entry.op === 'switch-conflict'));
});

test('#3851/#4906: explicit default must still be an exact instruction target', () => {
  const result = run({ defaultAddress: 0x1010n });
  assertNotStructured(result);
  assert.ok(result.warnings.some((warning) => /exact instruction addresses/.test(warning)));
});

test('#3851/#4906: case target exact-address validation is unchanged', () => {
  const result = run({ cases: [
    { value: 0, address: 0x1004n },
    { value: 1, address: 0x1010n },
  ] });
  assertNotStructured(result);
  assert.ok(result.warnings.some((warning) => /exact instruction addresses/.test(warning)));
});
