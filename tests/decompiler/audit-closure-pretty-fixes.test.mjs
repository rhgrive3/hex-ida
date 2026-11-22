import assert from 'node:assert/strict';
import test from 'node:test';

import { eliminateAvoidableGotos } from '../../js/decompiler/goto-closure.js';
import { registerSemanticControlLineHistory } from '../../js/decompiler/semantic-core.js';
import { structureKnownSwitches } from '../../js/decompiler/switch.js';
import { repairCanonicalPostTestLoop } from '../../js/decompiler/loop-repair.js';
import { closeFunctionOutput, scanIdentifierUses } from '../../js/decompiler/c-output-closure.js';
import { printExpression } from '../../js/decompiler/pretty/c.js';
import { reachingRegisterTypeValue } from '../../js/decompiler/type-recovery.js';
import { expr } from '../../js/decompiler/ast/nodes.js';
import { OP } from '../../js/ir.js';

const renderLines = (lines) => lines.map((l) => `${'    '.repeat(Math.max(0, l.indent || 0))}${l.text || ''}`).join('\n');

// 1. [HIGH] goto-closure.js: backwardLoopProof dominator direction
test('Fix 1: backwardLoopProof wraps multi-block natural loops when header dominates latch', () => {
  const labelLine = { kind: 'label', indent: 1, text: 'loc_100:', row: 0, addr: 0x100n, note: null };
  const bodyLine = { kind: 'stmt', indent: 2, text: 'x = x + 1;', row: 1, addr: 0x104n, note: null };
  const jumpLine = { kind: 'stmt', indent: 2, text: 'goto loc_100;', row: 2, addr: 0x108n, note: null };
  const jumpInst = { id: 10, op: OP.BR, block: 1, row: 2, address: 0x108n };

  const ir = {
    blocks: [
      { id: 0, startRow: 0, endRow: 1 },
      { id: 1, startRow: 2, endRow: 2 },
    ],
    instructions: [jumpInst],
    values: [],
    loops: [{ header: 0, latches: new Set([1]), nodes: new Set([0, 1]) }],
    // dominators[X] is the set of blocks that dominate X:
    // header (0) dominates latch (1), latch (1) does NOT dominate header (0).
    dominators: [new Set([0]), new Set([0, 1])],
  };

  registerSemanticControlLineHistory(labelLine, {
    ir, selection: { target: 0 }, canonical: { isCurrent: () => true }, records: [], isCurrent: () => true,
  });
  registerSemanticControlLineHistory(jumpLine, {
    ir, instruction: jumpInst, canonical: { isCurrent: () => true }, records: [], isCurrent: () => true,
  });

  const result = { semantic: true, ir, lines: [labelLine, bodyLine, jumpLine], warnings: [] };
  const out = eliminateAvoidableGotos(result, {});
  const text = out.pseudocode ?? renderLines(out.lines);
  assert.match(text, /while \(1\) \{/);
  assert.doesNotMatch(text, /goto loc_100;/);
});

test('Fix 1: backwardLoopProof rejects non-dominating latch even if backEdges lists it', () => {
  const labelLine = { kind: 'label', indent: 1, text: 'loc_100:', row: 0, addr: 0x100n, note: null };
  const bodyLine = { kind: 'stmt', indent: 2, text: 'x = x + 1;', row: 1, addr: 0x104n, note: null };
  const jumpLine = { kind: 'stmt', indent: 2, text: 'goto loc_100;', row: 2, addr: 0x108n, note: null };
  const jumpInst = { id: 11, op: OP.BR, block: 1, row: 2, address: 0x108n };

  const ir = {
    blocks: [
      { id: 0, startRow: 0, endRow: 1 },
      { id: 1, startRow: 2, endRow: 2 },
    ],
    instructions: [jumpInst],
    values: [],
    loops: [{ header: 0, latches: new Set([1]), nodes: new Set([0, 1]) }],
    // Header 0 does NOT dominate latch 1.
    dominators: [new Set([0]), new Set([1])],
  };

  registerSemanticControlLineHistory(labelLine, {
    ir, selection: { target: 0 }, canonical: { isCurrent: () => true }, records: [], isCurrent: () => true,
  });
  registerSemanticControlLineHistory(jumpLine, {
    ir, instruction: jumpInst, canonical: { isCurrent: () => true }, records: [], isCurrent: () => true,
  });

  const result = { semantic: true, ir, lines: [labelLine, bodyLine, jumpLine], warnings: [] };
  const out = eliminateAvoidableGotos(result, {});
  const text = out.pseudocode ?? renderLines(out.lines);
  assert.doesNotMatch(text, /while \(1\) \{/);
  assert.match(text, /goto loc_100;/);
});

// 2. [HIGH] switch.js: terminalSwitchCasePlan rejects fallthrough into case label
test('Fix 2: terminalSwitchCasePlan keeps goto form when preceding statement falls through into a case label', () => {
  const result = {
    ir: { instructions: [], blocks: [] },
    lines: [
      { kind: 'sig', indent: 0, text: 'int f(int x)', row: 0, addr: 0x100n },
      { kind: 'ctrl', indent: 0, text: '{', row: 0, addr: 0x100n },
      { kind: 'stmt', indent: 1, text: '__asm("br x8");', row: 1, addr: 0x104n },
      { kind: 'stmt', indent: 1, text: 'x = 42;', row: 2, addr: 0x108n },
      { kind: 'label', indent: 1, text: 'loc_200:', row: 3, addr: 0x200n },
      { kind: 'stmt', indent: 2, text: 'return x;', row: 3, addr: 0x200n },
      { kind: 'label', indent: 1, text: 'loc_210:', row: 4, addr: 0x210n },
      { kind: 'stmt', indent: 2, text: 'return 0;', row: 4, addr: 0x210n },
      { kind: 'label', indent: 1, text: 'loc_220:', row: 5, addr: 0x220n },
      { kind: 'stmt', indent: 2, text: 'return -1;', row: 5, addr: 0x220n },
      { kind: 'ctrl', indent: 0, text: '}', row: 6, addr: 0x224n },
    ],
  };
  const model = {
    instructions: [
      { row: 1, address: 0x104n },
      { row: 2, address: 0x108n },
      { row: 3, address: 0x200n },
      { row: 4, address: 0x210n },
      { row: 5, address: 0x220n },
    ],
  };
  structureKnownSwitches(result, model, {
    switches: [{
      row: 1,
      expr: 'x',
      cases: [
        { value: 0, address: 0x200n },
        { value: 1, address: 0x210n },
      ],
      defaultAddress: 0x220n,
    }],
  });
  // Because `x = 42;` falls through into `loc_200:`, `loc_200:` must NOT be spliced away.
  assert.match(result.pseudocode, /case 0: goto loc_200;/);
  assert.match(result.pseudocode, /x = 42;\s*\n\s*loc_200:\s*\n\s*return x;/);
});

test('Fix 2: terminalSwitchCasePlan still inlines terminal cases when no statement falls through', () => {
  const result = {
    ir: { instructions: [], blocks: [] },
    lines: [
      { kind: 'sig', indent: 0, text: 'int f(int x)', row: 0, addr: 0x100n },
      { kind: 'ctrl', indent: 0, text: '{', row: 0, addr: 0x100n },
      { kind: 'stmt', indent: 1, text: '__asm("br x8");', row: 1, addr: 0x104n },
      { kind: 'label', indent: 1, text: 'loc_200:', row: 3, addr: 0x200n },
      { kind: 'stmt', indent: 2, text: 'return x;', row: 3, addr: 0x200n },
      { kind: 'label', indent: 1, text: 'loc_210:', row: 4, addr: 0x210n },
      { kind: 'stmt', indent: 2, text: 'return 0;', row: 4, addr: 0x210n },
      { kind: 'label', indent: 1, text: 'loc_220:', row: 5, addr: 0x220n },
      { kind: 'stmt', indent: 2, text: 'return -1;', row: 5, addr: 0x220n },
      { kind: 'ctrl', indent: 0, text: '}', row: 6, addr: 0x224n },
    ],
  };
  const model = {
    instructions: [
      { row: 1, address: 0x104n },
      { row: 3, address: 0x200n },
      { row: 4, address: 0x210n },
      { row: 5, address: 0x220n },
    ],
  };
  structureKnownSwitches(result, model, {
    switches: [{
      row: 1,
      expr: 'x',
      cases: [
        { value: 0, address: 0x200n },
        { value: 1, address: 0x210n },
      ],
      defaultAddress: 0x220n,
    }],
  });
  assert.match(result.pseudocode, /case 0:\s*\n\s*return x;/);
  assert.doesNotMatch(result.pseudocode, /goto loc_200;/);
});

// 3. [HIGH] loop-repair.js: retain non-adjacent exit goto & emit kind:'decl'
function makePostTestLoopFixture(lines) {
  const initVal = { id: 1, const: 0n, bits: 64 };
  const stepConst = { id: 2, const: 1n, bits: 64 };
  const limitConst = { id: 3, const: 10n, bits: 64 };
  const phiVal = { id: 4, bits: 64, def: null };
  const nextVal = { id: 5, bits: 64, def: null };
  const flagsVal = { id: 6, bits: 32, reg: 'nzcv', def: null };

  const phiInst = {
    id: 10, op: OP.PHI, block: 1, row: 1, dst: phiVal,
    incoming: [{ from: 0, value: initVal }, { from: 1, value: nextVal }],
  };
  const addInst = {
    id: 11, op: OP.BIN, sub: 'add', block: 1, row: 2, dst: nextVal,
    args: [{ value: phiVal }, { value: stepConst }],
  };
  const cmpInst = {
    id: 12, op: OP.CMP, sub: 'sub', block: 1, row: 3, bits: 64, dst: flagsVal,
    args: [{ value: nextVal }, { value: limitConst }],
  };
  const cbrInst = {
    id: 13, op: OP.CBR, cond: 'lt', block: 1, row: 4, address: 0x10Cn,
    extra: { target: 0x100n, cond: 'lt' },
    args: [{ value: flagsVal }],
  };
  phiVal.def = phiInst;
  nextVal.def = addInst;
  flagsVal.def = cmpInst;

  return {
    semantic: true,
    ir: {
      blocks: [
        { id: 0, startRow: 0, endRow: 0, succ: [1], insts: [] },
        { id: 1, startRow: 1, endRow: 4, succ: [1, 2], insts: [phiInst, addInst, cmpInst, cbrInst] },
        { id: 2, startRow: 6, endRow: 6, succ: [], insts: [] },
      ],
      loops: [{ header: 1, nodes: new Set([1]), exits: new Set([2]) }],
    },
    lines,
  };
}

test('Fix 3: repairCanonicalPostTestLoop retains exit goto when target label is not adjacent and emits kind:decl', () => {
  const result = makePostTestLoopFixture([
    { kind: 'sig', indent: 0, text: 'void sub_1000(void)', row: 0, addr: 0x100n },
    { kind: 'ctrl', indent: 0, text: '{', row: 0, addr: 0x100n },
    { kind: 'label', indent: 1, text: 'loc_100:', row: 1, addr: 0x100n },
    { kind: 'ctrl', indent: 1, text: 'if (cond) goto loc_100;', row: 4, addr: 0x10Cn },
    { kind: 'stmt', indent: 1, text: 'goto loc_200;', row: 4, addr: 0x110n },
    { kind: 'stmt', indent: 1, text: 'other_block();', row: 5, addr: 0x114n },
    { kind: 'label', indent: 1, text: 'loc_200:', row: 6, addr: 0x200n },
    { kind: 'stmt', indent: 1, text: 'return;', row: 6, addr: 0x200n },
    { kind: 'ctrl', indent: 0, text: '}', row: 6, addr: 0x204n },
  ]);

  repairCanonicalPostTestLoop(result, (b) => (b === 1 ? 0x100n : 0x200n));
  // Exit goto must be preserved because `other_block();` sits between loop and `loc_200:`.
  assert.match(result.pseudocode, /\} while \(.+?\);\s*\n\s*goto loc_200;\s*\n\s*other_block\(\);/);
  // Loop induction variable declaration must have kind: 'decl'.
  const declLine = result.lines.find((l) => l.text === 'int64 i = 0;');
  assert.ok(declLine, 'expected int64 i = 0; line');
  assert.equal(declLine.kind, 'decl');

  // Running closeFunctionOutput must NOT emit a duplicate `uint64 i;`.
  closeFunctionOutput(result);
  assert.doesNotMatch(result.pseudocode, /\buint64 i;/);
});

test('Fix 3: repairCanonicalPostTestLoop still drops redundant exit goto when target label immediately follows', () => {
  const result = makePostTestLoopFixture([
    { kind: 'sig', indent: 0, text: 'void sub_1000(void)', row: 0, addr: 0x100n },
    { kind: 'ctrl', indent: 0, text: '{', row: 0, addr: 0x100n },
    { kind: 'label', indent: 1, text: 'loc_100:', row: 1, addr: 0x100n },
    { kind: 'ctrl', indent: 1, text: 'if (cond) goto loc_100;', row: 4, addr: 0x10Cn },
    { kind: 'stmt', indent: 1, text: 'goto loc_200;', row: 4, addr: 0x110n },
    { kind: 'label', indent: 1, text: 'loc_200:', row: 6, addr: 0x200n },
    { kind: 'stmt', indent: 1, text: 'return;', row: 6, addr: 0x200n },
    { kind: 'ctrl', indent: 0, text: '}', row: 6, addr: 0x204n },
  ]);

  repairCanonicalPostTestLoop(result, (b) => (b === 1 ? 0x100n : 0x200n));
  assert.doesNotMatch(result.pseudocode, /goto loc_200;/);
  assert.match(result.pseudocode, /\} while \(.+?\);\s*\n\s*loc_200:/);
});

