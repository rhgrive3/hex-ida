import test from 'node:test';
import assert from 'node:assert/strict';

import { publishELFRelocationTargets } from '../../../js/binary/elf-relocation-target.js';

/*
 * C1 adversarial counterexamples: ELF relocation targets are corroborating
 * evidence only and never a function-start authority, and malformed or
 * unresolvable records fail closed instead of manufacturing a target.
 *
 * The base image is a minimal AArch64 64-bit BinaryImage stand-in; the
 * relocation parser contract only needs `relocations`, `symbols`, `bits`,
 * `metadata.machine` and a mapping query.
 */

const R_AARCH64_ABS64 = 257;
const R_AARCH64_JUMP_SLOT = 1026;
const R_AARCH64_RELATIVE = 1027;
const EM_AARCH64 = 183;
const EM_X86_64 = 62;

const MAPPED = 0x401000n;
const UNMAPPED = 0x900000n;

function makeImage({ machine = EM_AARCH64, relocations = [], symbols = [], mapped = new Set([MAPPED.toString()]) } = {}) {
  return {
    bits: 64,
    metadata: { machine },
    relocations,
    symbols,
    functions: [],
    segmentAt(address) { return mapped.has(address.toString()) ? { address } : null; },
    sectionAt() { return null; },
  };
}

test('C1: a mapped R_AARCH64_RELATIVE addend is published as evidence only', () => {
  const image = makeImage({
    relocations: [{ type: R_AARCH64_RELATIVE, symbolIndex: 0, addend: MAPPED, address: 0x402000n }],
  });
  const published = publishELFRelocationTargets(image);
  assert.equal(published.length, 1);
  assert.equal(published[0].address, MAPPED);
  assert.equal(published[0].provenance, 'elf-relocation-target');
  assert.deepEqual(image.functions, [], 'publication must never create a function start');
});

test('C1: a relocation whose target is not mapped fails closed', () => {
  const image = makeImage({
    relocations: [{ type: R_AARCH64_RELATIVE, symbolIndex: 0, addend: UNMAPPED, address: 0x402000n }],
  });
  assert.deepEqual(publishELFRelocationTargets(image), []);
  assert.deepEqual(image.functions, []);
});

test('C1: malformed addends, symbol indexes and symbol definitions fail closed', () => {
  const defined = { index: 7, tableIndex: 0, defined: true, address: MAPPED, name: 'func' };
  const undefinedSymbol = { index: 7, tableIndex: 0, defined: false, address: null, name: 'extern' };
  const cases = [
    ['relative with a non-zero symbol index', { type: R_AARCH64_RELATIVE, symbolIndex: 3, addend: MAPPED, address: 0x402000n }],
    ['relative with a null addend', { type: R_AARCH64_RELATIVE, symbolIndex: 0, addend: null, address: 0x402000n }],
    ['relative with a negative addend', { type: R_AARCH64_RELATIVE, symbolIndex: 0, addend: -1n, address: 0x402000n }],
    ['absolute pointer with an undefined symbol', { type: R_AARCH64_ABS64, symbolIndex: 7, symbolTableIndex: 0, addend: 0n, address: 0x402000n }],
    ['absolute pointer with an unresolvable symbol index', { type: R_AARCH64_JUMP_SLOT, symbolIndex: 99, symbolTableIndex: 0, addend: 0n, address: 0x402000n }],
    ['absolute pointer with a null source address', { type: R_AARCH64_ABS64, symbolIndex: 7, symbolTableIndex: 0, addend: 0n, address: null }],
  ];
  for (const [label, relocation] of cases) {
    const image = makeImage({ relocations: [relocation], symbols: [defined, undefinedSymbol] });
    assert.deepEqual(publishELFRelocationTargets(image), [], label);
    assert.deepEqual(image.functions, [], `${label}: no start`);
  }
});

test('C1: a defined absolute symbol resolves to its own mapped address', () => {
  const image = makeImage({
    relocations: [{ type: R_AARCH64_JUMP_SLOT, symbolIndex: 7, symbolTableIndex: 0, addend: 0n, address: 0x402000n }],
    symbols: [{ index: 7, tableIndex: 0, defined: true, address: MAPPED, name: 'func' }],
  });
  const published = publishELFRelocationTargets(image);
  assert.equal(published.length, 1);
  assert.equal(published[0].address, MAPPED);
  assert.equal(published[0].symbol, 'func');
});

test('C1: a non-AArch64 image publishes nothing and creates no start', () => {
  const image = makeImage({
    machine: EM_X86_64,
    relocations: [{ type: R_AARCH64_RELATIVE, symbolIndex: 0, addend: MAPPED, address: 0x402000n }],
  });
  assert.deepEqual(publishELFRelocationTargets(image), []);
  assert.deepEqual(image.functions, []);
});

test('C1: publication order is canonical across input order', () => {
  const relocations = [
    { type: R_AARCH64_RELATIVE, symbolIndex: 0, addend: MAPPED, address: 0x402000n },
    { type: R_AARCH64_RELATIVE, symbolIndex: 0, addend: MAPPED, address: 0x402008n },
  ];
  const project = (rows) => rows.map((row) => ({
    address: row.address, sourceAddress: row.sourceAddress, relocationType: row.relocationType,
  }));
  const forward = publishELFRelocationTargets(makeImage({ relocations }));
  const reverse = publishELFRelocationTargets(makeImage({ relocations: [...relocations].reverse() }));
  // The published array is sorted by source address, so the observable evidence
  // is order-independent. (`id` embeds the raw input index, which is stable for
  // a given binary because relocation parsing order is deterministic.)
  assert.deepEqual(project(forward), project(reverse));
  assert.deepEqual(forward.map((row) => row.sourceAddress), [0x402000n, 0x402008n]);
});
