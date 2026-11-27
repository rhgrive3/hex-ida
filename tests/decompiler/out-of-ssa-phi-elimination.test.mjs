import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { decompileSemantic } from '../../js/decompiler/semantic-core.js';
import { closeFunctionOutput } from '../../js/decompiler/c-output-closure.js';
import { OP, VK } from '../../js/ir-core.js';

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

function cSyntaxOk(code) {
  if (!CC) return { skipped: true, ok: true, stderr: '' };
  try {
    execFileSync(CC, ['-x', 'c', '-fsyntax-only', '-'], { input: code, stdio: ['pipe', 'pipe', 'pipe'] });
    return { skipped: false, ok: true, stderr: '' };
  } catch (err) {
    return { skipped: false, ok: false, stderr: String(err.stderr || err.message || '') };
  }
}

function compileAndRunC(funcCode, mainHarness) {
  assert.ok(CC, 'C compiler (gcc/clang) is required for execution verification');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-out-of-ssa-'));
  const srcPath = path.join(tmpDir, 'test.c');
  const binPath = path.join(tmpDir, 'test_bin');
  try {
    const fullSource = `#include <stdio.h>\n#include <stdint.h>\n\n${funcCode}\n\n${mainHarness}\n`;
    fs.writeFileSync(srcPath, fullSource, 'utf8');
    execFileSync(CC, ['-O0', '-Wall', '-Wno-unused-variable', '-o', binPath, srcPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return execFileSync(binPath, [], { encoding: 'utf8' }).trim();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Minimal deterministic SSA IR builder for unit-testing decompileSemantic Out-of-SSA.
 */
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

  function addInst(inst) {
    inst.id = nextInstId++;
    inst.row = nextRow++;
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
    constVal(n, bits = 64, signed = false) {
      const dst = makeVal({ bits, signed, kind: VK.CONST, const: BigInt(n) });
      addInst({ op: OP.CONST, dst, args: [], extra: { value: BigInt(n) } });
      return dst;
    },
    bin(sub, a, b, bits = 64, signed = false) {
      const dst = makeVal({ bits, signed });
      addInst({ op: OP.BIN, sub, dst, args: [{ value: a }, { value: b }] });
      return dst;
    },
    cmp(a, b) {
      const flags = makeVal({ bits: 64 });
      addInst({ op: OP.CMP, dst: flags, args: [{ value: a }, { value: b }] });
      return flags;
    },
    phi(incomingPairs, bits = 64, signed = false) {
      const dst = makeVal({ bits, signed });
      const incoming = incomingPairs.map(([from, value]) => ({ from, value }));
      const inst = addInst({ op: OP.PHI, dst, incoming });
      return { value: dst, inst };
    },
    patchPhiIncoming(phiObj, from, value) {
      const entry = phiObj.inst.incoming.find((e) => e.from === from);
      if (entry) {
        entry.value = value;
      } else {
        phiObj.inst.incoming.push({ from, value });
      }
      if (value) value.uses.push(phiObj.inst);
    },
    br(target) {
      cur.succ.push(target);
      addInst({ op: OP.BR, args: [], extra: { targetBlock: target } });
    },
    cbr(flags, cond, yesTarget, noTarget) {
      cur.succ.push(yesTarget, noTarget);
      addInst({ op: OP.CBR, cond, args: [{ value: flags }], extra: { targetBlock: yesTarget } });
    },
    ret(val) {
      addInst({ op: OP.RET, args: val ? [{ value: val }] : [] });
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
      };
      return { ir, model };
    },
  };
}

function decompileAndClose(name, builder) {
  const { ir, model } = builder.build();
  const res = decompileSemantic(model, { ir, name });
  assert.ok(res, `decompileSemantic returned null for ${name}`);
  closeFunctionOutput(res);
  return res;
}

test('Pattern 1: if-else diamond merge phi eliminates phi(...) and matches C execution', () => {
  const b = makeIRBuilder('if_else_merge');
  const x0 = b.arg('x0', 64, true);
  const x1 = b.arg('x1', 64, true);
  const x2 = b.arg('x2', 64, true);

  b.block(0);
  const zero = b.constVal(0n, 64, true);
  const flags = b.cmp(x0, zero);
  b.cbr(flags, 'gt', 1, 2);

  b.block(1);
  const ten = b.constVal(10n, 64, true);
  const left = b.bin('add', x1, ten, 64, true);
  b.br(3);

  b.block(2);
  const two = b.constVal(2n, 64, true);
  const right = b.bin('mul', x2, two, 64, true);
  b.br(3);

  b.block(3);
  const merged = b.phi([[1, left], [2, right]], 64, true);
  b.ret(merged.value);

  const res = decompileAndClose('if_else_merge', b);
  assert.doesNotMatch(res.pseudocode, /\bphi\s*\(/, `unexpected phi(...) in:\n${res.pseudocode}`);
  assert.match(res.pseudocode, /\bphi_\d+\b/, `expected Out-of-SSA phi variable in:\n${res.pseudocode}`);

  const syntax = cSyntaxOk(res.pseudocode);
  assert.equal(syntax.ok, true, `GCC syntax failed:\n${syntax.stderr}\nCode:\n${res.pseudocode}`);

  const out = compileAndRunC(res.pseudocode, `
int main(void) {
  printf("%lld %lld %lld\\n",
    (long long)if_else_merge(5, 7, 9),
    (long long)if_else_merge(0, 7, 9),
    (long long)if_else_merge(-3, 7, 9));
  return 0;
}
`);
  assert.equal(out, '17 18 18');
});

test('Pattern 1b: one-sided if merge phi inserts else edge copy and matches C execution', () => {
  const b = makeIRBuilder('one_sided_merge');
  const x0 = b.arg('x0', 64, true);
  const x1 = b.arg('x1', 64, true);

  b.block(0);
  const zero = b.constVal(0n, 64, true);
  const flags = b.cmp(x0, zero);
  b.cbr(flags, 'gt', 1, 2);

  b.block(1);
  const hundred = b.constVal(100n, 64, true);
  const bumped = b.bin('add', x1, hundred, 64, true);
  b.br(2);

  b.block(2);
  const merged = b.phi([[0, x1], [1, bumped]], 64, true);
  b.ret(merged.value);

  const res = decompileAndClose('one_sided_merge', b);
  assert.doesNotMatch(res.pseudocode, /\bphi\s*\(/, `unexpected phi(...) in:\n${res.pseudocode}`);

  const syntax = cSyntaxOk(res.pseudocode);
  assert.equal(syntax.ok, true, `GCC syntax failed:\n${syntax.stderr}\nCode:\n${res.pseudocode}`);

  const out = compileAndRunC(res.pseudocode, `
int main(void) {
  printf("%lld %lld\\n",
    (long long)one_sided_merge(1, 42),
    (long long)one_sided_merge(0, 42));
  return 0;
}
`);
  assert.equal(out, '142 42');
});

test('Pattern 2: loop induction variable + accumulator phi eliminates phi(...) and matches C execution', () => {
  const b = makeIRBuilder('loop_sum');
  const n = b.arg('x0', 64, true);

  b.block(0);
  const zeroI = b.constVal(0n, 64, true);
  const zeroS = b.constVal(0n, 64, true);
  b.br(1);

  b.block(1);
  const idx = b.phi([[0, zeroI], [2, null]], 64, true);
  const sum = b.phi([[0, zeroS], [2, null]], 64, true);
  const flags = b.cmp(idx.value, n);
  b.cbr(flags, 'lt', 2, 3);

  b.block(2);
  const one = b.constVal(1n, 64, true);
  const nextSum = b.bin('add', sum.value, idx.value, 64, true);
  const nextIdx = b.bin('add', idx.value, one, 64, true);
  b.patchPhiIncoming(idx, 2, nextIdx);
  b.patchPhiIncoming(sum, 2, nextSum);
  b.br(1);

  b.block(3);
  b.ret(sum.value);

  const res = decompileAndClose('loop_sum', b);
  assert.doesNotMatch(res.pseudocode, /\bphi\s*\(/, `unexpected phi(...) in:\n${res.pseudocode}`);

  const syntax = cSyntaxOk(res.pseudocode);
  assert.equal(syntax.ok, true, `GCC syntax failed:\n${syntax.stderr}\nCode:\n${res.pseudocode}`);

  const out = compileAndRunC(res.pseudocode, `
int main(void) {
  printf("%lld %lld %lld %lld\\n",
    (long long)loop_sum(0),
    (long long)loop_sum(1),
    (long long)loop_sum(5),
    (long long)loop_sum(10));
  return 0;
}
`);
  assert.equal(out, '0 0 10 45');
});

test('Pattern 3: mutual swap phi (a, b = b, a) breaks cycle with temporary variable and matches C execution', () => {
  const b = makeIRBuilder('mutual_swap_loop');
  const initA = b.arg('x0', 64, true);
  const initB = b.arg('x1', 64, true);
  const count = b.arg('x2', 64, true);

  b.block(0);
  const zero = b.constVal(0n, 64, true);
  b.br(1);

  b.block(1);
  const pa = b.phi([[0, initA], [2, null]], 64, true);
  const pb = b.phi([[0, initB], [2, null]], 64, true);
  const pi = b.phi([[0, zero], [2, null]], 64, true);
  const flags = b.cmp(pi.value, count);
  b.cbr(flags, 'lt', 2, 3);

  b.block(2);
  const one = b.constVal(1n, 64, true);
  const nextI = b.bin('add', pi.value, one, 64, true);
  // Mutual swap: (pa, pb) = (pb, pa)
  b.patchPhiIncoming(pa, 2, pb.value);
  b.patchPhiIncoming(pb, 2, pa.value);
  b.patchPhiIncoming(pi, 2, nextI);
  b.br(1);

  b.block(3);
  const ten = b.constVal(100n, 64, true);
  const scaled = b.bin('mul', pa.value, ten, 64, true);
  const packed = b.bin('add', scaled, pb.value, 64, true);
  b.ret(packed);

  const res = decompileAndClose('mutual_swap_loop', b);
  assert.doesNotMatch(res.pseudocode, /\bphi\s*\(/, `unexpected phi(...) in:\n${res.pseudocode}`);
  assert.match(res.pseudocode, /\bphi_tmp_\d+\b/, `expected cycle-breaking temp variable in:\n${res.pseudocode}`);

  const syntax = cSyntaxOk(res.pseudocode);
  assert.equal(syntax.ok, true, `GCC syntax failed:\n${syntax.stderr}\nCode:\n${res.pseudocode}`);

  const out = compileAndRunC(res.pseudocode, `
int main(void) {
  printf("%lld %lld %lld %lld\\n",
    (long long)mutual_swap_loop(3, 7, 0),
    (long long)mutual_swap_loop(3, 7, 1),
    (long long)mutual_swap_loop(3, 7, 2),
    (long long)mutual_swap_loop(3, 7, 3));
  return 0;
}
`);
  assert.equal(out, '307 703 307 703');
});

test('Pattern 3b: Fibonacci coupled phi (a, b = b, a + b) avoids lost-copy and matches C execution', () => {
  const b = makeIRBuilder('fib_phi');
  const n = b.arg('x0', 64, true);

  b.block(0);
  const zero0 = b.constVal(0n, 64, true);
  const one0 = b.constVal(1n, 64, true);
  const idx0 = b.constVal(0n, 64, true);
  b.br(1);

  b.block(1);
  const pa = b.phi([[0, zero0], [2, null]], 64, true);
  const pb = b.phi([[0, one0], [2, null]], 64, true);
  const pi = b.phi([[0, idx0], [2, null]], 64, true);
  const flags = b.cmp(pi.value, n);
  b.cbr(flags, 'lt', 2, 3);

  b.block(2);
  const sumAB = b.bin('add', pa.value, pb.value, 64, true);
  const step = b.constVal(1n, 64, true);
  const nextI = b.bin('add', pi.value, step, 64, true);
  b.patchPhiIncoming(pa, 2, pb.value);
  b.patchPhiIncoming(pb, 2, sumAB);
  b.patchPhiIncoming(pi, 2, nextI);
  b.br(1);

  b.block(3);
  b.ret(pa.value);

  const res = decompileAndClose('fib_phi', b);
  assert.doesNotMatch(res.pseudocode, /\bphi\s*\(/, `unexpected phi(...) in:\n${res.pseudocode}`);

  const syntax = cSyntaxOk(res.pseudocode);
  assert.equal(syntax.ok, true, `GCC syntax failed:\n${syntax.stderr}\nCode:\n${res.pseudocode}`);

  const out = compileAndRunC(res.pseudocode, `
int main(void) {
  printf("%lld %lld %lld %lld\\n",
    (long long)fib_phi(0),
    (long long)fib_phi(1),
    (long long)fib_phi(7),
    (long long)fib_phi(10));
  return 0;
}
`);
  assert.equal(out, '0 1 13 55');
});

test('Pattern 4: self-loop header with CBR back-edge evaluates condition before edge phi copies', () => {
  const b = makeIRBuilder('self_loop_countdown');
  const n = b.arg('x0', 64, true);

  b.block(0);
  const zero = b.constVal(0n, 64, true);
  b.br(1);

  b.block(1);
  const cur = b.phi([[0, n], [1, null]], 64, true);
  const acc = b.phi([[0, zero], [1, null]], 64, true);
  const one = b.constVal(1n, 64, true);
  const nextCur = b.bin('sub', cur.value, one, 64, true);
  const nextAcc = b.bin('add', acc.value, cur.value, 64, true);
  b.patchPhiIncoming(cur, 1, nextCur);
  b.patchPhiIncoming(acc, 1, nextAcc);
  const z = b.constVal(0n, 64, true);
  const flags = b.cmp(cur.value, z);
  b.cbr(flags, 'gt', 1, 2);

  b.block(2);
  b.ret(acc.value);

  const res = decompileAndClose('self_loop_countdown', b);
  assert.doesNotMatch(res.pseudocode, /\bphi\s*\(/, `unexpected phi(...) in:\n${res.pseudocode}`);

  const syntax = cSyntaxOk(res.pseudocode);
  assert.equal(syntax.ok, true, `GCC syntax failed:\n${syntax.stderr}\nCode:\n${res.pseudocode}`);

  const out = compileAndRunC(res.pseudocode, `
int main(void) {
  printf("%lld %lld %lld\\n",
    (long long)self_loop_countdown(0),
    (long long)self_loop_countdown(1),
    (long long)self_loop_countdown(5));
  return 0;
}
`);
  assert.equal(out, '0 1 15');
});
