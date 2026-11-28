import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { formatCleanViewLines } from '../js/decompiler/clean-view.js';

function loadClassicMachO() {
  const ctx = { globalThis: null, self: null, TextDecoder, BigInt, Uint8Array, DataView, ArrayBuffer, Map, Set, Math, Number, String, Array, Object, Error, TypeError, RangeError, BigUint64Array, Int32Array, Uint32Array, Uint16Array };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  vm.runInNewContext(fs.readFileSync('js/macho.js', 'utf8'), ctx, { filename: 'js/macho.js' });
  return ctx.MachO;
}

test('MachO.definedSymbols keeps addr=0x0 symbols when allowZero is enabled for MH_OBJECT', () => {
  const MachO = loadClassicMachO();
  const sym = {
    names: ['_ios_sha256_transform', '_ios_chacha20_block'],
    values: [0n, 0x1a0n],
    types: new Uint8Array([0x0f, 0x0f]), // N_SECT | N_EXT
    sects: new Uint8Array([1, 1]),
  };
  const defaultSyms = MachO.definedSymbols(sym);
  assert.deepEqual(Array.from(defaultSyms, (s) => s.name), ['_ios_chacha20_block']);

  const objSyms = MachO.definedSymbols(sym, { allowZero: true });
  assert.deepEqual(Array.from(objSyms, (s) => s.name), ['_ios_sha256_transform', '_ios_chacha20_block']);
  assert.equal(objSyms[0].addr, 0n);
});

test('decompiler-provenance.js wires Clean View toggle and formatCleanViewLines', () => {
  const src = fs.readFileSync('js/ui/decompiler-provenance.js', 'utf8');
  assert.match(src, /import\s*\{\s*formatCleanViewLines\s*\}\s*from\s*'\.\.\/decompiler\/clean-view\.js'/);
  assert.match(src, /Clean View/);
  assert.match(src, /elideDeadSpills:\s*true/);
  assert.match(src, /refineAppleSwift:\s*true/);
});

test('formatCleanViewLines preserves _origIdx metadata for provenance click mapping', () => {
  const lines = [
    { kind: 'sig', indent: 0, text: 'void f(uint64 a1)', _origIdx: 0 },
    { kind: 'ctrl', indent: 0, text: '{', _origIdx: 1 },
    { kind: 'decl', indent: 1, text: 'uint64 var_10;', _origIdx: 2 },
    { kind: 'stmt', indent: 1, text: 'var_10 = a1;', _origIdx: 3 },
    { kind: 'stmt', indent: 1, text: 'return a1;', _origIdx: 4 },
    { kind: 'ctrl', indent: 0, text: '}', _origIdx: 5 },
  ];
  const { lines: out, stats } = formatCleanViewLines(lines, {
    hideTypedefPrelude: false,
    elideDeadSpills: true,
    refineAppleSwift: true,
  });
  assert.equal(stats.deadSpillsElided, 1);
  assert.equal(stats.deadDeclsElided, 1);
  assert.deepEqual(out.map((l) => l._origIdx), [0, 1, 4, 5]);
});
