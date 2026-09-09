import assert from 'node:assert/strict';
import test from 'node:test';

import { structureKnownSwitches } from '../../../js/decompiler/switch.js';

/**
 * #5487: the switch structurer used two different integer grammars. caseLiteral
 * accepted '-0x1' (its regex allowed a sign in front of a hex magnitude) while
 * caseIdentity re-parsed the same literal with BigInt, which throws on '-0x1'.
 * A verified descriptor whose case values were merely spelled in negative-hex
 * notation was therefore silently skipped — notation alone decided verified
 * structuring.
 */

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
  structureKnownSwitches(result, model, { switches: [{ row: 5, expr: 'x0', cases, ...extra }] });
  return result;
}

function assertNotStructured(result) {
  assert.equal(result.ctx.structuredSwitches, undefined);
  assert.ok(!result.lines.some((line) => /^switch \(/.test(line.text || '')));
  assert.ok(!result.evidence.some((entry) => entry.op === 'switch'));
}

test('#5487: a negative-hex case literal structures like its decimal spelling', () => {
  const result = run([{ value: '-0x1', block: 0 }, { value: 0, block: 1 }]);
  assert.equal(result.ctx.structuredSwitches, 1);
  assert.ok(result.lines.some((line) => line.text === 'case -0x1: goto loc_1000;'));
  assert.ok(result.evidence.some((entry) => entry.op === 'switch' && entry.reason === 'verified jump-table/switch descriptor'));
});

test('#5487: notation cannot launder duplicate case values', () => {
  const result = run([{ value: '-0x1', block: 0 }, { value: '-1', block: 1 }]);
  assertNotStructured(result);
  assert.ok(result.evidence.some((entry) => entry.op === 'switch-conflict'
    && entry.reason === 'duplicate case values after width-aware integer canonicalization'));
});

test('#5487: negative hex follows the same width-aware identity as decimals', () => {
  const result = run([{ value: '-0x1', block: 0 }, { value: 255, block: 1 }], { valueBits: 8 });
  assertNotStructured(result);
  assert.ok(result.evidence.some((entry) => entry.op === 'switch-conflict'),
    'asUintN(8, -1n) and 255 are the same case after canonicalization');
});

test('#5487: malformed signed strings are still rejected', () => {
  for (const malformed of ['--1', '- 0x1', '+1', '-0x', '-', '0x-1', '1e3']) {
    const result = run([{ value: malformed, block: 0 }, { value: 0, block: 1 }]);
    assertNotStructured(result);
  }
});

test('#5487: positive hex, decimal and bigint spellings keep structuring', () => {
  assert.equal(run([{ value: '0x1', block: 0 }, { value: 0x2, block: 1 }]).ctx.structuredSwitches, 1);
  assert.equal(run([{ value: '-1', block: 0 }, { value: 0, block: 1 }]).ctx.structuredSwitches, 1);
  assert.equal(run([{ value: -1n, block: 0 }, { value: 0n, block: 1 }]).ctx.structuredSwitches, 1);
});
