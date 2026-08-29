import assert from 'node:assert/strict';
import { VariableInstructionIndex } from '../../js/viewer/variable-instruction-index.js';

function oneByteDecoder() {
  return async (start, { length }) => ({
    supported: true,
    bytesRead: length,
    instructions: Array.from({ length }, (_, offset) => ({
      address: start + BigInt(offset),
      length: 1,
      rawBytes: Uint8Array.of(0x90),
      mnemonic: 'nop',
      opStr: '',
    })),
  });
}

{
  const index = new VariableInstructionIndex({
    disassembleAt: oneByteDecoder(),
    pageBytes: 32,
    overlapBytes: 0,
    maxPages: 2,
    maxInstructions: 64,
    maxPrefetchPages: 0,
  });
  index.configureRegion({ id: 'overlap', vmAddr: 0n, size: 128n });

  await index.ensurePage(0n, { protect: false });
  await index.ensurePage(16n, { protect: false });
  assert.ok(index.knownEntry(16n), 'overlapped address should be indexed');

  await index.ensurePage(48n, { protect: false });
  assert.ok(index.knownEntry(16n), 'evicting one owner must preserve an overlapping owner');
  assert.equal(index.knownEntry(0n), null, 'single-owner addresses from the victim must be removed');

  await index.ensurePage(80n, { protect: false });
  assert.equal(index.knownEntry(16n), null, 'last-owner eviction must remove the address');
  assert.equal(index.metrics().retainedInstructions, 64);
}

{
  const pageBytes = 2048;
  const maxPages = 8;
  const index = new VariableInstructionIndex({
    disassembleAt: oneByteDecoder(),
    pageBytes,
    overlapBytes: 0,
    maxPages,
    maxInstructions: maxPages * pageBytes,
    maxPrefetchPages: 0,
  });
  index.configureRegion({ id: 'benchmark', vmAddr: 0n, size: BigInt((maxPages + 1) * pageBytes) });

  for (let page = 0; page <= maxPages; page += 1) {
    await index.ensurePage(BigInt(page * pageBytes), { protect: false });
  }

  const metrics = index.metrics();
  assert.equal(metrics.evictions, 1);
  assert.equal(metrics.evictionInstructionCount, pageBytes,
    'one eviction must do bounded work proportional to victim entries only');
  assert.equal(metrics.retainedPages, maxPages);
  assert.equal(metrics.retainedInstructions, maxPages * pageBytes);
  assert.equal(index.knownEntry(0n), null);
  assert.ok(index.knownEntry(BigInt(pageBytes)));
}

console.log('issue 2604 variable index eviction: PASS');