// 4. [HIGH] c-output-closure.js: bool keyword, non-pointer casts, signature types, stmt-kind decls
test('Fix 4: closeFunctionOutput never declares bool, custom signature/cast types, or stmt-kind locals', () => {
  const result = {
    lines: [
      { kind: 'sig', indent: 0, text: 'bool sub_1000(MyClass *a1, MyParam a2)' },
      { kind: 'ctrl', indent: 0, text: '{' },
      { kind: 'stmt', indent: 1, text: 'int64 i = 0;' },
      { kind: 'stmt', indent: 1, text: 'x = (MyType)a2;' },
      { kind: 'stmt', indent: 1, text: 'i++;' },
      { kind: 'stmt', indent: 1, text: 'if (flag) return true;' },
      { kind: 'stmt', indent: 1, text: 'return false;' },
      { kind: 'ctrl', indent: 0, text: '}' },
    ],
  };
  closeFunctionOutput(result);
  assert.doesNotMatch(result.pseudocode, /\buint64 bool;/);
  assert.doesNotMatch(result.pseudocode, /\buint64 MyClass;/);
  assert.doesNotMatch(result.pseudocode, /\buint64 MyParam;/);
  assert.doesNotMatch(result.pseudocode, /\buint64 MyType;/);
  assert.doesNotMatch(result.pseudocode, /\buint64 i;/);
  // Real undeclared locals (`x`, `flag`) must still be declared!
  assert.match(result.pseudocode, /\buint64 x;/);
  assert.match(result.pseudocode, /\buint64 flag;/);
});

