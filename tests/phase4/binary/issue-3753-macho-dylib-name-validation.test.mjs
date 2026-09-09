import assert from 'node:assert/strict';
import { parseMachO } from '../../../js/binary/macho.js';

const LC_ID_DYLIB = 0x0d;
const LC_LOAD_DYLIB = 0x0c;

function machoDylib({ cmd = LC_LOAD_DYLIB, cmdsize = 48, nameoff = 24, name = 'libExample.dylib', terminate = true } = {}) {
  const bytes = new Uint8Array(32 + cmdsize);
  const view = new DataView(bytes.buffer);
  bytes.set([0xcf, 0xfa, 0xed, 0xfe], 0);
  view.setInt32(4, 0x0100000c, true); // CPU_TYPE_ARM64
  view.setInt32(8, 0, true);
  view.setUint32(12, 2, true); // MH_EXECUTE
  view.setUint32(16, 1, true);
  view.setUint32(20, cmdsize, true);
  view.setUint32(24, 0, true);
  view.setUint32(28, 0, true);

  const p = 32;
  view.setUint32(p, cmd, true);
  view.setUint32(p + 4, cmdsize, true);
  view.setUint32(p + 8, nameoff, true);
  if (nameoff >= 24 && nameoff < cmdsize && name != null) {
    const encoded = new TextEncoder().encode(name);
    const available = Math.max(0, cmdsize - nameoff - (terminate ? 1 : 0));
    bytes.set(encoded.subarray(0, available), p + nameoff);
    if (terminate && nameoff + encoded.length < cmdsize) bytes[p + nameoff + encoded.length] = 0;
  }
  return bytes;
}

function reasons(image) {
  return image.metadata?.machoMetadata?.reasons || [];
}

function assertMalformed(config, warningFragment) {
  const image = parseMachO(machoDylib(config));
  assert.equal(image.metadata.machoMetadata.complete, false);
  assert.ok(reasons(image).includes('load-command-0xc-parse-error'), reasons(image).join('\n'));
  assert.ok(image.warnings.some((warning) => warning.includes(warningFragment)), image.warnings.join('\n'));
  assert.deepEqual(image.libraries, []);
}

{
  const image = parseMachO(machoDylib());
  assert.equal(image.metadata.machoMetadata.complete, true);
  assert.deepEqual(image.libraries, ['libExample.dylib']);
}

for (const nameoff of [0, 23, 48]) {
  assertMalformed({ nameoff }, `invalid dylib name offset ${nameoff}`);
}

assertMalformed({ cmdsize: 32, nameoff: 24, name: 'ABCDEFGH', terminate: false }, 'unterminated dylib name');

{
  const image = parseMachO(machoDylib({ cmd: LC_ID_DYLIB, name: 'libSelf.dylib' }));
  assert.equal(image.metadata.machoMetadata.complete, true);
  assert.equal(image.metadata.installName, 'libSelf.dylib');
  assert.deepEqual(image.libraries, []);
}

console.log('issue-3753 Mach-O dylib name validation: PASS');
