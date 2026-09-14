import assert from 'node:assert/strict';
import { createSymmetricCodeFunctionSet } from '../js/diff/symmetric-function-set.js';
import { fingerprintFunction } from '../js/fingerprint/index.js';

function deterministicBytes(start, length) {
  const bytes = new Uint8Array(length);
  const base = Number(start);
  for (let i = 0; i < length; i++) bytes[i] = (base + i) & 0xff;
  return bytes;
}

function recordingBackend(regions, reads) {
  const ownerFor = (address) => regions.find((region) => {
    const start = BigInt(region.vmAddr), end = start + BigInt(region.size);
    return address >= start && address < end;
  });
  return {
    async readAt(address, length) {
      assert.equal(typeof length, 'number');
      assert.ok(Number.isSafeInteger(length) && length > 0, 'read length must be a positive safe integer');
      const region = ownerFor(BigInt(address));
      assert.ok(region, `read address ${address} must stay inside an executable region`);
      reads.push({ address:BigInt(address), length, region:region.id });
      const end = BigInt(region.vmAddr) + BigInt(region.size);
      const observed = BigInt(address) + BigInt(length) <= end ? length : Number(end - BigInt(address));
      return { found:true, bytes:deterministicBytes(address, observed) };
    },
  };
}

function symbolsOf(funcs) {
  return { funcs:funcs.map(BigInt), functionStartsComplete:true, nameAt() { return null; } };
}

function totalBytes(reads) {
  return reads.reduce((sum, read) => sum + read.length, 0);
}

// 1. First target function at the region start keeps the existing read range.
{
  const regions = [{ id:'text', exec:true, vmAddr:0x1000n, size:0x100n }];
  const reads = [];
  const set = await createSymmetricCodeFunctionSet({
    backend:recordingBackend(regions, reads), symbols:symbolsOf([0x1000]), regions, architecture:'arm64',
  });
  assert.equal(reads[0].address, 0x1000n, 'region-start function keeps region-start cursor');
  assert.equal(totalBytes(reads), 0x100, 'read range stays [region start, last function end)');
  assert.equal(set.complete, true);
}

// 2+3. First target function late in the region: reads must start at that function and
// never touch the leading gap bytes before it.
{
  const regions = [{ id:'text', exec:true, vmAddr:0n, size:0x100000n }];
  const reads = [];
  const set = await createSymmetricCodeFunctionSet({
    backend:recordingBackend(regions, reads), symbols:symbolsOf([0xF0000]), regions, architecture:'arm64',
  });
  assert.ok(reads.length > 0, 'target function bytes must still be read');
  for (const read of reads) {
    assert.ok(read.address >= 0xF0000n, `read at ${read.address} must not precede the first target function`);
  }
  assert.equal(reads[0].address, 0xF0000n, 'first read begins exactly at the first target function');
  assert.equal(totalBytes(reads), 0x10000, 'only the 64 KiB target range is read, not the whole 1 MiB region');
  assert.equal(set[0].size, 0x10000);
  assert.equal(set[0].evidenceCompleteness, 'complete');
}

// 4. Fingerprint content and set-level flags are unchanged by the tighter read scope.
{
  const regions = [{ id:'text', exec:true, vmAddr:0n, size:0x100000n }];
  const reads = [];
  const set = await createSymmetricCodeFunctionSet({
    backend:recordingBackend(regions, reads), symbols:symbolsOf([0xF0000]), regions, architecture:'arm64',
  });
  const expected = fingerprintFunction({
    address:0xF0000n, name:null, size:0x10000, architecture:'arm64',
    bytes:deterministicBytes(0xF0000, 0x10000),
  });
  assert.equal(set[0].exactBytesHash, expected.exactBytesHash, 'fingerprint must match the target bytes only');
  assert.equal(set[0].normalizedBytesHash, expected.normalizedBytesHash);
  assert.deepEqual(set[0].byteSample, expected.byteSample);
  assert.equal(set.complete, true);
  assert.equal(set.missingEvidence, 0);
  assert.equal(set.truncationReason, null);
  assert.equal(set.total, 1);
  assert.equal(set.scanned, 1);
}

