import assert from 'node:assert/strict';
import { parseJvm, probeJvm } from '../../../js/managed/jvm/parser.js';

function buildMinimalJvmClass(major = 61, minor = 0) {
  const bytes = new Uint8Array(31);
  const view = new DataView(bytes.buffer);
  bytes.set([0xca, 0xfe, 0xba, 0xbe], 0);
  view.setUint16(4, minor, false);
  view.setUint16(6, major, false);
  view.setUint16(8, 3, false);
  let p = 10;
  bytes[p++] = 1;
  view.setUint16(p, 1, false); p += 2;
  bytes[p++] = 0x54;
  bytes[p++] = 7;
  view.setUint16(p, 1, false); p += 2;
  view.setUint16(p, 0x0001, false); p += 2;
  view.setUint16(p, 2, false); p += 2;
  view.setUint16(p, 0, false); p += 2;
  view.setUint16(p, 0, false); p += 2;
  view.setUint16(p, 0, false); p += 2;
  view.setUint16(p, 0, false); p += 2;
  view.setUint16(p, 0, false); p += 2;
  assert.equal(p, bytes.length);
  return bytes;
}

const java17 = buildMinimalJvmClass(61, 0);
assert.deepEqual(probeJvm(java17), {
  supported: true,
  confidence: 1,
  formatVersion: 'class-61.0',
  vmSpecEdition: 'java-se-17',
});
assert.equal(parseJvm(java17).vmSpecEdition, 'java-se-17');

const java11 = buildMinimalJvmClass(55, 0);
assert.equal(probeJvm(java11).vmSpecEdition, 'java-se-11');
assert.equal(parseJvm(java11).formatVersion, 'class-55.0');

const legacy = buildMinimalJvmClass(45, 3);
assert.equal(probeJvm(legacy).vmSpecEdition, 'java-se-1');
assert.equal(parseJvm(legacy).formatVersion, 'class-45.3');

for (const [major, minor] of [
  [0xffff, 0xffff],
  [44, 0],
  [61, 1],
  [61, 0xffff],
  [45, 4],
  [62, 0],
]) {
  const bytes = buildMinimalJvmClass(major, minor);
  const probe = probeJvm(bytes);
  assert.equal(probe.supported, false, `expected ${major}.${minor} unsupported`);
  assert.equal(probe.reason, 'unsupported-version');
  assert.equal(probe.formatVersion, `class-${major}.${minor}`);
  assert.throws(() => parseJvm(bytes), /jvm-unsupported-version/);
}

console.log('ok jvm class version policy regression #3903');
