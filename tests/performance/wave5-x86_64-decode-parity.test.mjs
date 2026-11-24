import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { wasmDecodeX86_64Batch } from '../../js/core/hex-engine-bridge.js';
import {
  getWasmCallCount,
  resetAllTelemetry,
} from '../../js/core/wasm-telemetry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GOLDEN_PATH = path.join(ROOT, 'fixtures/golden/x86_64-decode-outputs.json');

const HEX_X86_CAP_FALLBACK = 0;

function loadGoldenGroups() {
  const entries = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
  assert.ok(Array.isArray(entries), 'x86_64-decode-outputs.json must be an array');
  assert.equal(entries.length, 76, 'x86_64-decode-outputs.json must contain 76 instructions');

  const groups = new Map();
  for (const item of entries) {
    if (!groups.has(item.binary)) groups.set(item.binary, []);
    groups.get(item.binary).push(item);
  }
  return groups;
}

test('Wave 5 x86_64 decode parity: all 76 golden instructions match wasmDecodeX86_64Batch 100%', () => {
  const groups = loadGoldenGroups();
  resetAllTelemetry();

  let verified = 0;
  for (const [binId, expectedList] of groups.entries()) {
    const totalLen = expectedList.reduce((acc, ins) => acc + ins.bytes.length, 0);
    const code = new Uint8Array(totalLen);
    let off = 0;
    for (const ins of expectedList) {
      code.set(ins.bytes, off);
      off += ins.bytes.length;
    }

    const baseAddr = BigInt(`0x${expectedList[0].addr}`);
    const decoded = wasmDecodeX86_64Batch(code, baseAddr);
    assert.ok(Array.isArray(decoded), `${binId}: wasmDecodeX86_64Batch must return an array`);
    assert.equal(
      decoded.length,
      expectedList.length,
      `${binId}: decoded count mismatch (${decoded.length} vs ${expectedList.length})`,
    );

    for (let i = 0; i < expectedList.length; i += 1) {
      const exp = expectedList[i];
      const got = decoded[i];
      const gotPc = BigInt(got.pc ?? got.address ?? 0n);
      const gotLen = Number(got.length ?? got.size ?? 0);
      const gotMn = String(got.mnemonic ?? got.mn ?? '').toLowerCase();

      assert.equal(gotPc, BigInt(`0x${exp.addr}`), `${binId}[${i}] PC mismatch`);
      assert.equal(gotLen, exp.size, `${binId}[${i}] size mismatch`);
      assert.equal(gotMn, exp.mnemonic.toLowerCase(), `${binId}[${i}] mnemonic mismatch`);
      verified += 1;
    }
  }

  assert.equal(verified, 76, 'must verify all 76 golden x86_64 instructions');
  assert.ok(
    getWasmCallCount('x86_64_decode') >= 1,
    'expected x86_64_decode telemetry >= 1',
  );
});

test('Wave 5 x86_64 decode fail-closed: truncated CALL rel32 (e8 01 00) returns length 0 (HEX_X86_CAP_FALLBACK)', () => {
  const truncatedCall = new Uint8Array([0xe8, 0x01, 0x00]);
  const decoded = wasmDecodeX86_64Batch(truncatedCall, 0x1000n);
  assert.ok(Array.isArray(decoded) && decoded.length >= 1, 'must return fail-closed record');

  const first = decoded[0];
  const gotLen = Number(first.length ?? first.size ?? -1);
  const gotCap = Number(first.cap ?? HEX_X86_CAP_FALLBACK);
  assert.equal(gotLen, 0, 'truncated CALL rel32 must report length 0');
  assert.equal(gotCap, HEX_X86_CAP_FALLBACK, 'truncated CALL rel32 must report HEX_X86_CAP_FALLBACK');
});
