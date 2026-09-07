import assert from 'node:assert/strict';
import { parseCil, probeCil } from '../../../js/managed/cil/parser.js';

console.log('[phase11] running cil parser tests...');

export function buildMinimalCil() {
  const buf = new Uint8Array(0x600);
  const view = new DataView(buf.buffer);

  // Minimal structurally valid PE/CLI fixture. The CLI directory resolves
  // through one .text section to a metadata root with one MethodDef row.
  buf[0] = 0x4d; buf[1] = 0x5a; // MZ
  view.setUint32(0x3c, 0x80, true); // e_lfanew
  buf.set([0x50, 0x45, 0, 0], 0x80); // PE\0\0
  view.setUint16(0x84, 0x014c, true); // Machine
  view.setUint16(0x86, 1, true); // NumberOfSections
  view.setUint16(0x94, 0x00e0, true); // SizeOfOptionalHeader
  view.setUint16(0x96, 0x210e, true); // Characteristics

  const optional = 0x98;
  view.setUint16(optional, 0x010b, true); // PE32
  view.setUint32(optional + 92, 16, true); // NumberOfRvaAndSizes
  const cliDirectory = optional + 96 + 14 * 8;
  view.setUint32(cliDirectory, 0x2000, true); // CLI header RVA
  view.setUint32(cliDirectory + 4, 72, true); // CLI header size

  const section = optional + 0xe0;
  buf.set(new TextEncoder().encode('.text'), section);
  view.setUint32(section + 8, 0x400, true); // VirtualSize
  view.setUint32(section + 12, 0x2000, true); // VirtualAddress
  view.setUint32(section + 16, 0x400, true); // SizeOfRawData
  view.setUint32(section + 20, 0x200, true); // PointerToRawData

  const cli = 0x200;
  view.setUint32(cli, 72, true); // cb
  view.setUint16(cli + 4, 2, true); // MajorRuntimeVersion
  view.setUint16(cli + 6, 5, true); // MinorRuntimeVersion
  view.setUint32(cli + 8, 0x2080, true); // Metadata RVA
  view.setUint32(cli + 12, 0x80, true); // Metadata size
  view.setUint32(cli + 16, 1, true); // COMIMAGE_FLAGS_ILONLY

  const metadata = 0x280;
  view.setUint32(metadata, 0x424a5342, true); // BSJB
  view.setUint16(metadata + 4, 1, true); // MajorVersion
  view.setUint16(metadata + 6, 1, true); // MinorVersion
  view.setUint32(metadata + 12, 12, true); // Version length
  buf.set(new TextEncoder().encode('v4.0.30319\0\0'), metadata + 16);

  const flags = metadata + 0x1c;
  view.setUint16(flags, 0, true);
  view.setUint16(flags + 2, 1, true); // one stream
  view.setUint32(flags + 4, 0x40, true); // #~ relative offset
  view.setUint32(flags + 8, 0x40, true); // #~ size
  buf.set([0x23, 0x7e, 0], flags + 12); // "#~\0"

  const tables = metadata + 0x40;
  buf[tables + 4] = 2; // tables major version
  buf[tables + 7] = 1; // reserved
  view.setUint32(tables + 8, 1 << 6, true); // MethodDef valid bit
  view.setUint32(tables + 24, 1, true); // one MethodDef row
  view.setUint32(tables + 28, 0x2200, true); // MethodDef RVA -> file 0x400

  // Tiny method body: ldc.i4.5, stloc.0, ldloc.0, ret, nop.
  const method = 0x400;
  buf[method] = (5 << 2) | 0x02;
  buf.set([0x1b, 0x0a, 0x06, 0x2a, 0x00], method + 1);

  return buf;
}

const cilBytes = buildMinimalCil();
const probe = probeCil(cilBytes);
assert.equal(probe.supported, true);
assert.equal(probe.formatVersion, 'pe-cli');

const parsed = parseCil(cilBytes);
assert.equal(parsed.formatVersion, 'cli-ecma-335');
assert.equal(parsed.vmSpecEdition, 'v4.0.30319');
assert.equal(parsed.methodBodies.length, 1);
assert.equal(parsed.methodBodies[0].isTiny, true);
assert.equal(parsed.methodBodies[0].codeSize, 5);

console.log('  ok cil parser tests passed');
