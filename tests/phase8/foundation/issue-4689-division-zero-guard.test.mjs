import assert from 'node:assert/strict';
import test from 'node:test';

import { expr } from '../../../js/decompiler/ast/nodes.js';
import { printExpression } from '../../../js/decompiler/pretty/c.js';

test('#4689 printed machine division guards the architectural zero-divisor result', () => {
  const udiv = expr.binary('udiv', expr.variable('x0'), expr.variable('x1'), 64, false);
  const udivText = printExpression(udiv);
  assert.match(udivText, /== 0 \? 0 :/, `udiv must restore the architectural result 0 on zero divisor: ${udivText}`);
  assert.ok(!/\/ 0\b/.test(udivText), 'no bare division by a printed zero');

  const sdiv = expr.binary('sdiv', expr.variable('x0'), expr.variable('x1'), 32, true);
  const sdivText = printExpression(sdiv);
  assert.match(sdivText, /== 0 \? 0 :/, `sdiv must restore the architectural result 0: ${sdivText}`);
  assert.match(sdivText, /int32_t/, 'the signed view stays on the result');
});

test('#4689 a constant-zero divisor is folded away, never printed as `/ 0`', () => {
  const zeroDiv = expr.binary('udiv', expr.variable('x0'), expr.constant(0n, 32, false), 32, false);
  const text = printExpression(zeroDiv);
  assert.ok(!/\/\s*0\b/.test(text), `constant zero divisor must not be printed as a C division: ${text}`);
});

test('#4689 non-division operations are unchanged', () => {
  const add = expr.binary('add', expr.variable('x0'), expr.variable('x1'), 32, false);
  assert.equal(printExpression(add), 'x0 + x1');
  const smod = expr.binary('smod', expr.variable('x0'), expr.variable('x1'), 32, true);
  assert.match(printExpression(smod), / % /);
});
