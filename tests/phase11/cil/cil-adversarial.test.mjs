import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCil, readCompressedInt } from '../../../js/managed/cil/parser.js';

console.log('[phase11] running cil adversarial tests...');

// 1. Truncated binary
assert.throws(() => {
  parseCil(new Uint8Array([0x4d, 0x5a]));
}, /cil-unsupported-binary/);

// 2. Corrupted compressed int
assert.throws(() => {
  readCompressedInt(new Uint8Array([0xff]), 0);
}, /cil-invalid-compressed-int/);

// 3. A genuine PE/CLI assembly is discovered through its MethodDef RVAs.
// Headers planted in metadata and resources must not be mistaken for methods.
const realCilPath = fileURLToPath(new URL('../../stage2/fixtures/managed-real/cil/ManagedFixture.dll', import.meta.url));
const realCil = new Uint8Array(fs.readFileSync(realCilPath));
const compiled = parseCil(realCil, { binaryId: 'real-cil-adversarial' });
assert.equal(compiled.methodBodies.length, 1);
assert.equal(compiled.methodBodies[0].headerOffset, 0x250);

const noCliDirectory = new Uint8Array(realCil);
noCliDirectory.fill(0, 0x168, 0x170);
assert.throws(() => parseCil(noCliDirectory), /cil-cli-directory-missing/);

const falseBody = new Uint8Array([0x12, 0x02, 0x03, 0x58, 0x2a]);
for (const [label, offset] of [['metadata', 0x3f0], ['resource', 0x820]]) {
  const poisoned = new Uint8Array(realCil);
  poisoned.set(falseBody, offset);
  const parsed = parseCil(poisoned, { binaryId: `false-${label}-header` });
  assert.equal(parsed.methodBodies.length, 1, `${label} bytes cannot add a method`);
  assert.equal(parsed.methodBodies[0].headerOffset, 0x250, `${label} false header is ignored`);
}

console.log('  ok cil adversarial tests passed');
