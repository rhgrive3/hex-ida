import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEPLOYED_CAPSTONE_SUPPORT } from '../js/platform/capstone-capability.js';
import { describeBinaryImage } from '../js/platform/describe.js';

// 1. DEPLOYED_CAPSTONE_SUPPORT contains riscv64: true
assert.equal(DEPLOYED_CAPSTONE_SUPPORT.riscv64, true, 'riscv64 must be present and true in DEPLOYED_CAPSTONE_SUPPORT');
assert.equal(DEPLOYED_CAPSTONE_SUPPORT.arm64, true);
assert.equal(DEPLOYED_CAPSTONE_SUPPORT.x86_64, true);

// 2. capstone-probe-worker.js architecture keys must match DEPLOYED_CAPSTONE_SUPPORT keys
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const probeWorkerSrc = fs.readFileSync(path.join(root, 'js/platform/capstone-probe-worker.js'), 'utf8');
for (const arch of Object.keys(DEPLOYED_CAPSTONE_SUPPORT)) {
  assert.ok(probeWorkerSrc.includes(`${arch}: probe(`), `probe worker must probe ${arch}`);
}

// 3. describeBinaryImage with default engine options recognizes riscv64 as disassemblable
const descriptor = describeBinaryImage({
  format: 'elf',
  arch: 'riscv64',
  bits: 64,
  endian: 'little',
  sections: [],
  segments: [],
  imageBase: 0n,
  fileOffset: 0n,
  fileSize: 0n,
  warnings: [],
  metadata: {},
  summary: () => ({ format: 'elf', arch: 'riscv64', bits: 64 }),
});

assert.equal(descriptor.capability.canDisassemble, true, 'riscv64 must be disassemblable by default without explicit probe engine');
assert.equal(descriptor.capability.architecture, 'riscv64');

console.log('issue #6235 capstone-capability riscv64 regressions PASS');
