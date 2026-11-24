import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSemanticModel } from '../../js/blocks.js';
import { decompile as decompileLegacy, decompiledText } from '../../js/decompile-legacy.js';
import { decompile } from '../../js/decompile.js';
import { semanticAbiAdapter } from '../../js/analysis/semantic-function.js';
import { AAPCS64_ABI } from '../../js/targets/abi/index.js';

const BASE = 0x100000000n;
const testAbiAdapter = semanticAbiAdapter(AAPCS64_ABI);

function makeModel(lines, opts = {}) {
  const base = opts.base ?? BASE;
  const raw = lines.map((text, row) => {
    const p = text.indexOf(' ');
    return {
      row,
      address: base + BigInt(row * 4),
      mn: p < 0 ? text : text.slice(0, p),
      ops: p < 0 ? '' : text.slice(p + 1),
    };
  });
  const rowOfAddress = (addr) => {
    const d = BigInt(addr) - base;
    return d >= 0n && d < BigInt(raw.length * 4) ? Number(d / 4n) : null;
  };
  const model = buildSemanticModel(raw, {
    startRow: 0,
    endRow: raw.length - 1,
    rowOfAddress,
    symbolFor: opts.symbolFor || (() => null),
    name: opts.name || 'func0',
    readBytes: opts.readBytes,
  });
  if (opts.addressRefs) model.addressRefs = [...(model.addressRefs || []), ...opts.addressRefs];
  return { model, rowOfAddress };
}

test('974 regression: sub-pointer load (ldrh/ldrb) from .rodata string does not emit string pointer literal', () => {
  const rodataAddr = 0x100000988n;
  const rodataBytes = new Uint8Array([0x64, 0x62, 0x00, 0x00]); // "db\0\0"
  const readBytes = (addr, n) => {
    const off = Number(BigInt(addr) - rodataAddr);
    if (off < 0 || off >= rodataBytes.length) return null;
    return rodataBytes.slice(off, off + n);
  };

  for (const [mn, reg, st] of [['ldrh', 'w3', 'strh'], ['ldrb', 'w3', 'strb']]) {
    const { model, rowOfAddress } = makeModel([
      'adrp x2, #0x100000000',
      'add x2, x2, #0x988',
      `${mn} ${reg}, [x2]`,
      `${st} ${reg}, [x0]`,
      `${st} ${reg}, [x1]`,
      'ret',
    ], {
      readBytes,
      addressRefs: [{ row: 2, addr: rodataAddr, text: 'db', load: true }],
    });
    const res = decompileLegacy(model, { addr: BASE, name: 'func0', rowOfAddress, readBytes });
    const text = decompiledText(res);
    assert.ok(res && text, `expected pseudocode for ${mn}`);
    assert.ok(!text.includes('= "db";'), `${mn} must not emit string pointer literal:\n${text}`);
  }

  const { model: ptrModel, rowOfAddress: ptrRowOf } = makeModel([
    'adrp x2, #0x100000000',
    'add x2, x2, #0x988',
    'ldr x3, [x2]',
    'str x3, [x0]',
    'str x3, [x1]',
    'ret',
  ], {
    readBytes,
    addressRefs: [{ row: 2, addr: rodataAddr, text: 'db', load: true }],
  });
  const ptrRes = decompileLegacy(ptrModel, { addr: BASE, name: 'func0', rowOfAddress: ptrRowOf, readBytes });
  const ptrText = decompiledText(ptrRes);
  assert.ok(ptrRes && ptrText, 'expected pseudocode for 64-bit ldr');
  assert.ok(ptrText.includes('"db"'), `64-bit pointer load should preserve string literal:\n${ptrText}`);
});

test('1202 regression: edge phi-copy statements retain source block through structured control projection', () => {
  // Mirrors HumanEval 1202's minpos diamond inside a loop (faithfulCfg + structured control projection):
  // loc_778 -> loc_77C (cbz w3, loc_7C0) -> loc_784 (csel) -> loc_788 (loop latch)
  //                                      -> loc_7C0 (mov w3, w1; b loc_788)
  const { model, rowOfAddress } = makeModel([
    'mov w3, #0x0',                  // 0x00
    'cmp w1, #0x0',                  // 0x04
    'b.le #0x100000070',             // 0x08 -> loc_70
    'add x4, x0, w1, sxtw #2',       // 0x0c
    'mov w5, #0x0',                  // 0x10
    'b #0x100000034',                // 0x14 -> loc_34
    'b.eq #0x100000028',             // 0x18 (loc_18) -> loc_28
    'cmp w3, w1',                    // 0x1c (loc_1c)
    'cbz w3, #0x100000060',          // 0x20 -> loc_60
    'csel w3, w3, w1, le',           // 0x24 (loc_24)
    'add x0, x0, #0x4',              // 0x28 (loc_28)
    'cmp x0, x4',                    // 0x2c
    'b.eq #0x100000058',             // 0x30 -> loc_58
    'ldr w1, [x0]',                  // 0x34 (loc_34)
    'cmp w1, #0x0',                  // 0x38
    'b.ge #0x100000018',             // 0x3c -> loc_18
    'cmp w5, w1',                    // 0x40 (loc_40)
    'cbz w5, #0x100000068',          // 0x44 -> loc_68
    'add x0, x0, #0x4',              // 0x48 (loc_48)
    'csel w5, w5, w1, ge',           // 0x4c
    'cmp x0, x4',                    // 0x50
    'b.ne #0x100000034',             // 0x54 -> loc_34
    'stp w5, w3, [x2]',              // 0x58 (loc_58)
    'ret',                           // 0x5c
    'mov w3, w1',                    // 0x60 (loc_60)
    'b #0x100000028',                // 0x64 -> loc_28
    'mov w5, w1',                    // 0x68 (loc_68)
    'b #0x100000028',                // 0x6c -> loc_28
    'mov w5, #0x0',                  // 0x70 (loc_70)
    'stp w5, w3, [x2]',              // 0x74
    'ret',                           // 0x78
  ]);

  const res = decompile(model, {
    abiAdapter: testAbiAdapter,
    addr: BASE,
    name: 'func0',
    rowOfAddress,
  });
  assert.ok(res && res.pseudocode, 'expected pseudocode for 1202 pattern');
  // Must not emit an empty `if (phi_X == 0) { } else { }` with stranded phi copies
  assert.ok(
    !/if\s*\([^)]+\)\s*\{\s*\}\s*else\s*\{\s*\}/.test(res.pseudocode),
    `empty if/else must not be emitted:\n${res.pseudocode}`
  );
});