// 5. Multiple functions across multiple sparse regions finalize every descriptor.
{
  const regions = [
    { id:'alpha', exec:true, vmAddr:0x1000n, size:0x1000n },
    { id:'beta', exec:true, vmAddr:0x8000n, size:0x400n },
  ];
  const reads = [];
  const set = await createSymmetricCodeFunctionSet({
    backend:recordingBackend(regions, reads), symbols:symbolsOf([0x1800, 0x1C00, 0x8100]), regions, architecture:'arm64',
  });
  assert.equal(set.length, 3);
  for (const entry of set) assert.ok(entry && entry.exactBytesHash, 'every descriptor is finalized with bytes');
  assert.equal(set.filter(Boolean).length, 3);
  const alpha = reads.filter((read) => read.region === 'alpha');
  const beta = reads.filter((read) => read.region === 'beta');
  for (const read of alpha) assert.ok(read.address >= 0x1800n, `alpha read ${read.address} must skip the leading gap`);
  for (const read of beta) assert.ok(read.address >= 0x8100n, `beta read ${read.address} must skip the leading gap`);
  assert.equal(totalBytes(alpha), 0x400 + 0x400, 'alpha reads cover only [first alpha function, region end)');
  assert.equal(totalBytes(beta), 0x300, 'beta reads cover only [first beta function, region end)');
  assert.equal(set.complete, true);
  assert.equal(set.missingEvidence, 0);
  assert.equal(set.truncationReason, null);
}

// 6a. Chunking across the tighter scope still accumulates exact bytes.
{
  const regions = [{ id:'text', exec:true, vmAddr:0n, size:0x40000n }];
  const reads = [];
  const set = await createSymmetricCodeFunctionSet({
    backend:recordingBackend(regions, reads), symbols:symbolsOf([0x10000]), regions,
    architecture:'arm64', chunkBytes:65536,
  });
  assert.equal(reads[0].address, 0x10000n, 'chunked scan starts at the first target function');
  assert.equal(reads.length, 3, '192 KiB target range splits into three 64 KiB chunks');
  assert.equal(totalBytes(reads), 0x30000);
  assert.equal(set[0].evidenceCompleteness, 'complete', 'multi-chunk accumulation stays exact');
  assert.equal(set[0].size, 0x30000);
  const expected = fingerprintFunction({
    address:0x10000n, name:null, size:0x30000, architecture:'arm64',
    bytes:deterministicBytes(0x10000, 0x30000),
  });
  assert.equal(set[0].exactBytesHash, expected.exactBytesHash);
}

// 6b. Cancellation behaviour is preserved.
{
  const regions = [{ id:'text', exec:true, vmAddr:0n, size:0x100000n }];
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => createSymmetricCodeFunctionSet({
      backend:recordingBackend(regions, []), symbols:symbolsOf([0xF0000]), regions,
      architecture:'arm64', signal:controller.signal,
    }),
    (error) => error.name === 'AbortError',
    'pre-aborted signal aborts before any read',
  );

  const midFlight = new AbortController();
  const reads = [];
  const backend = {
    async readAt(address, length) {
      reads.push({ address:BigInt(address), length });
      midFlight.abort();
      return { found:true, bytes:deterministicBytes(address, length) };
    },
  };
  await assert.rejects(
    () => createSymmetricCodeFunctionSet({
      backend, symbols:symbolsOf([0x10000]), regions, architecture:'arm64',
      chunkBytes:65536, signal:midFlight.signal,
    }),
    (error) => error.name === 'AbortError',
    'abort during chunking stops the scan',
  );
  assert.equal(reads.length, 1, 'no further chunk is requested after abort');
}

console.log('issue-4779 symmetric region scan starts at first target function: PASS');
