/** X-02 deterministic input construction ONLY. No production parsers/imported
 * metadata outputs are used here. These layouts are hand-layout, not compiler
 * products. Local layout authorities: native-apple-fixture.mjs, pac-site.test.mjs,
 * phase4/issue-3661-chained-symbols-format.test.mjs, objc metadata regressions.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { machoBytes } from '../../helpers/performance-worker.mjs';

export const REAL_MACHO_SHA256 = 'd4325809424c713392e932ca04a4f543ba420f40c61569500db6c767568f759d';
export const REAL_MACHO_PATH = 'tests/phase12/rebuild/fixtures/vertical-macho-x86_64.o';
export const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');
const text = new TextEncoder();

function writer(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    u16: (at, n) => v.setUint16(at, n, true),
    u32: (at, n) => v.setUint32(at, n, true),
    i32: (at, n) => v.setInt32(at, n, true),
    u64: (at, n) => v.setBigUint64(at, BigInt(n), true),
    str: (at, s) => bytes.set(text.encode(s + '\0'), at),
    rel: (at, target) => v.setInt32(at, target - at, true),
  };
}

/** Minimal hand-layout Mach-O container around independently specified payload bytes.
 * The payload VA and file offset differ deliberately; consumers must use the
 * loader mapping rather than treating a virtual address as a file offset.
 */
function wrapPayload(payload, sections, { platform = 1, buildTool = false, version = true, signed = false } = {}) {
  const bytes = new Uint8Array(0x1000 + payload.length), w = writer(bytes);
  const segmentBytes = 72 + sections.length * 80;
  const versionBytes = version ? (buildTool ? 32 : 24) : 0;
  const commandBytes = segmentBytes + versionBytes + (signed ? 32 : 0);
  if (32 + commandBytes > 0x1000) throw new RangeError('fixture command region overflow');
  w.u32(0, 0xfeedfacf); w.u32(4, 0x0100000c); w.u32(12, 2);
  w.u32(16, 1 + Number(version) + (signed ? 2 : 0)); w.u32(20, commandBytes);
  const seg = 32;
  w.u32(seg, 0x19); w.u32(seg + 4, segmentBytes); w.str(seg + 8, '__TEXT');
  w.u64(seg + 24, 0); w.u64(seg + 32, payload.length);
  w.u64(seg + 40, 0x1000); w.u64(seg + 48, payload.length);
  w.u32(seg + 56, 7); w.u32(seg + 60, 5); w.u32(seg + 64, sections.length);
  sections.forEach((s, i) => {
    const at = seg + 72 + 80 * i;
    w.str(at, s.name); w.str(at + 16, '__TEXT');
    w.u64(at + 32, s.address); w.u64(at + 40, s.size);
    w.u32(at + 48, 0x1000 + s.address); w.u32(at + 64, s.flags || 0);
  });
  let at = seg + segmentBytes;
  if (version) {
    w.u32(at, 0x32); w.u32(at + 4, versionBytes); w.u32(at + 8, platform);
    w.u32(at + 12, 0x000d0000); w.u32(at + 16, 0x000e0000);
    w.u32(at + 20, Number(buildTool));
    if (buildTool) { w.u32(at + 24, 1); w.u32(at + 28, 0x00120103); }
    at += versionBytes;
  }
  if (signed) {
    // The conservative rewrite adapter targets LC_VERSION_MIN_MACOSX.
    w.u32(at, 0x24); w.u32(at + 4, 16); w.u32(at + 8, 0x000d0000); at += 16;
    w.u32(at, 0x1d); w.u32(at + 4, 16); w.u32(at + 8, 0x1000 + 0xff00); w.u32(at + 12, 12);
    // A presence-only embedded-signature-shaped blob, NOT a valid signature.
    new DataView(payload.buffer, payload.byteOffset).setUint32(0xff00, 0xfade0cc0, false);
    new DataView(payload.buffer, payload.byteOffset).setUint32(0xff04, 12, false);
  }
  bytes.set(payload, 0x1000);
  return bytes;
}

