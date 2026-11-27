import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSemanticModel } from '../js/blocks.js';
import { decompile as decompileLegacy, decompiledText } from '../js/decompile-legacy.js';

function makeNotes(retType = null, names = new Map()) {
  return {
    typeOf(_addr, key) {
      if (key === 'ret') return retType;
      return null;
    },
    nameOf(addr) {
      return addr != null ? (names.get(BigInt(addr)) ?? null) : null;
    },
    varName() {
      return null;
    },
  };
}

function makeModel(lines, opts = {}) {
  const base = opts.addr ?? 0x100000n;
  const rows = lines.map((entry, row) => {
    const text = typeof entry === 'string' ? entry : entry.text;
    const trimmed = text.trim();
    const split = trimmed.indexOf(' ');
    return {
      row,
      address: base + BigInt(row * 4),
      mn: split < 0 ? trimmed : trimmed.slice(0, split),
      ops: split < 0 ? '' : trimmed.slice(split + 1).trim(),
    };
  });
  const rowOfAddress = (address) => rows.find((r) => r.address === BigInt(address))?.row ?? null;
  const symbols = opts.symbols || new Map();
  const symbolFor = (address) => symbols.get(BigInt(address)) ?? null;
  const model = buildSemanticModel(rows, {
    rowOfAddress,
    symbolFor,
    startRow: 0,
    endRow: rows.length - 1,
  });

  if (Array.isArray(opts.patchInsns)) {
    for (const patch of opts.patchInsns) {
      const insn = model.instructions[patch.row];
      if (!insn) throw new Error(`Missing instruction at row ${patch.row}`);
      Object.assign(insn, patch.fields);
    }
  }
  if (Array.isArray(opts.calls)) {
    for (const c of opts.calls) {
      const existing = model.calls.find((item) => item.row === c.row);
      if (existing) Object.assign(existing, c);
      else model.calls.push(c);
    }
  }

  return {
    model,
    opts: {
      addr: base,
      name: opts.name || 'func0',
      symbolFor,
      rowOfAddress,
      beginner: false,
      notes: opts.notes,
      objcSyntax: opts.objcSyntax,
    },
  };
}

test('void function emits bare return; for ret, retab, and retaa', () => {
  for (const mn of ['ret', 'retab', 'retaa']) {
    const { model, opts } = makeModel([
      'mov w8, #1',
      'str w8, [x0]',
      mn,
    ], { name: `void_${mn}_fn` });

    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /^void\s+void_/, `expected void signature for ${mn}:\n${code}`);
    assert.match(code, /\n\s*return;\s*(\n|$)/, `expected bare 'return;' for ${mn}:\n${code}`);
    assert.doesNotMatch(code, /\n\s*return\s+[^;]+;/, `must not emit value-bearing return in void ${mn}:\n${code}`);
  }
});

test('notes ret=void overrides inferred x0 write on ret/retab/retaa and notes ret="void *" is non-void', () => {
  for (const mn of ['ret', 'retab', 'retaa']) {
    const { model, opts } = makeModel([
      'mov x0, #42',
      mn,
    ], {
      name: `override_void_${mn}`,
      notes: makeNotes('void'),
    });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /^void\s+override_void_/, `expected void signature:\n${code}`);
    assert.match(code, /\n\s*return;\s*(\n|$)/, `expected bare 'return;' when notes override to void:\n${code}`);
    assert.doesNotMatch(code, /\n\s*return\s+[^;]+;/, `must not emit value return when notes override to void:\n${code}`);
  }

  for (const mn of ['ret', 'retab', 'retaa']) {
    const { model, opts } = makeModel([
      'nop',
      mn,
    ], {
      name: `void_ptr_${mn}`,
      notes: makeNotes('void *'),
    });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /^void \*\s+void_ptr_/, `expected 'void *' signature:\n${code}`);
    assert.match(code, /\n\s*return\s+[^;]+;/, `expected value-bearing return for 'void *' (${mn}):\n${code}`);
    assert.doesNotMatch(code, /\n\s*return;\s*(\n|$)/, `must not emit bare 'return;' for 'void *' (${mn}):\n${code}`);
  }
});