test('Fix 4: scanIdentifierUses distinguishes non-pointer casts from if/while conditions', () => {
  const uses = scanIdentifierUses('if (cond) x = (MyType)y;');
  assert.equal(uses.get('MyType')?.castType, true);
  assert.equal(uses.get('MyType')?.value, false);
  assert.equal(uses.get('cond')?.castType, false);
  assert.equal(uses.get('cond')?.value, true);
});

// 5. [HIGH] pretty/c.js: guardedDivision casts operands for signedness and avoids duplicating side-effecting divisors
test('Fix 5: guardedDivision casts operands to signed/unsigned division type and avoids double-evaluating calls', () => {
  const ux = expr.variable('x', 64, false);
  const uy = expr.variable('y', 64, false);
  const sdivText = printExpression(expr.binary('sdiv', ux, uy, 64, true));
  assert.match(sdivText, /\(int64_t\)x \/ \(int64_t\)y/);

  const sx = expr.variable('sx', 64, true);
  const sy = expr.variable('sy', 64, true);
  const udivText = printExpression(expr.binary('udiv', sx, sy, 64, false));
  assert.match(udivText, /\(uint64_t\)sx \/ \(uint64_t\)sy/);

  const callDiv = expr.call('get_div', [], 64);
  const callSdivText = printExpression(expr.binary('sdiv', ux, callDiv, 64, true));
  const callMatches = callSdivText.match(/get_div\(\)/g) || [];
  assert.equal(callMatches.length, 1, `expected get_div() once, got: ${callSdivText}`);
  assert.match(callSdivText, /\(int64_t\)x \/ __div/);
});