export function appleMetadataBytes(options = {}) {
  const b = new Uint8Array(0x10000), w = writer(b);
  // Reuse the native-apple fixture's literal ABI layout, without its parser calls.
  w.rel(0x200, 0x1000); w.rel(0x204, 0x1200); w.rel(0x208, 0x1300);
  w.rel(0x210, 0x2000); w.rel(0x218, 0x3000);
  w.u32(0x1000, options.unknownKind ? 31 : options.unknownDescriptorVersion ? 0xff11 : 17);
  w.rel(0x1008, 0x5000); w.str(0x5000, 'Value');
  w.u32(0x1200, 0x80000010); w.rel(0x1208, 0x5020); w.str(0x5020, 'Owner');
  w.u32(0x1230, 1); w.u32(0x1234, 0x10); w.rel(0x1238, 0x6000);
  w.u32(0x1300, 0x91); w.rel(0x1308, 0x5040); w.str(0x5040, 'Box');
  w.u16(0x1324, 1); w.u16(0x1326, 1); w.u16(0x1328, 1); b[0x132c] = 0x80;
  w.u32(0x1330, 1); w.rel(0x1334, 0x5060); w.rel(0x1338, 0x5070);
  w.str(0x5060, 'x'); w.str(0x5070, 'Si');
  w.u32(0x2000, 3); w.rel(0x2008, 0x5080); w.str(0x5080, 'P');
  w.u32(0x2010, 1); w.u32(0x2018, 1);
  w.rel(0x3000, 0x2000); w.rel(0x3004, 0x1000); w.rel(0x3008, 0x4000);
  w.u64(0x4000, 0x3000); w.u64(0x4008, 0x6000);
  w.u32(0x5500, 1); w.u32(0x5504, 1); w.u32(0x5508, 1);
  w.rel(0x550c, 0x5070); w.rel(0x5510, 0x5060); w.rel(0x5514, 0x5090); w.str(0x5090, 'B0');
  w.u32(0x6000, 0xd65f03c0); w.u32(0x6004, 0xd65f03c0);
  // Concrete layout bytes for a class, category collision, and protocol requirement.
  w.u64(0x220, 0x8000); w.u64(0x8020, 0x8100); w.u32(0x8108, 32);
  w.u64(0x8118, 0x8300); w.str(0x8300, 'Widget');
  w.u64(0x8120, 0x8200); w.u32(0x8200, 24); w.u32(0x8204, 1);
  w.u64(0x8208, 0x8320); w.str(0x8320, 'save:');
  w.u64(0x8210, 0x8340); w.str(0x8340, 'v16@0:8'); w.u64(0x8218, 0x6000);
  w.u64(0x228, 0x8400); w.u64(0x8400, 0x8500); w.str(0x8500, 'Extra');
  w.u64(0x8408, 0x8000); w.u64(0x8410, 0x8600);
  w.u32(0x8600, 24); w.u32(0x8604, 1); w.u64(0x8608, 0x8320);
  w.u64(0x8610, 0x8340); w.u64(0x8618, 0x6004);
  w.u64(0x230, 0x8700); w.u64(0x8708, 0x8800); w.str(0x8800, 'Saveable');
  w.u32(0x8740, options.malformedProtocol ? 0 : 72);
  w.u64(0x8718, 0x8900); w.u32(0x8900, 24); w.u32(0x8904, 1);
  w.u64(0x8908, 0x8320); w.u64(0x8910, 0x8340);
  if (options.genericFlags) w.u16(0x132a, 1);
  if (options.genericKind) b[0x132c] = 0x81;
  if (options.genericBudget) w.u16(0x1324, 257);
  if (options.genericClass || options.resilient) {
    w.u32(0x1200, options.resilient ? 0xa0000090 : 0x80000090);
    b.fill(0, 0x122c, 0x1270); w.u16(0x1234, 1); w.u16(0x1238, 1); b[0x123c] = 0x80;
    w.u32(0x1244, 1); w.u32(0x1248, 0x10); w.rel(0x124c, 0x6000);
  }
  if (options.badClassName) b.set([0xe3, 0x81, 0], 0x8300);
  if (options.badImp) w.u64(0x8218, 0x10001);
  if (options.badCategory) w.u32(0x8600, 4); // entry size cannot contain three pointers
  const sections = [
    { name: '__swift5_types', address: 0x200, size: options.truncatedTypes ? 10 : 12 },
    { name: '__swift5_protos', address: 0x210, size: 4 },
    { name: '__swift5_proto', address: 0x218, size: 4 },
    { name: '__swift5_capture', address: 0x5500, size: options.truncatedCapture ? 20 : 24 },
    { name: '__objc_classlist', address: 0x220, size: 8 },
    { name: '__objc_catlist', address: 0x228, size: 8 },
    { name: '__objc_protolist', address: 0x230, size: 8 },
    { name: '__text', address: 0x6000, size: 8, flags: 0x80000400 },
  ].filter(s => !options.noClassList || s.name !== '__objc_classlist');
  return wrapPayload(b, sections, options);
}

