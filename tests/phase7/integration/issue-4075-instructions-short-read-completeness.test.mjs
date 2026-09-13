// Regression for #4075: AnalysisQuery instructions must not report `complete`
// when the producer shortened the requested read (region/file boundary).
// Contract: Backend.disassembleAt publishes requestedLength/readLength/
// readComplete for a `found:true` read, and app-adapter instructions()
// demotes a short read to `truncated` with an explicit reason instead of
// promoting it to `complete`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Backend } from '../../../js/backend.js';
import { createAppAnalysisQueryAdapter } from '../../../js/analysis/query/app-adapter.js';

const region = Object.freeze({ id: '__text', vmAddr: 0x1000n, size: 0x40n, exec: true });

function instructionAdapter(payload, capture) {
  return createAppAnalysisQueryAdapter({
    store: {
      get(key) {
        return ({ architecture: 'x86_64', regions: [region], currentRegion: region, sliceIndex: 0 })[key] ?? null;
      },
    },
    backend: {
      async disassembleAt(address, options) {
        capture?.push({ address, options });
        return payload;
      },
    },
  });
}

function decodedRange(start, length) {
  const instructions = [];
  for (let offset = 0n; offset + 4n <= BigInt(length); offset += 4n) {
    instructions.push({ address: start + offset, length: 4, mnemonic: 'add', opStr: 'x0, x1, #1' });
  }
  return { supported: true, architecture: 'x86_64', found: true, region: region.id, fileOffset: 0n, instructions };
}

test('#4075 full read of the requested range stays complete', async () => {
  const adapter = instructionAdapter({ ...decodedRange(0x1000n, 64), requestedLength: 64, readLength: 64, readComplete: true });
  const result = await adapter.instructions(null, { start: 0x1000n, length: 64 }, { offset: 0, limit: 200 }, {});
  assert.equal(result.status.completeness, 'complete');
  assert.equal(result.value.length, 16);
});

test('#4075 requested range ending exactly at the read end stays complete', async () => {
  const adapter = instructionAdapter({ ...decodedRange(0x1000n, 16), requestedLength: 16, readLength: 16, readComplete: true });
  const result = await adapter.instructions(null, { start: 0x1000n, length: 16 }, { offset: 0, limit: 200 }, {});
  assert.equal(result.status.completeness, 'complete');
});

test('#4075 region-end short read must not be promoted to complete', async () => {
  const adapter = instructionAdapter({ ...decodedRange(0x1000n, 16), requestedLength: 64, readLength: 16, readComplete: false });
  const result = await adapter.instructions(null, { start: 0x1000n, length: 64 }, { offset: 0, limit: 200 }, {});
  assert.notEqual(result.status.completeness, 'complete', 'a read shorter than the requested range is never complete');
  assert.equal(result.status.completeness, 'truncated');
  assert.equal(result.status.reason, 'instruction-read-short');
});

test('#4075 file-end short read must not be promoted to complete', async () => {
  const adapter = instructionAdapter({ ...decodedRange(0x1000n, 8), requestedLength: 64, readLength: 8, readComplete: false });
  const result = await adapter.instructions(null, { start: 0x1000n, length: 64 }, { offset: 0, limit: 200 }, {});
  assert.equal(result.status.completeness, 'truncated');
  assert.equal(result.status.reason, 'instruction-read-short');
});

test('#4075 1MiB input budget keeps the existing truncated reason', async () => {
  const capture = [];
  const adapter = instructionAdapter({ ...decodedRange(0x1000n, 16), readComplete: true, requestedLength: 1024 * 1024, readLength: 1024 * 1024 }, capture);
  const result = await adapter.instructions(null, { start: 0x1000n, length: 1024 * 1024 + 1 }, { offset: 0, limit: 200 }, {});
  assert.equal(result.status.completeness, 'truncated');
  assert.equal(result.status.reason, 'instruction-read-budget');
  assert.equal(capture[0].options.length, 1024 * 1024, 'the requested length stays clamped to the read budget');
});

test('#4075 producers without the short-read fields keep the prior contract', async () => {
  const adapter = instructionAdapter(decodedRange(0x1000n, 64));
  const result = await adapter.instructions(null, { start: 0x1000n, length: 64 }, { offset: 0, limit: 200 }, {});
  assert.equal(result.status.completeness, 'complete');
});

test('#4075 found:false keeps the existing unavailable contract', async () => {
  const adapter = instructionAdapter({ supported: true, architecture: 'x86_64', found: false, instructions: [] });
  const result = await adapter.instructions(null, { start: 0x1000n, length: 64 }, { offset: 0, limit: 200 }, {});
  assert.equal(result.status.completeness, 'unsupported');
  assert.equal(result.status.reason, 'instruction-producer-unavailable');
});

async function backendWithRead(bytesLength, found = true) {
  const backend = new Backend();
  backend.formatId = 'elf';
  backend.platformInfo = { capability: { architecture: 'x86_64' } };
  backend.probeArchitectures = async () => ({ support: { x86_64: true } });
  const readRequests = [];
  backend._callTo = (_domain, _op, params) => {
    readRequests.push(params);
    return Promise.resolve({
      found,
      region: '__text',
      fileOffset: 4096n,
      bytes: new Uint8Array(found ? bytesLength : 0),
    });
  };
  backend._disassembleBytes = async (bytes) => ({
    ok: true,
    instructions: Array.from({ length: bytes.length / 4 }, (_unused, i) => ({ address: 0x1000 + i * 4, length: 4, mnemonic: 'add', opStr: '' })),
  });
  return { backend, readRequests };
}

test('#4075 Backend.disassembleAt publishes the short read instead of hiding it', async () => {
  const { backend, readRequests } = await backendWithRead(16);
  const result = await backend.disassembleAt(0x1000n, { architecture: 'x86_64', length: 64 });
  assert.equal(result.found, true);
  assert.equal(readRequests[0].len, 64, 'the platform read still asks for the full requested length');
  assert.equal(result.requestedLength, 64);
  assert.equal(result.readLength, 16);
  assert.equal(result.readComplete, false);
});

test('#4075 Backend.disassembleAt marks a full read complete', async () => {
  const { backend } = await backendWithRead(64);
  const result = await backend.disassembleAt(0x1000n, { architecture: 'x86_64', length: 64 });
  assert.equal(result.found, true);
  assert.equal(result.requestedLength, 64);
  assert.equal(result.readLength, 64);
  assert.equal(result.readComplete, true);
});

test('#4075 Backend.disassembleAt found:false keeps its existing shape', async () => {
  const { backend } = await backendWithRead(0, false);
  const result = await backend.disassembleAt(0x1000n, { architecture: 'x86_64', length: 64 });
  assert.equal(result.supported, true);
  assert.equal(result.found, false);
  assert.deepEqual(result.instructions, []);
});