// 6. [MEDIUM] pretty/c.js: exactUnsignedType/exactSignedType for 128-bit and 1-bit casts + precedence wrapping
test('Fix 6: printExpression avoids invalid uint128_t/uint1_t casts and wraps casts inside field access', () => {
  const p = expr.variable('p', 64, false);
  const trunc128 = expr.unary('trunc', p, 128, false);
  const trunc128Text = printExpression(trunc128);
  assert.doesNotMatch(trunc128Text, /\buint128_t\b/);
  assert.match(trunc128Text, /\(unsigned __int128\)p/);

  const sext128Text = printExpression(expr.unary('sext', p, 128, true));
  assert.doesNotMatch(sext128Text, /\bint128_t\b/);
  assert.match(sext128Text, /\(__int128\)p/);

  const zext1Text = printExpression(expr.unary('zext', p, 1, false));
  assert.doesNotMatch(zext1Text, /\buint1_t\b/);
  assert.match(zext1Text, /\(uint8_t\)p/);

  // Cast inside field access must be parenthesized so `->` binds to the cast result.
  const fieldOnTrunc = expr.field(trunc128, 'hp', 8n, 64);
  assert.equal(printExpression(fieldOnTrunc), '((unsigned __int128)p)->hp');

  // printIntegerView for 128-bit compare operands must also avoid uint128_t/int128_t.
  const cmp128 = expr.compare('lt', expr.variable('a', 128, null), expr.variable('b', 128, null), false);
  const cmp128Text = printExpression(cmp128);
  assert.doesNotMatch(cmp128Text, /\buint128_t\b/);
  assert.match(cmp128Text, /\(unsigned __int128\)a < \(unsigned __int128\)b/);
});

// 7. [MEDIUM] type-recovery.js: reachingRegisterTypeValue tie-break by highest def.row
test('Fix 7: reachingRegisterTypeValue prefers latest definition in the same dominating block', () => {
  const v1 = { id: 1, reg: 'x0', def: { id: 1, block: 0, row: 1 } };
  const v2 = { id: 2, reg: 'x0', def: { id: 2, block: 0, row: 5 } };
  const v0 = { id: 3, reg: 'x0', def: { id: 3, block: 0, row: 2 } };
  const ir = {
    blocks: [{ id: 0, idom: -1 }, { id: 1, idom: 0 }],
    dominators: [new Set([0]), new Set([0, 1])],
    idom: [-1, 0],
    values: [v1, v2, v0],
  };
  const atInst = { id: 10, block: 1, row: 10 };
  const picked = reachingRegisterTypeValue(ir, atInst, 'x0');
  assert.equal(picked?.id, 2, `expected latest row def v2 (row 5), got id ${picked?.id}`);
});
