import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Emulator } from '../js/emu.js';
import { analyzeDataFlow, makeInstruction } from '../js/blocks-base.js';

function makeMemoryEmulator(initialBytesMap = new Map(), mappedPages = new Set([0x1000n])) {
  const PAGE = 4096n;
  const io = {
    read(address, size) {
      const start = BigInt(address);
      const page = (start / PAGE) * PAGE;
      if (!mappedPages.has(page)) return new Uint8Array(0);
      const out = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        const b = initialBytesMap.get(start + BigInt(i));
        out[i] = b != null ? b : 0;
      }
      return out;
    },
  };
  return new Emulator(io);
}

function putU64LE(map, addr, value) {
  let v = BigInt.asUintN(64, value);
  for (let i = 0; i < 8; i++) {
    map.set(addr + BigInt(i), Number(v & 0xffn));
    v >>= 8n;
  }
}

function putU32LE(map, addr, value) {
  let v = BigInt.asUintN(32, value);
  for (let i = 0; i < 4; i++) {
    map.set(addr + BigInt(i), Number(v & 0xffn));
    v >>= 8n;
  }
}

function runFlow(lines) {
  const BASE = 0x100000n;
  const insns = lines.map((line, row) => {
    const split = line.indexOf(' ');
    return makeInstruction({
      row,
      address: BASE + BigInt(row * 4),
      mn: split < 0 ? line : line.slice(0, split),
      ops: split < 0 ? '' : line.slice(split + 1),
    });
  });
  return analyzeDataFlow(insns, {});
}

describe('emu-base loadInsn base-register writeback ordering', () => {
  it('does not clobber destination on pre-index aliased LDR', async () => {
    const mem = new Map();
    putU64LE(mem, 0x1008n, 0xdeadbeefcafebaben);
    const emu = makeMemoryEmulator(mem);
    emu.set('x0', 0x1000n);

    await emu.execute('ldr', 'x0, [x0, #8]!', 0x1000n);
    assert.equal(emu.get('x0'), 0xdeadbeefcafebaben);
  });

  it('does not clobber destination on post-index aliased LDR', async () => {
    const mem = new Map();
    putU64LE(mem, 0x1000n, 0x1122334455667788n);
    const emu = makeMemoryEmulator(mem);
    emu.set('x0', 0x1000n);

    await emu.execute('ldr', 'x0, [x0], #8', 0x1000n);
    assert.equal(emu.get('x0'), 0x1122334455667788n);
  });

  it('preserves base-register writeback for non-aliased pre/post-index LDR', async () => {
    const mem = new Map();
    putU64LE(mem, 0x1008n, 0xaaaa0001n);
    putU64LE(mem, 0x1010n, 0xbbbb0002n);
    const emu = makeMemoryEmulator(mem);
    emu.set('x0', 0x1000n);

    await emu.execute('ldr', 'x1, [x0, #8]!', 0x1000n);
    assert.equal(emu.get('x1'), 0xaaaa0001n);
    assert.equal(emu.get('x0'), 0x1008n);

    await emu.execute('ldr', 'x2, [x0], #8', 0x1004n);
    assert.equal(emu.get('x2'), 0xaaaa0001n);
    assert.equal(emu.get('x0'), 0x1010n);
  });

  it('handles aliased LDP and LDPSW without clobbering loaded destinations', async () => {
    const mem = new Map();
    putU64LE(mem, 0x1010n, 0x1111n);
    putU64LE(mem, 0x1018n, 0x2222n);
    putU32LE(mem, 0x1020n, 0xfffffffen); // -2
    putU32LE(mem, 0x1024n, 0x00000007n); // +7
    const emu = makeMemoryEmulator(mem);

    // Pre-index LDP aliasing first destination with base
    emu.set('x0', 0x1000n);
    await emu.execute('ldp', 'x0, x1, [x0, #16]!', 0x1000n);
    assert.equal(emu.get('x0'), 0x1111n);
    assert.equal(emu.get('x1'), 0x2222n);

    // Post-index LDP aliasing second destination with base
    emu.set('x0', 0x1010n);
    await emu.execute('ldp', 'x1, x0, [x0], #16', 0x1004n);
    assert.equal(emu.get('x1'), 0x1111n);
    assert.equal(emu.get('x0'), 0x2222n);

    // Post-index LDPSW aliasing first destination with base
    emu.set('x0', 0x1020n);
    await emu.execute('ldpsw', 'x0, x1, [x0], #8', 0x1008n);
    assert.equal(emu.get('x0'), 0xfffffffffffffffen);
    assert.equal(emu.get('x1'), 7n);
  });

  it('does not commit base writeback when the memory load faults', async () => {
    const emu = makeMemoryEmulator(new Map(), new Set([0x1000n]));
    emu.set('x0', 0x2000n);
    emu.set('x1', 0x99n);

    await assert.rejects(
      () => emu.execute('ldr', 'x1, [x0, #8]!', 0x1000n),
      (err) => err && err.code === 'unmapped-memory',
    );
    assert.equal(emu.get('x0'), 0x2000n, 'base register must remain unchanged on fault');
    assert.equal(emu.get('x1'), 0x99n, 'destination register must remain unchanged on fault');
  });
});