export function chainedMachOBytes(options = {}) {
  const { format = 2, bind = true, key = 0, diversity = 0xa55a, addressDiversity = true,
    authenticated = true, importFormat = 1, importAddend = 0, pointerAddend = 0,
    ordinal = 0, symbolsFormat = 0, version = 0, base = '0x100000000', next = 0 } = options;
  const bytes = new Uint8Array(0x1000), w = writer(bytes), va = BigInt(base);
  w.u32(0, 0xfeedfacf); w.u32(4, 0x0100000c); w.u32(8, [1,7,9,10,12].includes(format) ? 2 : 0);
  w.u32(12, 2); w.u32(16, 3); w.u32(20, 168 + 40);
  const seg = 32; w.u32(seg, 0x19); w.u32(seg + 4, 152); w.str(seg + 8, '__TEXT');
  w.u64(seg + 24, va); w.u64(seg + 32, bytes.length); w.u64(seg + 48, bytes.length);
  w.u32(seg + 56, 7); w.u32(seg + 60, 5); w.u32(seg + 64, 1);
  const sec = seg + 72; w.str(sec, '__stubs'); w.str(sec + 16, '__TEXT');
  w.u64(sec + 32, va + 0x200n); w.u64(sec + 40, 12); w.u32(sec + 48, 0x200);
  w.u32(sec + 64, 0x80000408); w.u32(sec + 72, 12);
  const cmd = seg + 152; w.u32(cmd, 0x80000034); w.u32(cmd + 4, 16);
  w.u32(cmd + 8, 0x800); w.u32(cmd + 12, options.truncated ? 20 : 0x100);
  w.u32(cmd + 16, 0xc); w.u32(cmd + 20, 40); w.u32(cmd + 24, 24); w.str(cmd + 40, '/libX.dylib');
  w.u32(0x200, 0x90000010); w.u32(0x204, 0xf9418210); w.u32(0x208, 0xd61f0200);
  let raw;
  if ([1,7,9,10,12].includes(format)) {
    raw = (BigInt(authenticated) << 63n) | (BigInt(bind) << 62n) | (BigInt(next) << 51n);
    if (authenticated) raw |= BigInt(key) << 49n | BigInt(addressDiversity) << 48n | BigInt(diversity) << 32n;
    else if (bind) raw |= (BigInt(pointerAddend) & 0x7ffffn) << 32n;
    raw |= bind ? BigInt(ordinal) : authenticated || [7,9,12].includes(format) ? 0x200n : va + 0x200n;
  } else {
    raw = (BigInt(bind) << 63n) | (BigInt(next) << 51n);
    raw |= bind ? BigInt(ordinal) | (BigInt(pointerAddend) << 24n) : format === 6 ? 0x200n : va + 0x200n;
  }
  w.u64(0x300, raw);
  const f = 0x800;
  w.u32(f, version); w.u32(f + 4, 28); w.u32(f + 8, 64); w.u32(f + 12, 96);
  w.u32(f + 16, 1); w.u32(f + 20, importFormat); w.u32(f + 24, symbolsFormat);
  w.u32(f + 28, 1); w.u32(f + 32, 8); w.u32(f + 36, 24);
  w.u16(f + 40, 0x1000); w.u16(f + 42, format); w.u16(f + 56, 1);
  w.u16(f + 58, options.notMember ? 0xffff : 0x300);
  w.u32(f + 64, 1); // library ordinal 1; pointer ordinal indexes this import at 0
  if (importFormat === 2) w.i32(f + 68, importAddend);
  if (importFormat === 3) w.u64(f + 72, BigInt.asUintN(64, BigInt(importAddend)));
  w.str(f + 96, '_target');
  return bytes;
}

export function inputFor(row) {
  switch (row.fixture) {
    case 'real': {
      const b = new Uint8Array(readFileSync(new URL('../../phase12/rebuild/fixtures/vertical-macho-x86_64.o', import.meta.url)));
      if (hashBytes(b) !== REAL_MACHO_SHA256) throw new Error('X02 real fixture identity mismatch');
      return b;
    }
    case 'apple': return appleMetadataBytes(row.options);
    case 'chain': return chainedMachOBytes(row.options);
    case 'stripped': return machoBytes(new Uint8Array(16));
    case 'shared-cache': { const b = new Uint8Array(0x100); b.set(text.encode('dyld_v1  arm64e')); return b; }
    case 'unavailable': return null;
    default: throw new Error(`X02 unknown fixture ${row.fixture}`);
  }
}
