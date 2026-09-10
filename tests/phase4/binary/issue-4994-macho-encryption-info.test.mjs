import assert from 'node:assert/strict';
import { parseMachO } from '../../../js/binary/macho.js';
import { describeBinaryImage } from '../../../js/platform/describe.js';

// Issue #4994: LC_ENCRYPTION_INFO / LC_ENCRYPTION_INFO_64 were skipped by the
// load-command dispatch and describeBinaryImage() hardcoded encrypted:false,
// so an App Store encrypted (FairPlay) image was always described as
// plaintext. The parser must retain cryptoff/cryptsize/cryptid and the
// descriptor must derive `encrypted` from that evidence.

function u32(b,o,v){new DataView(b.buffer).setUint32(o,v,true)}
function u64(b,o,v){new DataView(b.buffer).setBigUint64(o,BigInt(v),true)}
const enc = new TextEncoder();

function thin({ cmds, size }) {
  const b = new Uint8Array(size);
  u32(b,0,0xfeedfacf); u32(b,4,0x0100000c); u32(b,8,0); u32(b,12,2); u32(b,16,cmds.length); u32(b,20,cmds.reduce((t,c)=>t+c.bytes.length,0)); u32(b,24,0); u32(b,28,0);
  let p = 32;
  for (const c of cmds) { b.set(c.bytes, p); p += c.bytes.length; }
  return b;
}

function segmentCmd() {
  const b = new Uint8Array(72);
  u32(b,0,0x19); u32(b,4,72); b.set(enc.encode('__TEXT\0'), 8);
  u64(b,24,0x1000n); u64(b,32,0x1000n); u64(b,40,0n); u64(b,48,0n); u32(b,56,7); u32(b,60,5); u32(b,64,0); u32(b,68,0);
  return b;
}

// --- 64-bit image with LC_ENCRYPTION_INFO_64, cryptid != 0 ---
{
  const e = new Uint8Array(24);
  u32(e,0,0x2c); u32(e,4,24); u32(e,8,0x4000); u32(e,12,0x2000); u32(e,16,1); u32(e,20,0);
  const image = parseMachO(thin({ cmds:[{bytes:segmentCmd()},{bytes:e}], size:128 }));
  assert.deepEqual(image.metadata.encryption, { cryptoff: 0x4000, cryptsize: 0x2000, cryptid: 1 }, 'encryption evidence is retained');
  const info = describeBinaryImage(image).slices[0].info;
  assert.equal(info.encrypted, true, 'cryptid != 0 must describe the image as encrypted');
  assert.deepEqual(describeBinaryImage(image).productDescriptor.formatMetadata.encryption, { cryptoff: 0x4000, cryptsize: 0x2000, cryptid: 1 });
}

// --- cryptid == 0 is explicit plaintext evidence ---
{
  const e = new Uint8Array(24);
  u32(e,0,0x2c); u32(e,4,24); u32(e,8,0x4000); u32(e,12,0x2000); u32(e,16,0); u32(e,20,0);
  const image = parseMachO(thin({ cmds:[{bytes:segmentCmd()},{bytes:e}], size:128 }));
  assert.equal(describeBinaryImage(image).slices[0].info.encrypted, false, 'cryptid == 0 stays plaintext');
}

// --- 32-bit LC_ENCRYPTION_INFO (20-byte command) on a thin 32-bit image ---
{
  const b = new Uint8Array(28 + 56 + 20);
  u32(b,0,0xfeedface); u32(b,4,7); u32(b,8,0); u32(b,12,2); u32(b,16,2); u32(b,20,76); u32(b,24,0);
  const seg = new Uint8Array(56);
  u32(seg,0,0x19); u32(seg,4,56); seg.set(enc.encode('__TEXT\0'), 8);
  u32(seg,24,0x1000); u32(seg,28,0x1000); u32(seg,32,0); u32(seg,36,0); u32(seg,40,7); u32(seg,44,5); u32(seg,48,0); u32(seg,52,0);
  const e = new Uint8Array(20);
  u32(e,0,0x21); u32(e,4,20); u32(e,8,0x3000); u32(e,12,0x1000); u32(e,16,2);
  b.set(seg,28); b.set(e,84);
  const image = parseMachO(b);
  assert.deepEqual(image.metadata.encryption, { cryptoff: 0x3000, cryptsize: 0x1000, cryptid: 2 }, 'the 32-bit command variant parses');
  assert.equal(describeBinaryImage(image).slices[0].info.encrypted, true);
}

// --- no encryption command keeps the legacy plaintext default ---
{
  const image = parseMachO(thin({ cmds:[{bytes:segmentCmd()}], size:104 }));
  assert.equal(image.metadata.encryption, undefined);
  assert.equal(describeBinaryImage(image).slices[0].info.encrypted, false, 'legacy images stay encrypted:false');
}

// --- wrong command size fails closed (no encryption evidence minted) ---
{
  const e = new Uint8Array(16);
  u32(e,0,0x2c); u32(e,4,16); u32(e,8,0x4000); u32(e,12,0x2000);
  const image = parseMachO(thin({ cmds:[{bytes:segmentCmd()},{bytes:e}], size:120 }));
  assert.equal(image.metadata.encryption, undefined, 'an invalid command must not mint encryption metadata');
  assert.ok(image.warnings.some((w) => w.includes('LC_ENCRYPTION_INFO')), 'the size violation is diagnosed');
  assert.equal(describeBinaryImage(image).slices[0].info.encrypted, false);
}

console.log('issue-4994 LC_ENCRYPTION_INFO parsing + descriptor evidence: ok');
