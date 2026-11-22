import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSemanticModel } from '../../js/blocks.js';
import { decompile } from '../../js/decompile.js';
import { decompile as baseDecompile } from '../../js/decompile-base.js';
import { decompile as legacyDecompile } from '../../js/decompile-legacy.js';
import { buildIR as baseBuildIR, branchConstraints as baseBranchConstraints } from '../../js/ir-base.js';
import { buildIR, irFor, branchConstraints, OP, VK } from '../../js/ir.js';

const BASE = 0x10000n;

function makeModel(lines, extra = {}) {
  const raw = lines.map((entry, row) => {
    if (typeof entry === 'string') {
      const p = entry.indexOf(' ');
      return {
        row,
        address: BASE + BigInt(row * 4),
        mn: p < 0 ? entry : entry.slice(0, p),
        ops: p < 0 ? '' : entry.slice(p + 1),
      };
    }
    return { row, address: BASE + BigInt(row * 4), ...entry };
  });
  const rowOfAddress = (addr) => {
    const d = BigInt(addr) - BASE;
    if (d < 0n || d >= BigInt(raw.length * 4) || d % 4n !== 0n) return null;
    return Number(d / 4n);
  };
  const addrOfRow = (row) => raw[row]?.address ?? null;
  const symbolFor = extra.symbolFor || (() => null);
  const opts = {
    startRow: 0,
    endRow: raw.length - 1,
    addr: BASE,
    rowOfAddress,
    addrOfRow,
    symbolFor,
    ...extra,
  };
  const model = buildSemanticModel(raw, opts);
  return { model, opts, raw };
}

function renderLines(result) {
  return (result.lines || []).map((l) => `${'    '.repeat(Math.max(0, l.indent || 0))}${l.text || ''}`).join('\n');
}

test('1. lowerArm64RawAssembly runs inside finalize before closePublicCOutput (declares storage & aligns provenance)', () => {
  const { model, opts } = makeModel([
    'addv s0, v1.4s',
    'str s0, [x0]',
    'ret',
  ]);
  const baseRes = baseDecompile(model, { ...opts, forceLegacyDecompiler: true, name: 'arm64_addv_base' });
  const pubRes = decompile(model, { ...opts, forceLegacyDecompiler: true, name: 'arm64_addv_pub' });
  for (const [label, res] of [['baseDecompile', baseRes], ['decompile', pubRes]]) {
    const text = renderLines(res);
    assert.match(text, /__a64_addv_4s/, `${label} should lower addv raw assembly:\n${text}`);
    assert.doesNotMatch(text, /__asm\("addv/i, `${label} should not leave raw addv __asm:\n${text}`);
    assert.match(text, /typedef\b.*\b(?:uint128|vector128)\b/, `${label} should emit 128-bit typedef:\n${text}`);
    assert.match(text, /\b(?:uint128|vector128)\s+v0\s*;/, `${label} should declare lowered v0 local:\n${text}`);
    assert.match(text, /\b(?:uint128|vector128)\s+v1\s*;/, `${label} should declare lowered v1 local:\n${text}`);
    if (res.renderProvenance?.entries) {
      for (const entry of res.renderProvenance.entries) {
        if (entry?.lineIndex != null) {
          assert.ok(
            entry.lineIndex >= 0 && entry.lineIndex < res.lines.length,
            `${label} provenance lineIndex ${entry.lineIndex} out of bounds (${res.lines.length})`,
          );
        }
      }
    }
  }
});

test('2. forceLegacyDecompiler and semanticIR: false run finalize() and closePublicCOutput()', () => {
  const { model, opts } = makeModel([
    'add x8, x0, #5',
    'sxtw x9, w8',
    'add x0, x8, x9',
    'ret',
  ]);
  for (const flag of [{ forceLegacyDecompiler: true }, { semanticIR: false }]) {
    const res = baseDecompile(model, { ...opts, ...flag, name: 'legacy_closed' });
    const text = renderLines(res);
    assert.ok(
      res.lines.some((l) => /^typedef\b/.test((l.text || '').trim())),
      `expected fixed-width typedef prelude for ${JSON.stringify(flag)}:\n${text}`,
    );
    assert.match(text, /\b(?:uint64|int64|int32)\s+x8\s*;/, `expected local x8 declaration:\n${text}`);
  }
});

test('3. ir-base buildIR does not shadow ir-public-base branchConstraints with stale cache', () => {
  const { model, opts } = makeModel([
    'mov w1, #0x80000001',
    'ror w1, w1, #1',
    'cmp w0, w1',
    'b.eq #0x10010',
    'nop',
    'ret',
  ]);
  const rawIr = baseBuildIR(model, opts);
  assert.ok(rawIr, 'baseBuildIR should succeed');
  assert.equal(rawIr._branchConstraints, undefined, 'baseBuildIR must not eagerly pre-cache _branchConstraints');

  // Even if baseBranchConstraints is called first on a synthetic IR with a MOV-projected constant,
  // public branchConstraints() must still compute the enhanced projected constant rather than reusing stale cache.
  const cVal = { id: 'v_const', kind: VK.CONST, const: 42n, bits: 32 };
  const movInst = { id: 'i_mov', op: OP.MOV, args: [{ value: cVal, bits: 32 }], bits: 32 };
  const movedVal = { id: 'v_moved', kind: VK.TEMP, const: null, bits: 32, def: movInst };
  const argVal = { id: 'v_arg', kind: VK.ARG, reg: 'w0', bits: 32 };
  const cmpInst = { id: 'i_cmp', op: OP.CMP, args: [{ value: argVal, bits: 32 }, { value: movedVal, bits: 32 }], bits: 32 };
  const flagsVal = { id: 'v_flags', kind: VK.TEMP, bits: 64, def: cmpInst };
  const cbrInst = { id: 'i_cbr', op: OP.CBR, cond: 'eq', args: [{ value: flagsVal, bits: 64 }] };
  const syntheticIr = { instructions: [movInst, cmpInst, cbrInst] };

  const baseFacts = baseBranchConstraints(syntheticIr);
  assert.equal(baseFacts.length, 0, 'ir-base cannot fold non-const MOV projection');

  const publicFacts = branchConstraints(syntheticIr);
  assert.equal(publicFacts.length, 1, 'ir-public-base must not be shadowed by ir-base _branchConstraints');
  assert.equal(publicFacts[0].taken.constant, 42n);

  const pubIr = irFor(model, opts);
  const facts = branchConstraints(pubIr);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].taken.constant, 0xc0000000n);
});