test('void caller tail-call emits callExpr; return; for both isTailCall and tailCall (normal + ObjC C syntax)', () => {
  const symbols = new Map([
    [0x200000n, '_helper_nonvoid'],
    [0x200004n, '_free'],
    [0x200008n, '_objc_msgSend$doWork:'],
  ]);

  for (const flag of ['isTailCall', 'tailCall']) {
    // Normal tail-call to non-void callee in void caller
    {
      const { model, opts } = makeModel([
        'mov x0, #7',
        'b #0x200000',
      ], {
        name: `void_tail_normal_${flag}`,
        symbols,
        notes: makeNotes('void'),
        patchInsns: [{
          row: 1,
          fields: { isCall: false, isBranch: false, callTarget: 0x200000n, [flag]: true },
        }],
        calls: [{ row: 1, target: 0x200000n, name: '_helper_nonvoid' }],
      });
      const res = decompileLegacy(model, opts);
      const code = decompiledText(res);
      assert.match(code, /helper_nonvoid\([^)]*\);\s*return;/, `expected 'callExpr; return;' for ${flag}:\n${code}`);
      assert.doesNotMatch(code, /return\s+helper_nonvoid\(/, `must not emit 'return callExpr;' in void caller (${flag}):\n${code}`);
    }

    // Normal tail-call to void callee in void caller
    {
      const { model, opts } = makeModel([
        'b #0x200004',
      ], {
        name: `void_tail_voidcallee_${flag}`,
        symbols,
        notes: makeNotes('void'),
        patchInsns: [{
          row: 0,
          fields: { isCall: false, isBranch: false, callTarget: 0x200004n, [flag]: true },
        }],
        calls: [{ row: 0, target: 0x200004n, name: '_free' }],
      });
      const res = decompileLegacy(model, opts);
      const code = decompiledText(res);
      assert.match(code, /free\([^)]*\);\s*return;/, `expected 'free(...); return;' for ${flag}:\n${code}`);
      assert.doesNotMatch(code, /return\s+free\(/, `must not emit 'return free(...);' (${flag}):\n${code}`);
    }

    // ObjC C-syntax tail-call in void caller
    {
      const { model, opts } = makeModel([
        'mov x2, #9',
        'b #0x200008',
      ], {
        name: `void_tail_objc_${flag}`,
        symbols,
        objcSyntax: 'c',
        notes: makeNotes('void'),
        patchInsns: [{
          row: 1,
          fields: { isCall: false, isBranch: false, callTarget: 0x200008n, [flag]: true },
        }],
        calls: [{ row: 1, target: 0x200008n, name: '_objc_msgSend$doWork:', selector: 'doWork:' }],
      });
      const res = decompileLegacy(model, opts);
      const code = decompiledText(res);
      assert.match(code, /objc_msgSend\([^)]*"doWork:"[^)]*\);\s*return;/, `expected ObjC C-syntax 'callExpr; return;' for ${flag}:\n${code}`);
      assert.doesNotMatch(code, /return\s+objc_msgSend\(/, `must not emit 'return objc_msgSend(...);' in void caller (${flag}):\n${code}`);
      assert.doesNotMatch(code, /x0\s*=\s*objc_msgSend\(/, `must not assign dst for ObjC tail-call (${flag}):\n${code}`);
    }
  }
});

test('non-void caller tail-calling void callee emits callExpr; return 0/0.0;', () => {
  const symbols = new Map([
    [0x200010n, '_free'],
    [0x200014n, '_custom_void_returns_false'],
    [0x200018n, '_custom_void_return_type'],
  ]);

  const cases = [
    { callerRet: 'void *', zero: '0', target: 0x200010n, callName: '_free', proto: undefined, flag: 'isTailCall' },
    { callerRet: 'int64', zero: '0', target: 0x200014n, callName: '_custom_void_returns_false', proto: { returnsValue: false }, flag: 'tailCall' },
    { callerRet: 'float', zero: '0.0', target: 0x200018n, callName: '_custom_void_return_type', proto: { returnType: 'void' }, flag: 'isTailCall' },
    { callerRet: 'double', zero: '0.0', target: 0x200010n, callName: '_free', proto: undefined, flag: 'tailCall' },
  ];

  for (const tc of cases) {
    const clean = tc.callName.replace(/^_/, '');
    const { model, opts } = makeModel([
      `b #0x${tc.target.toString(16)}`,
    ], {
      name: `nonvoid_${tc.callerRet.replace(/[^a-z0-9]/gi, '_')}_${tc.flag}`,
      symbols,
      notes: makeNotes(tc.callerRet),
      patchInsns: [{
        row: 0,
        fields: { isCall: false, isBranch: false, callTarget: tc.target, [tc.flag]: true },
      }],
      calls: [{
        row: 0,
        target: tc.target,
        name: tc.callName,
        ...(tc.proto ? { prototype: tc.proto } : {}),
      }],
    });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    const re = new RegExp(`${clean}\\([^)]*\\);\\s*return ${tc.zero.replace('.', '\\.')};`);
    assert.match(code, re, `expected '${clean}(...); return ${tc.zero};' for ${tc.callerRet} (${tc.flag}):\n${code}`);
    assert.doesNotMatch(code, new RegExp(`return\\s+${clean}\\(`), `must not emit 'return ${clean}(...);' (${tc.flag}):\n${code}`);
  }
});

test('non-void caller tail-calling non-void callee emits return callExpr;', () => {
  const symbols = new Map([
    [0x200020n, '_malloc'],
    [0x200024n, '_objc_msgSend$initWithValue:'],
  ]);

  {
    const { model, opts } = makeModel([
      'mov x0, #16',
      'b #0x200020',
    ], {
      name: 'nonvoid_tail_malloc',
      symbols,
      notes: makeNotes('void *'),
      patchInsns: [{
        row: 1,
        fields: { isCall: false, isBranch: false, callTarget: 0x200020n, tailCall: true },
      }],
      calls: [{ row: 1, target: 0x200020n, name: '_malloc' }],
    });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /return\s+malloc\([^)]*\);/, `expected 'return malloc(...);' for void * caller:\n${code}`);
  }

  {
    const { model, opts } = makeModel([
      'mov x2, #5',
      'b #0x200024',
    ], {
      name: 'nonvoid_tail_objc',
      symbols,
      objcSyntax: 'c',
      notes: makeNotes('void *'),
      patchInsns: [{
        row: 1,
        fields: { isCall: false, isBranch: false, callTarget: 0x200024n, isTailCall: true },
      }],
      calls: [{ row: 1, target: 0x200024n, name: '_objc_msgSend$initWithValue:', selector: 'initWithValue:' }],
    });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /return\s+objc_msgSend\([^)]*"initWithValue:"[^)]*\);/, `expected 'return objc_msgSend(...);' for void * caller:\n${code}`);
  }
});
