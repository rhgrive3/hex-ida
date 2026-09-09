import assert from 'node:assert/strict';
import test from 'node:test';

import { structureKnownSwitches } from '../../../js/decompiler/switch.js';

// #5535: labels must not be spliced into result.lines before the switch
// replacement is known to be placeable. When the switch row itself has no
// matching output line (insertionIndex -> null), the mutated lines array
// would otherwise diverge from result.pseudocode.

test('#5535 a switch whose insertion point is missing leaves lines untouched', () => {
  const result = {
    lines: [
      { kind: 'stmt', row: 10, indent: 1, text: 'x = 1;' },
      { kind: 'stmt', row: 11, indent: 1, text: 'y = 2;' },
      { kind: 'ctrl', row: null, indent: 0, text: '}' },
    ],
    pseudocode: '    x = 1;\n    y = 2;\n}',
    ir: { blocks: [] },
    evidence: [],
    warnings: [],
    ctx: {},
  };
  const model = {
    instructions: [
      { row: 10, address: 0x1000n },
      { row: 11, address: 0x1004n },
    ],
    switches: [{
      row: 5,
      cases: [
        { value: 0, address: 0x1000n },
        { value: 1, address: 0x1004n },
      ],
    }],
  };

  structureKnownSwitches(result, model);

  assert.equal(result.ctx.structuredSwitches, undefined, 'no switch may be published');
  assert.equal(result.lines.filter((line) => line.kind === 'label').length, 0,
    `labels leaked into lines before the replacement point was known: ${JSON.stringify(result.lines)}`);
  assert.equal(result.pseudocode, '    x = 1;\n    y = 2;\n}',
    'pseudocode must stay consistent with lines');
  assert.ok(!result.lines.some((line) => /^switch \(/.test(line.text || '')));
});

test('#5535 a placeable switch still materializes its labels and structures', () => {
  const result = {
    lines: [
      { kind: 'stmt', row: 5, indent: 1, text: '__asm("br x8");' },
      { kind: 'stmt', row: 10, indent: 1, text: 'case0_body();' },
      { kind: 'ctrl', row: null, indent: 0, text: '}' },
    ],
    pseudocode: '    __asm("br x8");\n    case0_body();\n}',
    ir: { blocks: [] },
    evidence: [],
    warnings: [],
    ctx: {},
  };
  const model = {
    instructions: [
      { row: 5, address: 0x1000n },
      { row: 10, address: 0x1004n },
    ],
    switches: [{
      row: 5,
      cases: [
        { value: 0, address: 0x1004n },
        { value: 1, address: 0x1000n },
      ],
    }],
  };

  structureKnownSwitches(result, model);

  assert.equal(result.ctx.structuredSwitches, 1);
  assert.ok(result.lines.some((line) => /^switch \(/.test(line.text || '')));
  assert.equal(result.pseudocode, result.lines.map((line) => `${'    '.repeat(line.indent || 0)}${line.text}`).join('\n').trimEnd() || result.pseudocode,
    'lines and pseudocode must not diverge');
});