test('4. buildV2CompatFromLegacyModel skips data-only basic blocks without crashing to legacy fallback', () => {
  const { model, opts } = makeModel([
    'add x0, x0, #1',
    'ret',
    { mn: '.word', ops: '0x12345678', data: true },
  ]);
  const ir = buildIR(model, opts);
  assert.ok(ir, 'buildIR should succeed when a trailing basic block is data-only');
  assert.equal(ir.blocks.length, 1);

  const res = decompile(model, { ...opts, name: 'with_literal_pool' });
  assert.equal(res.semantic, true, 'decompile should stay on Semantic IR instead of falling back to legacy');
  assert.notEqual(res.legacyFallback, true);
  assert.match(renderLines(res), /return\b/);

  const allData = makeModel([
    { mn: '.word', ops: '0xdeadbeef', data: true },
    { mn: '.word', ops: '0xcafebabe', data: true },
  ]);
  assert.equal(buildIR(allData.model, allData.opts), null, 'all-data model should return null cleanly without throwing');
});

test('5. decompile-base handles conditional non-natural backward edge without duplicate legacy failures', () => {
  const { model, opts } = makeModel([
    'cbz x0, #0x10010',
    'add x0, x0, #1',
    'b #0x10014',
    'ret',
    'subs x1, x1, #1',
    'b.ne #0x10004',
    'ret',
  ]);
  const res = decompile(model, { ...opts, name: 'cond_non_natural_backedge' });
  assert.ok(res && Array.isArray(res.lines) && res.lines.length > 0);
  const text = renderLines(res);
  assert.match(text, /return\b/);
});

test('6a. decompile-legacy never emits 0x? for unresolved adrp/adr targets', () => {
  const { model, opts } = makeModel([
    'adrp x8, #0x1000',
    'adr x9, sym_missing',
    'add x0, x8, x9',
    'ret',
  ]);
  for (const insn of model.instructions) insn.pcRelTarget = null;
  model.refs = [];
  const res = legacyDecompile(model, { ...opts, name: 'unresolved_adrp' });
  const text = renderLines(res);
  assert.doesNotMatch(text, /0x\?/, `must not emit invalid C token 0x?:\n${text}`);
  assert.match(text, /unresolved adrp target/, `should document unresolved adrp cleanly:\n${text}`);
  assert.match(text, /unresolved adr target/, `should document unresolved adr cleanly:\n${text}`);
});

