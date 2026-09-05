import assert from 'node:assert/strict';
import {
  normalizeRiscvIsaString,
  parseRiscvMappingSymbol,
  resolveRiscvIsaProfile,
} from '../js/binary/riscv-isa.js';

// 1. primitive ISA stringの既存normalizationを維持
{
  const v = normalizeRiscvIsaString('rv64imc');
  assert.ok(v);
  assert.equal(v.canonical, 'rv64imc');
  assert.equal(v.xlen, 64);
  assert.equal(v.compressedInstructions, true);
  assert.equal(v.instructionAlignment, 2);
  const v32 = normalizeRiscvIsaString('RV32I');
  assert.ok(v32);
  assert.equal(v32.xlen, 32);
  assert.equal(v32.instructionAlignment, 4);
}

// 2. Array/Object/boolean/numberをISA stringへ昇格しない
{
  assert.equal(normalizeRiscvIsaString(['rv64imc']), null);
  assert.equal(normalizeRiscvIsaString({ toString: () => 'rv64imc' }), null);
  assert.equal(normalizeRiscvIsaString(64), null);
  assert.equal(normalizeRiscvIsaString(true), null);
  assert.equal(normalizeRiscvIsaString(null), null);
  assert.equal(normalizeRiscvIsaString(undefined), null);
}

// 3. mapping symbolもprimitive string-only
{
  assert.equal(parseRiscvMappingSymbol(['$xrv64imc']), null);
  assert.equal(parseRiscvMappingSymbol(123), null);
  const ok = parseRiscvMappingSymbol('$xrv64imc');
  assert.ok(ok);
  assert.equal(ok.kind, 'instruction');
  assert.equal(ok.isa.canonical, 'rv64imc');
  assert.deepEqual(parseRiscvMappingSymbol('$d'), { kind: 'data', isa: null });
  assert.deepEqual(parseRiscvMappingSymbol('$x'), { kind: 'instruction', isa: null });
}

// 4. structured canonical/xlen/instructionAlignmentをexact profileへ昇格しない
{
  const bad = resolveRiscvIsaProfile({
    file: {
      canonical: ['rv64imc'],
      xlen: ['64'],
      instructionAlignment: ['2'],
      compressedInstructions: true,
      evidence: 'elf-attribute',
    },
  }, 0n, { allowAssumed: false });
  assert.equal(bad, null);
  // allowAssumed時はnon-exact fallbackのみ (exact profileは生成しない)
  const fallback = resolveRiscvIsaProfile({
    file: {
      canonical: ['rv64imc'],
      xlen: ['64'],
      instructionAlignment: ['2'],
      compressedInstructions: true,
    },
  }, 0n, {});
  assert.equal(fallback.exact, false);
}

// 5. valid file profileはそのまま維持
{
  const good = resolveRiscvIsaProfile({
    file: {
      canonical: 'rv64imc',
      xlen: 64,
      instructionAlignment: 2,
      compressedInstructions: true,
      evidence: 'elf-attribute',
    },
  }, 0n, { allowAssumed: false });
  assert.ok(good);
  assert.equal(good.exact, true);
  assert.equal(good.canonical, 'rv64imc');
  assert.equal(good.xlen, 64);
  assert.equal(good.instructionAlignment, 2);
}

// 6. xlen/alignmentの型違いはexactにしない
{
  assert.equal(resolveRiscvIsaProfile({
    file: { canonical: 'rv64imc', xlen: '64', instructionAlignment: 2, compressedInstructions: true },
  }, 0n, { allowAssumed: false }), null);
  assert.equal(resolveRiscvIsaProfile({
    file: { canonical: 'rv64imc', xlen: 64, instructionAlignment: '2', compressedInstructions: true },
  }, 0n, { allowAssumed: false }), null);
  assert.equal(resolveRiscvIsaProfile({
    file: { canonical: 12345, xlen: 64, instructionAlignment: 2, compressedInstructions: true },
  }, 0n, { allowAssumed: false }), null);
}

console.log('issue #5150 riscv ISA strict primitive authority: PASS');
