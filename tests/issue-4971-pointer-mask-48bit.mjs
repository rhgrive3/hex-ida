// Regression boundary: pointerAt() canonicalization must preserve the full lower-48 VA, drop only tag/PAC high bits, and fail closed (no dereference) when no real VA remains.
import assert from 'node:assert/strict';
import { resolveModelTexts } from '../js/analyze.js';

const CELL_ADDR = 0x1000n;

function le64(value) {
  const v = BigInt(value);
  const bytes = new Uint8Array(8);
  for (let i = 0; i < 8; i++) bytes[i] = Number((v >> BigInt(8 * i)) & 0xffn);
  return bytes;
}

function pointerCellBackend(cellRaw, indirect) {
  const reads = [];
  return {
    reads,
    async readAt(addr) {
      reads.push(BigInt(addr));
      if (BigInt(addr) === CELL_ADDR) return { found: true, bytes: le64(cellRaw) };
      if (indirect && BigInt(addr) === indirect.addr) {
        return { found: true, terminated: true, text: indirect.text, bytes: le64(0) };
      }
      return { found: false, bytes: new Uint8Array() };
    },
  };
}

function modelAt(addr) {
  return {
    addressRefs: [{ addr, row: 0, value: null }],
    semantic: [],
    calls: [],
    facts: { stringRefs: [], strings: [] },
  };
}

async function resolve(cellRaw, indirect) {
  const backend = pointerCellBackend(cellRaw, indirect);
  const model = await resolveModelTexts(backend, modelAt(CELL_ADDR));
  return { reads: backend.reads, ref: model.addressRefs[0] };
}

const tagged = 0xabcd123456789abcn;
const taggedVa = tagged & 0x0000ffffffffffffn;
assert.equal(taggedVa, 0x123456789abcn);
{
  const { reads, ref } = await resolve(tagged, { addr: taggedVa, text: 'indirect string' });
  assert.ok(reads.includes(taggedVa), `bit36..47 preserved: must dereference ${taggedVa.toString(16)}, saw ${reads.map((r) => r.toString(16)).join(',')}`);
  assert.ok(!reads.includes(0x456789abcn), 'must not dereference the 36-bit-truncated alias');
  assert.equal(ref.text, 'indirect string');
  assert.equal(ref.viaPointer, true);
}

{
  const canonical = 0x00007fff12345000n;
  assert.ok(canonical < 0x0001000000000000n);
  const { reads, ref } = await resolve(canonical, { addr: canonical, text: 'direct-ish' });
  assert.ok(reads.includes(canonical), 'canonical <2^48 pointer must be dereferenced unchanged');
  assert.equal(ref.text, 'direct-ish');
}

{
  const { reads, ref } = await resolve(0n, null);
  assert.deepEqual(reads, [CELL_ADDR], 'null pointer must not be dereferenced');
  assert.equal(ref.text, undefined);
}

{
  const tagOnly = 0x0002000000000000n;
  const { reads, ref } = await resolve(tagOnly, null);
  assert.deepEqual(reads, [CELL_ADDR], 'non-canonicalizable high-bit pattern must fail closed (no address-0 dereference)');
  assert.equal(ref.text, undefined);
}

{
  const arm64e = 0xda7c0001_40001234n;
  const va = arm64e & 0x0000ffffffffffffn;
  assert.equal(va, 0x000140001234n);
  const { reads, ref } = await resolve(arm64e, { addr: va, text: 'arm64e sel' });
  assert.ok(reads.includes(va), `arm64e/tagged pointer must dereference ${va.toString(16)}`);
  assert.equal(ref.text, 'arm64e sel');
}

console.log('issue #4971 pointerAt 48-bit VA mask regressions: PASS');
