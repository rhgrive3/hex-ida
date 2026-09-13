// Regression for #4973: resolveModelTexts()/pointerAt() decoded every pointer
// cell as a fixed 8-byte little-endian value, so an arm64_32 (AArch64 ILP32)
// 4-byte pointer absorbed the following 4 bytes as its high half. The indirect
// text target therefore depended on whatever sat after the pointer cell.
import assert from 'node:assert/strict';
import { resolveModelTexts } from '../js/analyze.js';

function le(value, len) {
  const b = new Uint8Array(len);
  let v = BigInt(value);
  for (let i = 0; i < len; i++) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
}

function cellBytes(width, ptr, adjacency) {
  const b = new Uint8Array(12);
  const head = le(ptr, width);
  for (let i = 0; i < width; i++) b[i] = head[i];
  const tail = le(adjacency, 4);
  for (let i = 0; i < 4; i++) b[width + i] = tail[i];
  return b;
}

function makeBackend(store) {
  const reads = [];
  return {
    reads,
    async readAt(addr) {
      const a = BigInt(addr);
      reads.push(a);
      const hit = store.get(a);
      if (!hit) return null;
      return { found: true, bytes: hit.bytes, text: hit.text || '', terminated: !!hit.terminated };
    },
  };
}

function modelFor(cellAddr) {
  return {
    addressRefs: [{ addr: cellAddr }],
    semantic: [],
    facts: { stringRefs: [{ addr: cellAddr }], strings: [] },
    calls: [],
  };
}

function resolvedText(model) {
  return model.facts.strings[0] || null;
}

const CELL = 0x8000n;

// 1 + 2 + 3: arm64_32 decodes exactly the first 4 bytes; the trailing 4 bytes
// (adjacency) must never change the pointer.
{
  const store = new Map([
    [CELL, { bytes: cellBytes(4, 0x12345678n, 0x10002004n) }],
    [0x12345678n, { bytes: new Uint8Array(0), text: 'main', terminated: true }],
    [0x99999999n, { bytes: new Uint8Array(0), text: 'neighbor', terminated: true }],
  ]);
  const backend = makeBackend(store);
  const model = modelFor(CELL);
  await resolveModelTexts(backend, model, 96, { architecture: 'arm64_32' });
  assert.ok(backend.reads.includes(0x12345678n), 'arm64_32 must deref the 32-bit pointer 0x12345678');
  assert.ok(!backend.reads.includes(0x412345678n), 'arm64_32 must not read a byte[4..7]-derived 8-byte address');
  assert.equal(resolvedText(model), 'main');
}

{
  const store = new Map([
    [CELL, { bytes: cellBytes(4, 0x12345678n, 0xffffffffn) }],
    [0x12345678n, { bytes: new Uint8Array(0), text: 'main', terminated: true }],
  ]);
  const backend = makeBackend(store);
  const model = modelFor(CELL);
  await resolveModelTexts(backend, model, 96, { architecture: 'arm64_32' });
  assert.equal(resolvedText(model), 'main', 'changing byte[4..7] must not change the arm64_32 pointer');
  assert.ok(backend.reads.includes(0x12345678n));
}

// adjacent pointer-table entry must not be absorbed
{
  const store = new Map([
    [CELL, { bytes: cellBytes(4, 0x12345678n, 0x99999999n) }],
    [0x12345678n, { bytes: new Uint8Array(0), text: 'main', terminated: true }],
    [0x99999999n, { bytes: new Uint8Array(0), text: 'neighbor', terminated: true }],
  ]);
  const backend = makeBackend(store);
  const model = modelFor(CELL);
  await resolveModelTexts(backend, model, 96, { architecture: 'arm64_32' });
  assert.equal(resolvedText(model), 'main', 'arm64_32 must not follow the neighbouring table entry');
  assert.ok(!backend.reads.includes(0x99999999n));
}

// 4: arm64 / arm64e keep the 8-byte decode (incl. high-bit canonicalization).
for (const arch of ['arm64', 'arm64e']) {
  const store = new Map([
    [CELL, { bytes: cellBytes(8, 0x1000200412345678n, 0n) }],
    [0x412345678n, { bytes: new Uint8Array(0), text: 'canon', terminated: true }],
  ]);
  const backend = makeBackend(store);
  const model = modelFor(CELL);
  await resolveModelTexts(backend, model, 96, { architecture: arch });
  assert.equal(resolvedText(model), 'canon', `${arch} 64-bit decode must stay intact`);
  assert.ok(backend.reads.includes(0x412345678n), `${arch} must read the canonicalized 64-bit target`);
}

{
  const store = new Map([
    [CELL, { bytes: cellBytes(8, 0x100001234n, 0n) }],
    [0x100001234n, { bytes: new Uint8Array(0), text: 'plain', terminated: true }],
  ]);
  const backend = makeBackend(store);
  const model = modelFor(CELL);
  await resolveModelTexts(backend, model, 96, { architecture: 'arm64' });
  assert.equal(resolvedText(model), 'plain', 'arm64 sub-48-bit pointer must deref unchanged');
}

// 5: a null 32-bit pointer must not be dereferenced.
{
  const store = new Map([
    [CELL, { bytes: cellBytes(4, 0n, 0x12345678n) }],
    [0x800000000n, { bytes: new Uint8Array(0), text: 'phantom', terminated: true }],
  ]);
  const backend = makeBackend(store);
  const model = modelFor(CELL);
  await resolveModelTexts(backend, model, 96, { architecture: 'arm64_32' });
  assert.equal(backend.reads.length, 1, 'null arm64_32 pointer must not trigger any deref read');
  assert.equal(resolvedText(model), null, 'null arm64_32 pointer must attach no text');
}

// 6: unknown target pointer width fails closed (no exact address fabricated).
{
  const store = new Map([
    [CELL, { bytes: cellBytes(8, 0x12345678n, 0n) }],
    [0x12345678n, { bytes: new Uint8Array(0), text: 'oops', terminated: true }],
  ]);
  const backend = makeBackend(store);
  const model = modelFor(CELL);
  await resolveModelTexts(backend, model, 96, { architecture: 'mips' });
  assert.equal(backend.reads.length, 1, 'unknown pointer width must fail closed (no deref)');
  assert.equal(resolvedText(model), null);
}

console.log('issue #4973 arm64_32 pointer width regressions: PASS');
