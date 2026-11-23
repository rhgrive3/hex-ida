import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  decompileSemantic,
  buildCallResultMap,
  reachingRegisterValue,
} from '../../js/decompiler/semantic-core.js';
import { enhanceSemanticDecompilation } from '../../js/decompiler/pipeline-core.js';
import { closeFunctionOutput } from '../../js/decompiler/c-output-closure.js';
import { OP, VK, MK } from '../../js/ir-core.js';

function findCCompiler() {
  for (const cc of ['gcc', 'clang']) {
    try {
      execFileSync(cc, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
      return cc;
    } catch { /* try next */ }
  }
  return null;
}

const CC = findCCompiler();

function compileAndRunC(funcCode, mainHarness) {
  assert.ok(CC, 'C compiler (gcc/clang) is required for execution verification');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-track2-fixes-'));
  const srcPath = path.join(tmpDir, 'test.c');
  const binPath = path.join(tmpDir, 'test_bin');
  try {
    const fullSource = `#include <stdio.h>\n#include <stdint.h>\n#include <stdlib.h>\n\n${funcCode}\n\n${mainHarness}\n`;
    fs.writeFileSync(srcPath, fullSource, 'utf8');
    execFileSync(CC, ['-O0', '-Wall', '-Wno-unused-variable', '-o', binPath, srcPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return execFileSync(binPath, [], { encoding: 'utf8' }).trim();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function makeIRBuilder(name) {
  let nextValId = 1;
  let nextInstId = 1;
  let nextRow = 0;
  const blocks = [];
  const values = [];
  const args = new Map();
  let cur = null;

  function makeVal(opts = {}) {
    const v = {
      id: nextValId++,
      bits: opts.bits ?? 64,
      signed: opts.signed ?? false,
      kind: opts.kind ?? VK.REG,
      reg: opts.reg ?? null,
      const: opts.const ?? null,
      def: null,
      uses: [],
    };
    values.push(v);
    return v;
  }

  function addInst(inst, rowOverride = null) {
    inst.id = nextInstId++;
    inst.row = rowOverride != null ? rowOverride : nextRow++;
    inst.address = 0x1000n + BigInt(inst.row * 4);
    inst.block = cur.index;
    if (inst.op === OP.PHI) cur.phis.push(inst);
    else cur.insts.push(inst);
    if (inst.dst) inst.dst.def = inst;
    for (const a of inst.args || []) {
      if (a?.value) a.value.uses.push(inst);
    }
    for (const inc of inst.incoming || []) {
      if (inc?.value) inc.value.uses.push(inst);
    }
    return inst;
  }

  return {
    arg(reg, bits = 64, signed = false) {
      const v = makeVal({ bits, signed, kind: VK.ARG, reg });
      args.set(reg, v);
      return v;
    },
    block(index) {
      while (blocks.length <= index) {
        blocks.push({ index: blocks.length, phis: [], insts: [], succ: [], pred: [], startRow: 0, endRow: 0 });
      }
      cur = blocks[index];
      return cur;
    },
    constVal(n, bits = 64, signed = false, reg = null, rowOverride = null) {
      const dst = makeVal({ bits, signed, kind: VK.CONST, reg, const: BigInt(n) });
      addInst({ op: OP.CONST, dst, args: [], extra: { value: BigInt(n) } }, rowOverride);
      return dst;
    },
    addrVal(targetAddr, reg = 'x0', rowOverride = null) {
      const dst = makeVal({ bits: 64, signed: false, kind: VK.REG, reg, const: BigInt(targetAddr) });
      addInst({ op: OP.ADDR, dst, args: [], extra: { value: BigInt(targetAddr), target: BigInt(targetAddr) } }, rowOverride);
      return dst;
    },
    bin(sub, a, b, bits = 64, signed = false, reg = null) {
      const dst = makeVal({ bits, signed, reg });
      addInst({ op: OP.BIN, sub, dst, args: [{ value: a }, { value: b }] });
      return dst;
    },
    cmp(a, b) {
      const flags = makeVal({ bits: 64 });
      addInst({ op: OP.CMP, dst: flags, args: [{ value: a }, { value: b }] });
      return flags;
    },
    phi(incomingPairs, bits = 64, signed = false, reg = null, rowOverride = null) {
      const dst = makeVal({ bits, signed, reg });
      const incoming = incomingPairs.map(([from, value]) => ({ from, value }));
      const inst = addInst({ op: OP.PHI, dst, args: [], incoming }, rowOverride);
      return { value: dst, inst };
    },
    patchPhiIncoming(phiObj, from, value) {
      const entry = phiObj.inst.incoming.find((e) => e.from === from);
      if (entry) entry.value = value;
      else phiObj.inst.incoming.push({ from, value });
      if (value) value.uses.push(phiObj.inst);
    },
    storeField(base, disp, val, size = 8, rowOverride = null) {
      const loc = { kind: MK.FIELD, key: `field:${base.id}:${disp}`, base, disp: BigInt(disp), size };
      return addInst({
        op: OP.STORE,
        dst: null,
        loc,
        addr: { base, disp: BigInt(disp), size },
        args: [{ value: val }],
      }, rowOverride);
    },
    storeIndexed(base, index, val, scale = 3, size = 8, rowOverride = null) {
      const loc = { kind: MK.UNKNOWN, key: `idx:${base.id}:${index.id}:${scale}`, base, index, scale, size };
      return addInst({
        op: OP.STORE,
        dst: null,
        loc,
        addr: { base, index, scale, size },
        args: [{ value: val }],
      }, rowOverride);
    },
    call(calleeName, argVals = [], { dstReg = null, returnReg = null, extraValues = [] } = {}) {
      const dst = dstReg ? makeVal({ bits: 64, reg: dstReg }) : null;
      const inst = addInst({
        op: OP.CALL,
        dst,
        returnReg,
        args: argVals.map((v) => ({ value: v })),
        extra: { name: calleeName },
      });
      const created = [];
      for (const spec of extraValues) {
        const v = makeVal({ bits: spec.bits ?? 64, reg: spec.reg });
        v.def = inst;
        created.push(v);
      }
      return { inst, dst, extraValues: created };
    },
    br(target, rowOverride = null) {
      cur.succ.push(target);
      return addInst({ op: OP.BR, args: [], extra: { targetBlock: target } }, rowOverride);
    },
    cbr(flags, cond, yesTarget, noTarget, rowOverride = null) {
      cur.succ.push(yesTarget, noTarget);
      return addInst({ op: OP.CBR, cond, args: [{ value: flags }], extra: { targetBlock: yesTarget } }, rowOverride);
    },
    ret(val = null, rowOverride = null) {
      return addInst({ op: OP.RET, args: val ? [{ value: val }] : [] }, rowOverride);
    },
    build() {
      for (const b of blocks) {
        for (const s of b.succ) {
          if (blocks[s] && !blocks[s].pred.includes(b.index)) blocks[s].pred.push(b.index);
        }
        const all = [...b.phis, ...b.insts];
        b.startRow = all.length ? all[0].row : 0;
        b.endRow = all.length ? all[all.length - 1].row : b.startRow;
      }
      const instructions = blocks.flatMap((b) => [...b.phis, ...b.insts]);
      const ir = {
        entry: 0,
        blocks,
        instructions,
        values,
        args,
        stackSlots: [],
        loops: [],
      };
      const model = {
        name,
        instructions,
        calls: [],
        addressRefs: [],
      };
      return { ir, model };
    },
  };
}

// ============================================================================
// Fix 1: pipeline-core.js knownStatementForLine
// ============================================================================

test('Fix 1a: knownStatementForLine never overwrites trailing phi-copy lines sharing a row with a preceding store', () => {
  const b = makeIRBuilder('store_then_phi_copy');
  const ptr = b.arg('x0', 64, false);
  const flag = b.arg('x1', 64, true);

  b.block(0);
  const zero = b.constVal(0n, 64, true);
  const flags = b.cmp(flag, zero);
  b.cbr(flags, 'ne', 1, 2);

  b.block(1);
  const val1 = b.constVal(11n, 64, true);
  // Store and fallthrough branch share the exact same row (5) so the emitted
  // phi-copy line gets anchorInst.row === store.row.
  b.storeField(ptr, 0n, val1, 8, 5);
  b.br(2, 5);

  b.block(2);
  const merged = b.phi([[0, zero], [1, val1]], 64, true);
  b.ret(merged.value);

  const { ir, model } = b.build();
  const sem = decompileSemantic(model, { ir, name: 'store_then_phi_copy' });
  assert.ok(sem);
  const enhanced = enhanceSemanticDecompilation(sem, model, {});
  assert.ok(enhanced);

  const code = enhanced.pseudocode;
  // The store must appear exactly once, and the phi copy must still exist intact.
  const storeMatches = code.match(/=\s*11;/g) || [];
  assert.ok(storeMatches.length >= 2, `expected both store and phi assignment to 11 in:\n${code}`);
  assert.match(code, /\bphi_\d+\s*=\s*11;/, `phi copy must not be overwritten by preceding store:\n${code}`);
  const fieldStoreMatches = code.match(/a1->field_0\s*=\s*11;|\*\((?:uint64_t|int64_t)\s*\*\)\s*a1\s*=\s*11;/g) || [];
  assert.equal(fieldStoreMatches.length, 1, `preceding store must not be duplicated over phi copy:\n${code}`);
});

test('Fix 1b: knownStatementForLine resolves stp pair stores at the same row without colliding on the first store', () => {
  const b = makeIRBuilder('stp_pair_stores');
  const ptr = b.arg('x0', 64, false);
  const v1 = b.arg('x1', 64, true);
  const v2 = b.arg('x2', 64, true);

  b.block(0);
  // Two distinct stores from an ARM64 `stp x1, x2, [x0]` lifted at the same row (0).
  b.storeField(ptr, 0n, v1, 8, 0);
  b.storeField(ptr, 8n, v2, 8, 0);
  b.ret(null, 1);

  const { ir, model } = b.build();
  const sem = decompileSemantic(model, { ir, name: 'stp_pair_stores' });
  assert.ok(sem);
  const enhanced = enhanceSemanticDecompilation(sem, model, {});
  assert.ok(enhanced);

  const code = enhanced.pseudocode;
  // Both stores (offset 0 -> a2, offset 8 -> a3) must be preserved distinctly.
  assert.match(code, /=\s*a2;/, `first stp store missing in:\n${code}`);
  assert.match(code, /=\s*a3;/, `second stp store collided with first in:\n${code}`);
  assert.match(code, /8/, `second stp store offset +8 missing in:\n${code}`);
});

// ============================================================================
// Fix 2: semantic-core.js emitRegion & loopRender (1-block self-loop do-while)
// ============================================================================

test('Fix 2a: 1-block self-loop (GCC -O2 rotated do-while) keeps body statements inside do-while and executes accurately in C', () => {
  const b = makeIRBuilder('fill_rotated_loop');
  const arr = b.arg('x0', 64, false);
  const n = b.arg('x1', 64, true);

  b.block(0);
  const zero = b.constVal(0n, 64, true);
  const guardFlags = b.cmp(n, zero);
  b.cbr(guardFlags, 'le', 2, 1);

  b.block(1);
  const idx = b.phi([[0, zero], [1, null]], 64, true);
  const two = b.constVal(2n, 64, true);
  const one = b.constVal(1n, 64, true);
  const doubled = b.bin('mul', idx.value, two, 64, true);
  b.storeIndexed(arr, idx.value, doubled, 3, 8);
  const nextIdx = b.bin('add', idx.value, one, 64, true);
  b.patchPhiIncoming(idx, 1, nextIdx);
  const loopFlags = b.cmp(nextIdx, n);
  b.cbr(loopFlags, 'lt', 1, 2);

  b.block(2);
  const retVal = b.phi([[0, zero], [1, nextIdx]], 64, true);
  b.ret(retVal.value);

  const { ir, model } = b.build();
  const res = decompileSemantic(model, { ir, name: 'fill_rotated_loop' });
  assert.ok(res);
  closeFunctionOutput(res);

  const code = res.pseudocode;
  assert.match(code, /\bdo\s*\{/, `expected do-while for 1-block self-loop:\n${code}`);
  // The store must appear AFTER `do {`, never hoisted before it.
  const doIdx = code.indexOf('do {');
  const storeIdx = code.indexOf('* 2');
  assert.ok(doIdx >= 0 && storeIdx > doIdx, `body store must be inside do { ... }:\n${code}`);

  if (CC) {
    // Replace uint64_t/int64_t pointer param with compatible wrapper test
    const out = compileAndRunC(code, `
int main(void) {
  int64_t buf[5] = { -1, -1, -1, -1, -1 };
  int64_t r0 = (int64_t)fill_rotated_loop((uint64_t)buf, 0);
  int64_t r1 = (int64_t)fill_rotated_loop((uint64_t)buf, 1);
  int64_t b1 = buf[0];
  int64_t r5 = (int64_t)fill_rotated_loop((uint64_t)buf, 5);
  printf("%lld %lld %lld %lld %lld %lld %lld %lld %lld\\n",
    (long long)r0, (long long)r1, (long long)b1, (long long)r5,
    (long long)buf[0], (long long)buf[1], (long long)buf[2], (long long)buf[3], (long long)buf[4]);
  return 0;
}
`);
    assert.equal(out, '0 1 0 5 0 2 4 6 8');
  }
});

test('Fix 2b: classic pre-tested 2-block loop with no observable header statements keeps while/for structure', () => {
  const b = makeIRBuilder('classic_pretested_loop');
  const arr = b.arg('x0', 64, false);
  const n = b.arg('x1', 64, true);

  b.block(0);
  const zero = b.constVal(0n, 64, true);
  b.br(1);

  b.block(1);
  const idx = b.phi([[0, zero], [2, null]], 64, true);
  const flags = b.cmp(idx.value, n);
  b.cbr(flags, 'lt', 2, 3);

  b.block(2);
  const one = b.constVal(1n, 64, true);
  b.storeIndexed(arr, idx.value, idx.value, 3, 8);
  const nextIdx = b.bin('add', idx.value, one, 64, true);
  b.patchPhiIncoming(idx, 2, nextIdx);
  b.br(1);

  b.block(3);
  b.ret(idx.value);

  const { ir, model } = b.build();
  const res = decompileSemantic(model, { ir, name: 'classic_pretested_loop' });
  assert.ok(res);
  assert.doesNotMatch(res.pseudocode, /\bdo\s*\{/, `classic pre-tested loop must remain while/for:\n${res.pseudocode}`);
  assert.match(res.pseudocode, /\b(?:for|while)\s*\(/, `expected for/while loop:\n${res.pseudocode}`);
});

// ============================================================================
// Fix 3: semantic-core.js buildCallResultMap & callResultValue (void callees)
// ============================================================================

test('Fix 3: void callees (free) skip return-value mapping and emit free(...) without call_N =', () => {
  const b = makeIRBuilder('free_wrapper');
  const ptr = b.arg('x0', 64, false);

  b.block(0);
  // Simulate a lifted call to `free` that still attached a return reg value `x0`.
  const freeCall = b.call('free', [ptr], { dstReg: 'x0', returnReg: 'x0' });
  const allocCall = b.call('malloc', [b.constVal(64n, 64, false)], { dstReg: 'x0', returnReg: 'x0' });
  // Give freeCall.dst a use so materialization would otherwise materialize it.
  const useStub = b.bin('add', allocCall.dst, b.constVal(0n, 64, false));
  freeCall.dst.uses.push(useStub.def);
  b.ret(allocCall.dst);

  const { ir, model } = b.build();

  // Direct buildCallResultMap check: free must not be mapped, malloc must be mapped.
  const callMap = buildCallResultMap(ir);
  assert.equal(callMap.has(freeCall.inst), false, 'void callee free must not be mapped in buildCallResultMap');
  assert.equal(callMap.get(allocCall.inst), allocCall.dst, 'non-void callee malloc must be mapped');

  // Full decompileSemantic check: free(...) must NOT be assigned to call_N = free(...).
  const res = decompileSemantic(model, { ir, name: 'free_wrapper' });
  assert.ok(res);
  assert.match(res.pseudocode, /\bfree\s*\(/, `expected free(...) call in:\n${res.pseudocode}`);
  assert.doesNotMatch(res.pseudocode, /=\s*free\s*\(/, `void call free must not be assigned:\n${res.pseudocode}`);
});

// ============================================================================
// Fix 4: semantic-core.js reachingRegisterValue (w0 <-> x0 aliasing & block index)
// ============================================================================

test('Fix 4: reachingRegisterValue aliases w0 <-> x0 and uses block.insts index so mov w0, #0 beats entry x0 PHI', () => {
  const b = makeIRBuilder('ret_zero_after_phi');
  const x0Arg = b.arg('x0', 64, true);

  b.block(0);
  const zeroCond = b.constVal(0n, 64, true);
  const flags = b.cmp(x0Arg, zeroCond);
  b.cbr(flags, 'gt', 1, 2);

  b.block(1);
  const ten = b.constVal(10n, 64, true);
  const bumped = b.bin('add', x0Arg, ten, 64, true, 'x0');
  b.br(2);

  b.block(2);
  // Entry PHI on x0 at row 20, followed by mov w0, #0 at SAME row 20, followed by ret at row 20.
  const entryPhi = b.phi([[0, x0Arg], [1, bumped]], 64, true, 'x0', 20);
  const w0Zero = b.constVal(0n, 32, true, 'w0', 20);
  const retInst = b.ret(null, 20);

  const { ir, model } = b.build();

  // Direct reachingRegisterValue check: x0 at retInst must resolve to w0Zero, not entryPhi.
  const reached = reachingRegisterValue(ir, retInst, 'x0');
  assert.equal(reached, w0Zero, 'same-block mov w0, #0 before ret must beat entry x0 PHI even on same row');
  assert.notEqual(reached, entryPhi.value);

  // Full decompileSemantic check: emits `return 0;` instead of `return phi_...;`.
  const res = decompileSemantic(model, { ir, name: 'ret_zero_after_phi' });
  assert.ok(res);
  assert.match(res.pseudocode, /return 0;/, `expected return 0; in:\n${res.pseudocode}`);
  assert.doesNotMatch(res.pseudocode, /return phi_/, `must not return stale entry PHI:\n${res.pseudocode}`);
});

// ============================================================================
// Fix 5: semantic-core.js stringLiteralAt / stringLiteralForValue (empty rodata "")
// ============================================================================

test('Fix 5a: OP.ADDR targeting 0x00 in .rodata, __cstring, or read-only non-exec segment resolves to ""', () => {
  for (const [label, section] of [
    ['.rodata', { name: '.rodata', addr: 0x800n, size: 0x100n, bytes: new Uint8Array(0x100) }],
    ['__cstring', { name: '__cstring', addr: 0x800n, size: 0x100n, bytes: new Uint8Array(0x100) }],
    ['ro-segment', { addr: 0x800n, size: 0x100n, readable: true, writable: false, executable: false, bytes: new Uint8Array(0x100) }],
  ]) {
    const b = makeIRBuilder(`empty_str_${label.replace(/\W/g, '_')}`);
    b.block(0);
    const addr = b.addrVal(0x840n, 'x0');
    b.ret(addr);
    const { ir, model } = b.build();

    const res = decompileSemantic(model, { ir, name: model.name, sections: [section] });
    assert.ok(res, `decompileSemantic failed for ${label}`);
    assert.match(res.pseudocode, /return "";/, `expected return ""; for ${label}, got:\n${res.pseudocode}`);
  }
});

test('Fix 5b: 0x00 in .bss, writable .data, executable .text, non-zero .rodata, or OP.CONST never resolves to ""', () => {
  const negativeSections = [
    ['.bss', { name: '.bss', addr: 0x800n, size: 0x100n, zerofill: true, bytes: new Uint8Array(0x100) }],
    ['.data', { name: '.data', addr: 0x800n, size: 0x100n, writable: true, bytes: new Uint8Array(0x100) }],
    ['.text', { name: '.text', addr: 0x800n, size: 0x100n, executable: true, bytes: new Uint8Array(0x100) }],
    ['.rodata-nonzero', { name: '.rodata', addr: 0x800n, size: 0x100n, bytes: new Uint8Array(0x100).fill(0x41) }],
  ];
  for (const [label, section] of negativeSections) {
    const b = makeIRBuilder(`neg_${label.replace(/\W/g, '_')}`);
    b.block(0);
    const addr = b.addrVal(0x840n, 'x0');
    b.ret(addr);
    const { ir, model } = b.build();

    const res = decompileSemantic(model, { ir, name: model.name, sections: [section] });
    assert.ok(res);
    assert.doesNotMatch(res.pseudocode, /return "";/, `${label} must NOT resolve to "":\n${res.pseudocode}`);
  }

  // Plain OP.CONST 0x840 must NOT resolve to "" even if 0x840 is in .rodata.
  const bConst = makeIRBuilder('const_not_addr');
  bConst.block(0);
  const c = bConst.constVal(0x840n, 64, false, 'x0');
  bConst.ret(c);
  const { ir, model } = bConst.build();
  const resConst = decompileSemantic(model, {
    ir,
    name: 'const_not_addr',
    sections: [{ name: '.rodata', addr: 0x800n, size: 0x100n, bytes: new Uint8Array(0x100) }],
  });
  assert.ok(resConst);
  assert.doesNotMatch(resConst.pseudocode, /return "";/, `OP.CONST must not resolve to "":\n${resConst.pseudocode}`);
});
