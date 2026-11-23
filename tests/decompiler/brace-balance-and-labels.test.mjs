import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { decompileSemantic } from '../../js/decompiler/semantic-core.js';
import { enhanceSemanticDecompilation } from '../../js/decompiler/pipeline-core.js';
import { closeFunctionOutput } from '../../js/decompiler/c-output-closure.js';
import { OP, VK } from '../../js/ir-core.js';

function hasTool(cmd) {
  try {
    execFileSync(cmd, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

const HAS_AARCH64_GCC = hasTool('aarch64-linux-gnu-gcc');
const CC = hasTool('aarch64-linux-gnu-gcc')
  ? 'aarch64-linux-gnu-gcc'
  : hasTool('gcc')
    ? 'gcc'
    : hasTool('clang')
      ? 'clang'
      : null;

function stripCNonCode(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

function assertBalancedBraces(code, context = '') {
  const cleaned = stripCNonCode(code);
  let depth = 0;
  let opens = 0;
  let closes = 0;
  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (ch === '{') {
      depth += 1;
      opens += 1;
    } else if (ch === '}') {
      depth -= 1;
      closes += 1;
      assert.ok(depth >= 0, `${context}: brace depth went negative (${depth}) at char ${i}\n${code}`);
    }
  }
  assert.equal(depth, 0, `${context}: unbalanced braces (opens=${opens}, closes=${closes}, finalDepth=${depth})\n${code}`);
  assert.ok(opens > 0, `${context}: expected at least one function body block\n${code}`);
}

function assertAllGotoTargetsDefined(code, context = '') {
  const gotos = [...code.matchAll(/\bgoto\s+(loc_[0-9A-Fa-f]+)\s*;/g)].map((m) => m[1]);
  for (const label of gotos) {
    assert.match(code, new RegExp(`\\b${label}:`), `${context}: undefined goto target ${label}\n${code}`);
  }
}

function assertCSyntaxOk(code, context = '') {
  if (!CC) return;
  try {
    execFileSync(CC, ['-x', 'c', '-fsyntax-only', '-w', '-'], {
      input: code,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = String(err.stderr || err.message || '');
    assert.doesNotMatch(stderr, /label ['‘]loc_[0-9A-Fa-f]+['’] used but not defined/, `${context}: undefined label error:\n${stderr}\n${code}`);
    assert.fail(`${context}: C syntax check failed:\n${code}\n--- stderr ---\n${stderr}`);
  }
}

function makeIR(blocks, values, args = new Map(), extra = {}) {
  const instructions = blocks.flatMap((b) => [...(b.phis || []), ...(b.insts || [])]);
  const ir = {
    entry: 0,
    blocks,
    values,
    instructions,
    args,
    locations: new Map(),
    stackSlots: [],
    loops: [],
    byRow: new Map(),
    ...extra,
  };
  for (const inst of instructions) {
    if (inst.row != null && !ir.byRow.has(inst.row)) ir.byRow.set(inst.row, inst);
  }
  return ir;
}

test('1. faithfulCfg conditional phi-copy edge emits atomic single-line compound goto and stays brace-balanced', () => {
  // 5-block CFG with shared early-exit block B4 (matching idx 930 structure):
  //   B0: if (a1 == 0) goto B4; else goto B1;
  //   B1: if (a2 == 0) { phi_9 = 10; goto B3; } else goto B2;
  //   B2: phi_9 = 20; goto B3;
  //   B3: if (phi_9 == 0) goto B4; else return phi_9;
  //   B4: return 0;
  // Shared exit B4 forces faithfulCfg (linear mode), and B1->B3 carries a PHI copy
  // that must be emitted as a self-balanced single-line compound statement.
  const a1 = { id: 1, bits: 64, signed: false, kind: VK.ARG, reg: 'x0', def: null, uses: [] };
  const a2 = { id: 2, bits: 64, signed: false, kind: VK.ARG, reg: 'x1', def: null, uses: [] };
  const c0 = { id: 3, bits: 64, signed: false, kind: VK.CONST, const: 0n, def: null, uses: [] };
  const c10 = { id: 4, bits: 64, signed: false, kind: VK.CONST, const: 10n, def: null, uses: [] };
  const c20 = { id: 5, bits: 64, signed: false, kind: VK.CONST, const: 20n, def: null, uses: [] };
  const fl0 = { id: 6, bits: 64, signed: false, kind: VK.REG, reg: 'nzcv', def: null, uses: [] };
  const fl1 = { id: 7, bits: 64, signed: false, kind: VK.REG, reg: 'nzcv', def: null, uses: [] };
  const fl3 = { id: 8, bits: 64, signed: false, kind: VK.REG, reg: 'nzcv', def: null, uses: [] };
  const phiDst = { id: 9, bits: 64, signed: false, kind: VK.REG, reg: 'x0', def: null, uses: [] };

  const iCmp0 = { id: 1, row: 0, address: 0x1000n, block: 0, op: OP.CMP, dst: fl0, args: [{ value: a1 }, { value: c0 }] };
  const iCbr0 = { id: 2, row: 1, address: 0x1004n, block: 0, op: OP.CBR, cond: 'eq', args: [{ value: fl0 }], extra: { cond: 'eq', target: 0x1028n, fallthrough: 0x1008n } };

  const iCmp1 = { id: 3, row: 2, address: 0x1008n, block: 1, op: OP.CMP, dst: fl1, args: [{ value: a2 }, { value: c0 }] };
  const iCbr1 = { id: 4, row: 3, address: 0x100cn, block: 1, op: OP.CBR, cond: 'eq', args: [{ value: fl1 }], extra: { cond: 'eq', target: 0x1018n, fallthrough: 0x1010n } };

  const iBr2 = { id: 5, row: 4, address: 0x1010n, block: 2, op: OP.BR, args: [], target: 3 };

  const iPhi = { id: 6, row: 5, address: 0x1018n, block: 3, op: OP.PHI, dst: phiDst, args: [], incoming: [{ from: 1, value: c10 }, { from: 2, value: c20 }] };
  const iCmp3 = { id: 7, row: 6, address: 0x101cn, block: 3, op: OP.CMP, dst: fl3, args: [{ value: phiDst }, { value: c0 }] };
  const iCbr3 = { id: 8, row: 7, address: 0x1020n, block: 3, op: OP.CBR, cond: 'eq', args: [{ value: fl3 }], extra: { cond: 'eq', target: 0x1008n, fallthrough: 0x1024n } };

  const iRet4 = { id: 9, row: 8, address: 0x1024n, block: 4, op: OP.RET, args: [{ value: phiDst }] };
  const iRet5 = { id: 10, row: 9, address: 0x1028n, block: 5, op: OP.RET, args: [{ value: c0 }] };

  a1.uses.push(iCmp0);
  a2.uses.push(iCmp1);
  c0.uses.push(iCmp0, iCmp1, iCmp3, iRet5);
  c10.uses.push(iPhi);
  c20.uses.push(iPhi);
  fl0.def = iCmp0; fl0.uses.push(iCbr0);
  fl1.def = iCmp1; fl1.uses.push(iCbr1);
  fl3.def = iCmp3; fl3.uses.push(iCbr3);
  phiDst.def = iPhi; phiDst.uses.push(iCmp3, iRet4);

  const blocks = [
    { index: 0, startRow: 0, endRow: 1, address: 0x1000n, pred: [], succ: [5, 1], phis: [], insts: [iCmp0, iCbr0] },
    { index: 1, startRow: 2, endRow: 3, address: 0x1008n, pred: [0, 3], succ: [3, 2], phis: [], insts: [iCmp1, iCbr1] },
    { index: 2, startRow: 4, endRow: 4, address: 0x1010n, pred: [1], succ: [3], phis: [], insts: [iBr2] },
    { index: 3, startRow: 5, endRow: 7, address: 0x1018n, pred: [1, 2], succ: [1, 4], phis: [iPhi], insts: [iCmp3, iCbr3] },
    { index: 4, startRow: 8, endRow: 8, address: 0x1024n, pred: [3], succ: [], phis: [], insts: [iRet4] },
    { index: 5, startRow: 9, endRow: 9, address: 0x1028n, pred: [0], succ: [], phis: [], insts: [iRet5] },
  ];
  const ir = makeIR(blocks, [a1, a2, c0, c10, c20, fl0, fl1, fl3, phiDst], new Map([['x0', a1], ['x1', a2]]));
  const model = {
    name: 'func_phi_cbr',
    address: 0x1000n,
    arch: 'arm64',
    instructions: ir.instructions.map((i) => ({ row: i.row, address: i.address, mnemonic: 'nop', ops: [], reads: [], writes: [] })),
    calls: [],
    switches: [],
  };

  const rowOfAddress = (addr) => model.instructions.find((i) => i.address === addr)?.row ?? null;
  const sem = decompileSemantic(model, { ir, rowOfAddress });
  assert.ok(sem && sem.pseudocode, 'decompileSemantic should return output');
  assert.equal(sem.coverage.mode, 'linear', 'shared-exit CFG should fall back to faithfulCfg');
  assertBalancedBraces(sem.pseudocode, 'semantic-core');
  assertAllGotoTargetsDefined(sem.pseudocode, 'semantic-core');

  // Verify conditional phi-copy goto lines are self-balanced on a single line
  const cbrPhiLines = sem.lines.filter((l) => l.text.startsWith('if (') && l.text.includes('phi_9 = 10;') && l.text.includes('goto loc_'));
  assert.ok(cbrPhiLines.length >= 1, `expected atomic single-line conditional phi-copy goto:\n${sem.pseudocode}`);
  for (const line of cbrPhiLines) {
    const opens = (line.text.match(/\{/g) || []).length;
    const closes = (line.text.match(/\}/g) || []).length;
    assert.equal(opens, 1, `expected 1 opening brace on atomic conditional phi-copy goto: ${line.text}`);
    assert.equal(closes, 1, `expected 1 closing brace on atomic conditional phi-copy goto: ${line.text}`);
  }

  const enhanced = enhanceSemanticDecompilation(sem, model, {});
  closeFunctionOutput(enhanced);
  assertBalancedBraces(enhanced.pseudocode, 'enhanced+closed');
  assertAllGotoTargetsDefined(enhanced.pseudocode, 'enhanced+closed');
  assertCSyntaxOk(enhanced.pseudocode, 'enhanced+closed');
});

const HUMANEVAL_CASES = [
  {
    idx: 930,
    source: `#include <stdio.h>
#include <limits.h>

int *func0(int arr[], int length, int output[2]) {
    int smallestEven = INT_MAX;
    int index = -1;
    for (int i = 0; i < length; ++i) {
        if (arr[i] % 2 == 0 && (arr[i] < smallestEven || index == -1)) {
            smallestEven = arr[i];
            index = i;
        }
    }
    if (index == -1) {
        return NULL;
    }
    output[0] = smallestEven;
    output[1] = index;
    return output;
}
`,
  },
  {
    idx: 1182,
    source: `#include <stdio.h>

int func0(int n) {
    int prod = 1, has_odd = 0, digit;
    while (n > 0) {
        digit = n % 10;
        if (digit % 2 == 1) {
            has_odd = 1;
            prod *= digit;
        }
        n /= 10;
    }
    return has_odd ? prod : 0;
}
`,
  },
  {
    idx: 1202,
    source: `#include <stdio.h>

void func0(const int *lst, int size, int result[2]) {
    int maxneg = 0;
    int minpos = 0;
    for (int i = 0; i < size; i++) {
        if (lst[i] < 0 && (maxneg == 0 || lst[i] > maxneg)) maxneg = lst[i];
        if (lst[i] > 0 && (minpos == 0 || lst[i] < minpos)) minpos = lst[i];
    }
    result[0] = maxneg;
    result[1] = minpos;
}
`,
  },
];

for (const tc of HUMANEVAL_CASES) {
  test(`2. HumanEval-Decompile idx ${tc.idx} (ARM64 -O2) has balanced braces and zero undefined loc_XXX labels`, { skip: !HAS_AARCH64_GCC }, () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `hex-brace-${tc.idx}-`));
    try {
      const cPath = path.join(tmpDir, `idx_${tc.idx}.c`);
      const oPath = path.join(tmpDir, `idx_${tc.idx}.o`);
      fs.writeFileSync(cPath, tc.source);
      execFileSync('aarch64-linux-gnu-gcc', ['-O2', '-c', cPath, '-o', oPath]);
      const out = execFileSync(process.execPath, ['tools/validation/public-benchmark/subject.mjs', oPath], {
        encoding: 'utf8',
      });
      const parsed = JSON.parse(out);
      const fn = parsed.functions.find((f) => f.name === 'func0') || parsed.functions[0];
      assert.ok(fn && fn.pseudocode, `idx ${tc.idx}: subject.mjs should produce pseudocode for func0`);
      assertBalancedBraces(fn.pseudocode, `idx ${tc.idx}`);
      assertAllGotoTargetsDefined(fn.pseudocode, `idx ${tc.idx}`);
      assertCSyntaxOk(fn.pseudocode, `idx ${tc.idx}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
}
