import assert from 'node:assert/strict';
import { buildObjcModel } from '../js/objc-legacy.js';
import { parseObjcExtendedMetadata } from '../js/apple/objc-metadata.js';

function legacyFixture() {
  const mem = new Uint8Array(0x4000);
  const dv = new DataView(mem.buffer);
  const p64 = (at, v) => dv.setBigUint64(at, BigInt(v), true);
  const p32 = (at, v) => dv.setUint32(at, Number(v) >>> 0, true);
  const str = (at, s) => { for (let i = 0; i < s.length; i++) mem[at + i] = s.charCodeAt(i); mem[at + s.length] = 0; };
  const classAddr = 0x1000, metaAddr = 0x1100, classRo = 0x1200, metaRo = 0x1300, listAddr = 0x1400, classNameAddr = 0x1800;
  p64(0x200, classAddr);
  p64(classAddr + 0, metaAddr);
  p64(classAddr + 32, classRo);
  p64(metaAddr + 0, 0);
  p64(metaAddr + 32, metaRo);
  p64(classRo + 24, classNameAddr);
  p64(classRo + 32, listAddr);
  p64(metaRo + 24, classNameAddr);
  str(classNameAddr, 'Victim');
  p32(listAddr, 24); p32(listAddr + 4, 5);
  for (let i = 0; i < 5; i++) {
    const entry = listAddr + 8 + i * 24;
    const selAddr = 0x1900 + i * 0x20, typeAddr = 0x1a00 + i * 0x20, imp = 0x2100 + i * 0x10;
    str(selAddr, `m${i}:`);
    str(typeAddr, 'v16@0:8');
    p64(entry + 0, selAddr);
    p64(entry + 8, typeAddr);
    p64(entry + 16, imp);
  }
  const baseRead = async (addr, len) => {
    const at = Number(addr);
    if (!Number.isSafeInteger(at) || at < 0 || at >= mem.length) return null;
    return mem.subarray(at, Math.min(mem.length, at + len));
  };
  return { baseRead, classList: { vmAddr: 0x200n, size: 8n } };
}

{
  const { baseRead, classList } = legacyFixture();
  const full = await buildObjcModel(baseRead, classList, null, 0n);
  assert.equal(full.names.length, 5);
}

{
  const { baseRead, classList } = legacyFixture();
  let reads = 0;
  let firstPage = true;
  const controller = new AbortController();
  const read = async (addr, len) => {
    reads++;
    const result = await baseRead(addr, len);
    if (firstPage) { firstPage = false; controller.abort(); }
    return result;
  };
  const model = await buildObjcModel(read, classList, null, 0n, null, { signal: controller.signal });
  assert.ok(model.names.length < 5, `abort during method list must truncate legacy parse, got ${model.names.length}`);
  assert.equal(reads, 1);
}

function extendedFixture() {
  const mem = new Uint8Array(0x5000);
  const dv = new DataView(mem.buffer);
  const p64 = (at, v) => dv.setBigUint64(at, BigInt(v), true);
  const p32 = (at, v) => dv.setUint32(at, Number(v) >>> 0, true);
  const str = (at, s) => { for (let i = 0; i < s.length; i++) mem[at + i] = s.charCodeAt(i); mem[at + s.length] = 0; };
  p64(0x100, 0x1000);
  p64(0x1000 + 8, 0x1800); str(0x1800, 'P');
  p64(0x1000 + 24, 0x1100);
  p32(0x1100, 24); p32(0x1104, 5);
  for (let i = 0; i < 5; i++) {
    const entry = 0x1108 + i * 24;
    const sel = 0x1900 + i * 0x30, typ = 0x1a00 + i * 0x30;
    str(sel, `m${i}:`); str(typ, 'v16@0:8');
    p64(entry, sel); p64(entry + 8, typ); p64(entry + 16, 0);
  }
  const baseRead = async (addr, len) => {
    const at = Number(addr);
    if (at < 0 || at >= mem.length) return null;
    return mem.subarray(at, Math.min(mem.length, at + len));
  };
  return { baseRead };
}

{
  const { baseRead } = extendedFixture();
  const sections = { protocolList: { vmAddr: 0x100n, size: 8n }, categoryList: null };
  const full = await parseObjcExtendedMetadata(baseRead, sections, { pageBytes: 32 });
  assert.equal(full.protocols[0].methods.length, 5);
}

{
  const { baseRead } = extendedFixture();
  const sections = { protocolList: { vmAddr: 0x100n, size: 8n }, categoryList: null };
  let reads = 0, postAbort = 0;
  const controller = new AbortController();
  let doAbort = true;
  const read = async (addr, len) => {
    reads++;
    if (controller.signal.aborted) postAbort++;
    const result = await baseRead(addr, len);
    if (doAbort && reads === 2) { doAbort = false; controller.abort(); }
    return result;
  };
  await parseObjcExtendedMetadata(read, sections, { pageBytes: 32, signal: controller.signal });
  assert.equal(postAbort, 0, `no new reads after abort, got ${postAbort} post-abort reads of ${reads}`);
  assert.ok(reads < 10, `nested scan must stop early, got ${reads} reads`);
}

console.log('issue-6192: PASS');
