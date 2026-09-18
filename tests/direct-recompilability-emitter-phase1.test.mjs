import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSemanticModel } from '../js/blocks.js';
import { decompile } from '../js/decompile.js';
import { ensureLegacyGotoForTesting, ensureLegacyLabelForTesting } from '../js/decompile-base.js';
import { decompileSemantic } from '../js/decompiler/semantic-core.js';

function modelOf(rows, { name = 'fixture', base = 0x710000n } = {}) {
  const raw = rows.map((entry, row) => ({
    row,
    address: BigInt(entry.address ?? (base + BigInt(row * 4))),
    mn: entry.mn,
    ops: entry.ops || '',
  }));
  const rowByAddress = new Map(raw.map((entry) => [entry.address.toString(), entry.row]));
  const opts = {
    startRow: 0,
    endRow: raw.length - 1,
    rowOfAddress: (addr) => rowByAddress.get(BigInt(addr).toString()) ?? null,
    addrOfRow: (row) => raw[row]?.address ?? null,
    symbolFor: () => null,
    name,
    addr: raw[0]?.address ?? base,
  };
  return { raw, opts, model: buildSemanticModel(raw, opts) };
}

test('legacy label repair never inserts a label between declarator and opening brace', () => {
  const lines = [
    { kind: 'sig', indent: 0, text: 'int counterexample(void)', row: 0 },
    { kind: 'ctrl', indent: 0, text: '{', row: null },
  ];

  ensureLegacyLabelForTesting(lines, 99, 'loc_1234', 0x1234n);

  assert.deepEqual(lines.map((line) => line.text), [
    'int counterexample(void)',
    '{',
    'loc_1234:',
  ]);
});

test('shared-cleanup goto is emitted before the function closing brace', () => {
  const { raw, opts, model } = modelOf([
    { address: 0x1000, mn: 'cbnz', ops: 'x0, 0x100c' },
    { address: 0x1004, mn: 'mov', ops: 'x0, #0' },
    { address: 0x1008, mn: 'ret', ops: '' },
    { address: 0x100c, mn: 'mov', ops: 'x1, #1' },
    { address: 0x1010, mn: 'b', ops: '0x1004' },
  ], { name: 'shared_cleanup' });

  const result = decompile(model, { ...opts, addr: raw[0].address, beginner: false });
  const gotoIndex = result.lines.findIndex((line) => line.text === 'goto loc_1004;');
  const closeIndex = result.lines.findIndex((line) => line.kind === 'ctrl' && line.text === '}');

  assert.ok(gotoIndex >= 0, 'the proven cleanup edge must remain explicit');
  assert.ok(closeIndex >= 0, 'function close must remain present');
  assert.ok(gotoIndex < closeIndex, 'goto must remain inside the function body');
});

test('semantic renderer declares a stack local from existing recovered type evidence', () => {
  const { model, opts } = modelOf([
    { mn: 'sdiv', ops: 'x2, x0, x1' },
    { mn: 'str', ops: 'x2, [sp, #-0x10]' },
    { mn: 'ldr', ops: 'x3, [sp, #-0x10]' },
    { mn: 'mov', ops: 'x0, x3' },
    { mn: 'ret', ops: '' },
  ], { name: 'semantic_local' });

  const result = decompileSemantic(model, opts);
  const declaration = result.lines.find((line) => line.kind === 'decl' && /\bvar_m10\b/.test(line.text));
  const statement = result.lines.find((line) => line.kind === 'stmt' && /\bvar_m10\b/.test(line.text));

  assert.equal(declaration?.text, 'int64 var_m10;');
  assert.equal(statement?.text, 'var_m10 = a1 / a2;');
  assert.ok(result.lines.indexOf(declaration) < result.lines.indexOf(statement));
  assert.equal(result.types.locals[0]?.type, 'unknown', 'the declaration must not rewrite analysis metadata');
});

test('semantic renderer emits no local declaration when no body local needs one', () => {
  const { model, opts } = modelOf([
    { mn: 'mov', ops: 'x0, #7' },
    { mn: 'ret', ops: '' },
  ], { name: 'no_local_needed', base: 0x720000n });

  const result = decompileSemantic(model, opts);
  assert.equal(result.lines.some((line) => line.kind === 'decl'), false);
});

test('local declarations do not change emitted executable statements', () => {
  const { model, opts } = modelOf([
    { mn: 'sdiv', ops: 'x2, x0, x1' },
    { mn: 'str', ops: 'x2, [sp, #-0x10]' },
    { mn: 'ldr', ops: 'x3, [sp, #-0x10]' },
    { mn: 'mov', ops: 'x0, x3' },
    { mn: 'ret', ops: '' },
  ], { name: 'meaning_preserved', base: 0x730000n });

  const result = decompileSemantic(model, opts);
  const executable = result.lines
    .filter((line) => line.kind !== 'sig' && line.kind !== 'decl' && !(line.kind === 'ctrl' && (line.text === '{' || line.text === '}')))
    .map((line) => line.text);

  assert.deepEqual(executable, ['var_m10 = a1 / a2;', 'return;']);
});


test('shared-cleanup goto stays after nested control close and before function close', () => {
  const lines = [
    { kind: 'sig', indent: 0, text: 'void nested_cleanup(void)', row: 0 },
    { kind: 'ctrl', indent: 0, text: '{', row: 0 },
    { kind: 'ctrl', indent: 1, text: 'if (flag) {', row: 1 },
    { kind: 'stmt', indent: 2, text: 'inside();', row: 2 },
    { kind: 'ctrl', indent: 1, text: '}', row: 2 },
    { kind: 'stmt', indent: 1, text: 'after_nested();', row: 7 },
    { kind: 'ctrl', indent: 0, text: '}', row: 8 },
  ];
  const edge = {
    from: {
      endRow: 7,
      succ: [1],
      insts: [{ row: 7, address: 0x101cn, id: 'from' }],
    },
    to: {
      insts: [{ row: 3, address: 0x100cn, id: 'to' }],
    },
  };

  assert.equal(ensureLegacyGotoForTesting(lines, edge, 'loc_100c'), true);
  const nestedClose = lines.findIndex((line) => line.kind === 'ctrl' && line.indent === 1 && line.text === '}');
  const gotoIndex = lines.findIndex((line) => line.text === 'goto loc_100c;');
  const functionClose = lines.findIndex((line) => line.kind === 'ctrl' && line.indent === 0 && line.text === '}');

  assert.ok(nestedClose >= 0);
  assert.ok(gotoIndex > nestedClose, 'goto must not be inserted into the nested control body');
  assert.ok(gotoIndex < functionClose, 'goto must remain before the function closing brace');
});