describe('blocks-base analyzeDataFlow SP delta tracking', () => {
  it('canonicalizes stack slots across sub/add sp, sp, #imm without false aliasing', () => {
    const df = runFlow([
      'mov x0, #0x1111',
      'str x0, [sp, #0]',
      'sub sp, sp, #16',
      'mov x1, #0x2222',
      'str x1, [sp, #0]',
      'add sp, sp, #16',
      'ldr x2, [sp, #0]',
    ]);
    assert.equal(df.finalRegs.get('x2')?.kind, 'imm');
    assert.equal(df.finalRegs.get('x2')?.value, 0x1111n);
  });

  it('forwards same canonical slot across sub sp, sp, #16 and isolates distinct offset', () => {
    const df = runFlow([
      'mov x0, #0x1234',
      'str x0, [sp, #0]',
      'sub sp, sp, #16',
      'ldr x1, [sp, #16]',
      'ldr x2, [sp, #0]',
    ]);
    assert.equal(df.finalRegs.get('x1')?.kind, 'imm');
    assert.equal(df.finalRegs.get('x1')?.value, 0x1234n);
    assert.equal(df.finalRegs.get('x2')?.kind, 'loaded');
    assert.notEqual(df.finalRegs.get('x2')?.value, 0x1234n);
  });

  it('tracks lsl #12 shifted immediate sp adjustments', () => {
    const df = runFlow([
      'mov x0, #0xaaaa',
      'str x0, [sp, #0]',
      'sub sp, sp, #1, lsl #12',
      'mov x1, #0xbbbb',
      'str x1, [sp, #0]',
      'add sp, sp, #1, lsl #12',
      'ldr x2, [sp, #0]',
    ]);
    assert.equal(df.finalRegs.get('x2')?.kind, 'imm');
    assert.equal(df.finalRegs.get('x2')?.value, 0xaaaan);
  });

  it('composes pre-index writeback delta with sub/add sp, sp, #imm', () => {
    const df = runFlow([
      'mov x0, #0x5555',
      'mov x1, #0x6666',
      'stp x0, x1, [sp, #-16]!',
      'sub sp, sp, #32',
      'ldr x2, [sp, #32]',
      'ldr x3, [sp, #40]',
    ]);
    assert.equal(df.finalRegs.get('x2')?.value, 0x5555n);
    assert.equal(df.finalRegs.get('x3')?.value, 0x6666n);
  });

  it('invalidates sp stack slots on unknown sp modifications', () => {
    for (const unknownSpInsn of ['sub sp, sp, x8', 'and sp, sp, #-16', 'mov sp, x29']) {
      const df = runFlow([
        'mov x0, #0x7777',
        'str x0, [sp, #0]',
        unknownSpInsn,
        'add sp, sp, #0',
        'ldr x1, [sp, #0]',
      ]);
      assert.equal(
        df.finalRegs.get('x1')?.kind,
        'loaded',
        `expected stale sp slot to be invalidated after "${unknownSpInsn}"`,
      );
      assert.notEqual(
        df.finalRegs.get('x1')?.value,
        0x7777n,
        `stale constant must not forward after "${unknownSpInsn}"`,
      );
    }
  });
});