test('6b. decompile-legacy lowers bfi/bfxil/ubfx/sbfx/ubfiz to valid C bitfield expressions', () => {
  const { model, opts } = makeModel([
    'ubfx x11, x0, #4, #8',
    'sbfx w9, w1, #2, #6',
    'ubfiz x10, x2, #3, #5',
    'bfi x8, x1, #4, #8',
    'bfxil x10, x0, #8, #4',
    'str x11, [x0]',
    'add x0, x8, x10',
    'add x0, x0, x9',
    'ret',
  ]);
  const res = legacyDecompile(model, { ...opts, name: 'bitfield_ops' });
  const text = renderLines(res);
  assert.doesNotMatch(text, /\b(?:bfi|bfxil|ubfx|sbfx|ubfiz)\s*\(/, `must not emit undeclared mnemonic calls:\n${text}`);
  assert.match(text, /0xFFULL/, `expected 8-bit 64-bit mask for ubfx/bfi:\n${text}`);
  assert.match(text, /0x1FULL/, `expected 5-bit mask for ubfiz:\n${text}`);
  assert.match(text, /0xFF0ULL/, `expected shifted clear mask for bfi:\n${text}`);
  assert.match(text, /0xFULL/, `expected 4-bit mask for bfxil:\n${text}`);
});

test('6c. decompile-legacy emitLoop keeps headCond header body inside loop and omits redundant trailing continue', () => {
  // Header performs a side-effecting store on every iteration before testing exit condition.
  const { model, opts } = makeModel([
    'str x1, [x0]',        // 0x10000: header with side effect
    'cmp x0, x2',          // 0x10004: compare
    'b.ge #0x10014',       // 0x10008: exit to 0x10014
    'add x0, x0, #8',      // 0x1000c: body
    'b #0x10000',          // 0x10010: back edge to header
    'ret',                 // 0x10014: exit
  ]);
  const res = legacyDecompile(model, { ...opts, name: 'head_cond_with_store' });
  const text = renderLines(res);
  assert.match(text, /while \(1\)/, `headCond with executable header body must use while (1):\n${text}`);
  assert.match(text, /while \(1\)[\s\S]*\*\(uint64 \*\)\(a1\) = a2;[\s\S]*if \([^\n]*>=[^\n]*\) break;/, `header store & exit check must be inside loop:\n${text}`);
  assert.doesNotMatch(text, /^\s*continue;\s*$/m, `must not emit redundant trailing continue:\n${text}`);

  // Pure compare header keeps idiomatic while (...) without trailing continue.
  const pureHead = makeModel([
    'cmp x0, x1',          // 0x10000: header
    'b.ge #0x10010',       // 0x10004: exit
    'add x0, x0, #1',      // 0x10008: body
    'b #0x10000',          // 0x1000c: back edge
    'ret',                 // 0x10010: exit
  ]);
  const pureRes = legacyDecompile(pureHead.model, { ...pureHead.opts, name: 'head_cond_pure' });
  const pureText = renderLines(pureRes);
  assert.match(pureText, /while \(a1 < a2\)/, `pure compare header should stay while (a1 < a2):\n${pureText}`);
  assert.doesNotMatch(pureText, /^\s*continue;\s*$/m, `pure headCond must not emit redundant trailing continue:\n${pureText}`);
});

test('6d. decompile-legacy emitLoop preserves header branches in multi-block tailCond do-while loops', () => {
  // Single-exit natural loop with a tailCond latch and a conditional branch in the header.
  const { model, opts } = makeModel([
    'cbz x0, #0x10008',    // 0x10000: header skips body if x0 == 0
    'add x2, x2, #1',      // 0x10004: conditional body
    'subs x1, x1, #1',     // 0x10008: latch
    'b.ne #0x10000',       // 0x1000c: tailCond back edge to header
    'mov x0, x2',          // 0x10010: single exit
    'ret',                 // 0x10014
  ]);
  const res = legacyDecompile(model, { ...opts, name: 'tail_cond_header_branch' });
  const text = renderLines(res);
  assert.match(text, /\bdo\s*\{/, `expected do-while loop:\n${text}`);
  assert.match(text, /if \(a1 (?:==|!=) 0\)/, `header conditional branch must be preserved inside do-while:\n${text}`);
  assert.match(text, /\}\s*while\s*\(/, `expected closing while condition:\n${text}`);
});
