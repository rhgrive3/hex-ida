import assert from 'node:assert/strict';
import {
  GoMetadataProvider,
  parsePclntabHeader,
  parseGoFunctions,
  parseGoTypeDescriptor,
  findGoBuildVersion,
  GO_PCLNTAB_MAGICS,
} from '../js/metadata/go.js';

console.log('Testing Go Metadata Provider...');

const MODERN_MAGICS = Object.freeze({
  '1.16': 0xfffffffa,
  '1.18': 0xfffffff0,
  '1.20+': 0xfffffff1,
});

function writeCString(buf, off, value) {
  for (let i = 0; i < value.length; i++) buf[off + i] = value.charCodeAt(i);
  buf[off + value.length] = 0;
}

function createModernPclntab({ version = '1.20+', nfunc = 2, textStart = 0x400000n, functions = [] } = {}) {
  const magic = MODERN_MAGICS[version];
  if (!magic) throw new Error(`unsupported test pclntab version: ${version}`);

  const buf = new Uint8Array(2048);
  const dv = new DataView(buf.buffer);
  const ptrSize = 8;
  const nameTabStart = 160;
  const cutabStart = 240;
  const filetabStart = 280;
  const pctabStart = 320;
  const pclnStart = 512;
  const funcDataRelativeStart = 128;
  const effectiveFunctions = Array.from({ length: nfunc }, (_, i) => functions[i] || {
    entryOff: i * 0x100,
    name: `func_${i}`,
  });

  dv.setUint32(0, magic, true);
  buf[4] = 0; buf[5] = 0; buf[6] = 1; buf[7] = ptrSize;
  dv.setBigUint64(8, BigInt(nfunc), true);
  dv.setBigUint64(16, 0n, true);

  if (version === '1.16') {
    dv.setBigUint64(24, BigInt(nameTabStart), true);
    dv.setBigUint64(32, BigInt(cutabStart), true);
    dv.setBigUint64(40, BigInt(filetabStart), true);
    dv.setBigUint64(48, BigInt(pctabStart), true);
    dv.setBigUint64(56, BigInt(pclnStart), true);
  } else {
    dv.setBigUint64(24, textStart, true);
    dv.setBigUint64(32, BigInt(nameTabStart), true);
    dv.setBigUint64(40, BigInt(cutabStart), true);
    dv.setBigUint64(48, BigInt(filetabStart), true);
    dv.setBigUint64(56, BigInt(pctabStart), true);
    dv.setBigUint64(64, BigInt(pclnStart), true);
  }

  let nameCursor = nameTabStart;
  const nameOffsets = [];
  for (const fn of effectiveFunctions) {
    nameOffsets.push(nameCursor - nameTabStart);
    writeCString(buf, nameCursor, fn.name || 'pkg.Func');
    nameCursor += (fn.name || 'pkg.Func').length + 1;
  }

  for (let i = 0; i < nfunc; i++) {
    const fn = effectiveFunctions[i];
    const funcOff = funcDataRelativeStart + i * 32;
    const funcPos = pclnStart + funcOff;

    if (version === '1.16') {
      const entryPC = fn.entryPC ?? (textStart + BigInt(fn.entryOff ?? i * 0x100));
      const slot = pclnStart + i * 16;
      dv.setBigUint64(slot, entryPC, true);
      dv.setBigUint64(slot + 8, BigInt(funcOff), true);
      dv.setBigUint64(funcPos, entryPC, true);
      dv.setInt32(funcPos + 8, nameOffsets[i], true);
      dv.setInt32(funcPos + 12, fn.argsSize ?? 16, true);
    } else {
      const entryOff = fn.entryOff ?? i * 0x100;
      const slot = pclnStart + i * 8;
      dv.setUint32(slot, entryOff, true);
      dv.setUint32(slot + 4, funcOff, true);
      dv.setUint32(funcPos, entryOff, true);
      dv.setInt32(funcPos + 4, nameOffsets[i], true);
      dv.setInt32(funcPos + 8, fn.argsSize ?? 16, true);
      dv.setInt32(funcPos + 12, 0, true);
    }
  }

  return buf;
}

function createPclntab120(options = {}) {
  return createModernPclntab({ ...options, version: '1.20+' });
}

function createPclntab12() {
  const buf = new Uint8Array(512);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0xfffffffb, true);
  buf[6] = 1; buf[7] = 8;
  dv.setBigUint64(8, 1n, true);

  const ftabStart = 16;
  const funcPos = 96;
  const namePos = 160;
  dv.setBigUint64(ftabStart, 0x401000n, true);
  dv.setBigUint64(ftabStart + 8, BigInt(funcPos), true);
  // nfunc+1 sentinel: legacy tables remain header-adjacent.
  dv.setBigUint64(ftabStart + 16, 0x401100n, true);
  dv.setBigUint64(ftabStart + 24, 0n, true);
  dv.setBigUint64(funcPos, 0x401000n, true);
  dv.setInt32(funcPos + 8, namePos, true);
  dv.setInt32(funcPos + 12, 8, true);
  dv.setInt32(funcPos + 16, 32, true);
  writeCString(buf, namePos, 'legacy.main');
  return buf;
}

function createPclntab12Header({ little = true, minLC = 1, pad1 = 0, pad2 = 0 } = {}) {
  const buf = new Uint8Array(16);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0xfffffffb, little);
  buf[4] = pad1;
  buf[5] = pad2;
  buf[6] = minLC;
  buf[7] = 8;
  dv.setBigUint64(8, 1n, little);
  return buf;
}

// 1. Positive: Go 1.20+ valid pclntab
{
  const buf = createPclntab120({
    nfunc: 2,
    textStart: 0x400000n,
    functions: [
      { entryOff: 0x1000, name: 'main.main', argsSize: 0 },
      { entryOff: 0x2000, name: 'main.helper', argsSize: 8 },
    ],
  });

  const provider = new GoMetadataProvider({
    pclntabBuffer: buf,
    binaryIdentity: 'sha256:go-test-binary',
    architecture: 'x86_64',
    platform: 'linux',
  });

  const probe = provider.probe();
  assert.equal(probe.authoritative, true);
  assert.equal(probe.completeness.complete, true);
  assert.equal(probe.completeness.parsed, 2);
  assert.equal(probe.identity.toolchainVersion, 'go1.20+');
  assert.equal(probe.identity.verdict, 'matched-authoritative');

  const syms = provider.symbols();
  assert.equal(syms.records.length, 2);
  assert.equal(syms.records[0].name, 'main.main');
  assert.equal(syms.records[0].address, '0x401000');
  assert.equal(syms.records[1].name, 'main.helper');
  assert.equal(syms.records[1].address, '0x402000');
}

// #3694: Go 1.16+ functab and _func offsets are rooted at pclnOff.
{
  for (const version of ['1.16', '1.18', '1.20+']) {
    const buf = createModernPclntab({
      version,
      nfunc: 1,
      textStart: 0x400000n,
      functions: [{ entryOff: 0x1234, name: `main.${version}`, argsSize: 24 }],
    });
    const header = parsePclntabHeader(buf);
    assert.equal(header.valid, true, `${version} header is valid`);
    assert.equal(header.ftabOff, header.pclnOff, `${version} functab starts at pclnOff`);

    const parsed = parseGoFunctions(buf, header);
    assert.equal(parsed.completeness.complete, true, `${version} parses completely`);
    assert.equal(parsed.functions.length, 1);
    assert.equal(parsed.functions[0].name, `main.${version}`);
    assert.equal(parsed.functions[0].address, '0x401234');
    assert.equal(parsed.functions[0].argsSize, 24);
  }
}

// #3694: Go 1.2 keeps its header-adjacent functab and absolute _func offsets.
{
  const buf = createPclntab12();
  const header = parsePclntabHeader(buf);
  assert.equal(header.valid, true);
  assert.equal(header.version, '1.2');
  assert.equal(header.ftabOff, 16);
  const parsed = parseGoFunctions(buf, header);
  assert.equal(parsed.completeness.complete, true);
  assert.equal(parsed.functions[0].name, 'legacy.main');
  assert.equal(parsed.functions[0].address, '0x401000');
}

// #3694: decoded modern table offsets are authority-bearing and must be in-section safe integers.
{
  const offsetFields = [
    ['funcnametabOff', 32],
    ['cutabOff', 40],
    ['filetabOff', 48],
    ['pctabOff', 56],
    ['pclnOff', 64],
  ];
  for (const [offsetName, fieldPos] of offsetFields) {
    const buf = createPclntab120({ nfunc: 1, functions: [{ entryOff: 0x1000, name: 'main.main' }] });
    new DataView(buf.buffer).setBigUint64(fieldPos, BigInt(buf.length), true);
    const header = parsePclntabHeader(buf);
    assert.equal(header.valid, false, `${offsetName} at section end is rejected`);
    assert.equal(header.reason, 'invalid-table-offset');
    assert.equal(header.offsetName, offsetName);
  }

  const unsafe = createPclntab120({ nfunc: 1, functions: [{ entryOff: 0x1000, name: 'main.main' }] });
  new DataView(unsafe.buffer).setBigUint64(32, 1n << 53n, true);
  const unsafeHeader = parsePclntabHeader(unsafe);
  assert.equal(unsafeHeader.valid, false);
  assert.equal(unsafeHeader.reason, 'invalid-table-offset');
  assert.equal(unsafeHeader.offsetName, 'funcnametabOff');
}

// #3706: official pclntab header discriminants are authority-bearing.
{
  for (const minLC of [1, 2, 4]) {
    const buf = createPclntab120({ nfunc: 1, functions: [{ entryOff: 0x1000, name: 'main.main' }] });
    buf[6] = minLC;
    const header = parsePclntabHeader(buf);
    assert.equal(header.valid, true, `pc quantum ${minLC} is accepted`);
    assert.equal(header.minLC, minLC);
  }

  for (const minLC of [0, 3, 5]) {
    const buf = createPclntab120({ nfunc: 1, functions: [{ entryOff: 0x1000, name: 'main.main' }] });
    buf[6] = minLC;
    const header = parsePclntabHeader(buf);
    assert.equal(header.valid, false, `pc quantum ${minLC} is rejected`);
    assert.equal(header.reason, 'invalid-pc-quantum');
    assert.equal(header.minLC, minLC);
  }

  for (const paddingOffset of [4, 5]) {
    const buf = createPclntab120({ nfunc: 1, functions: [{ entryOff: 0x1000, name: 'main.main' }] });
    buf[paddingOffset] = 1;
    const header = parsePclntabHeader(buf);
    assert.equal(header.valid, false, `non-zero reserved byte ${paddingOffset} is rejected`);
    assert.equal(header.reason, 'invalid-header-padding');
  }

  const littleHeader = parsePclntabHeader(createPclntab12Header({ little: true, minLC: 2 }));
  assert.equal(littleHeader.valid, true);
  assert.equal(littleHeader.little, true);
  assert.equal(littleHeader.version, '1.2');

  const bigHeader = parsePclntabHeader(createPclntab12Header({ little: false, minLC: 4 }));
  assert.equal(bigHeader.valid, true);
  assert.equal(bigHeader.little, false);
  assert.equal(bigHeader.version, '1.2');

  const malformed = createPclntab120({ nfunc: 1, functions: [{ entryOff: 0x1000, name: 'main.main' }] });
  malformed[4] = 0xff;
  const provider = new GoMetadataProvider({
    pclntabBuffer: malformed,
    binaryIdentity: 'sha256:malformed-go-header',
  });
  const probe = provider.probe();
  assert.equal(probe.authoritative, false);
  assert.equal(probe.identity.verdict, 'malformed');
  assert.equal(probe.completeness.complete, false);
  assert.deepEqual(probe.completeness.reasons, ['invalid-header-padding']);
  assert.equal(provider.symbols().records.length, 0, 'malformed header must not reach function parsing');
}

// #3432: maxRecords is coverage authority and must remain a typed, non-negative
// safe-integer number rather than relying on Math.min() ToNumber coercion.
{
  const buf = createPclntab120({
    nfunc: 2,
    functions: [
      { entryOff: 0x1000, name: 'main.one' },
      { entryOff: 0x2000, name: 'main.two' },
    ],
  });
  const header = parsePclntabHeader(buf);
  assert.ok(header);

  for (const maxRecords of ['1', true, false, [1], {}, NaN, Infinity, 1.5, -1]) {
    assert.throws(
      () => parseGoFunctions(buf, header, { maxRecords }),
      /go-metadata-invalid-max-records/,
      `maxRecords rejects ${String(maxRecords)}`,
    );
  }

  const none = parseGoFunctions(buf, header, { maxRecords:0 });
  assert.equal(none.completeness.scanned, 0);
  assert.equal(none.functions.length, 0);

  const one = parseGoFunctions(buf, header, { maxRecords:1 });
  assert.equal(one.completeness.scanned, 1);
  assert.equal(one.functions.length, 1);

  const defaults = parseGoFunctions(buf, header);
  assert.equal(defaults.completeness.scanned, 2);
  assert.equal(defaults.functions.length, 2);
}

// 2. Negative: Unknown future Go magic (0xffffffef) -> Fail-closed
{
  const buf = new Uint8Array(256);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0xffffffef, true); // Unknown future magic
  buf[6] = 1; buf[7] = 8;
  dv.setBigUint64(8, 5n, true);

  const provider = new GoMetadataProvider({
    pclntabBuffer: buf,
    binaryIdentity: 'sha256:future-go-binary',
  });

  const probe = provider.probe();
  assert.equal(probe.authoritative, false);
  assert.equal(probe.identity.verdict, 'unsupported');
  assert.equal(probe.completeness.complete, false);
  assert.match(probe.diagnostics[0], /unrecognized-magic/);

  const syms = provider.symbols();
  assert.equal(syms.records.length, 0, 'unsupported magic must never fabricate symbols');
}

// 3. Negative: Corrupted / truncated buffer
{
  const truncatedBuf = new Uint8Array(8); // smaller than header
  const provider = new GoMetadataProvider({
    pclntabBuffer: truncatedBuf,
    binaryIdentity: 'sha256:truncated',
  });

  const probe = provider.probe();
  assert.equal(probe.authoritative, false);
  assert.equal(probe.completeness.complete, false);
}

// 4. Negative: Stripped binary (no pclntab)
{
  const provider = new GoMetadataProvider({
    pclntabBuffer: null,
    binaryIdentity: 'sha256:stripped',
  });

  const probe = provider.probe();
  assert.equal(probe.authoritative, false);
  assert.equal(probe.completeness.present, false);
  assert.equal(probe.identity.verdict, 'identity-unavailable');
  assert.equal(provider.symbols().records.length, 0);
}

// 5. Positive: Go build version extraction
{
  const rodata = new TextEncoder().encode('\x00\xff Go buildinf:\x00\x00go1.21.5\x00\x00');
  const ver = findGoBuildVersion(rodata);
  assert.equal(ver, '1.21.5');
}

// 6. Positive: Go type descriptor parser
{
  const typeBuf = new Uint8Array(128);
  const dv = new DataView(typeBuf.buffer);
  // size = 24, ptrdata = 8, hash = 0x12345678, tflag = 2 (named), align = 8, fieldAlign = 8, kind = 25 (struct)
  dv.setBigUint64(0, 24n, true);
  dv.setBigUint64(8, 8n, true);
  dv.setUint32(16, 0x12345678, true);
  typeBuf[20] = 2; // tflag
  typeBuf[21] = 8; // align
  typeBuf[22] = 8; // fieldAlign
  typeBuf[23] = 25; // struct

  const desc = parseGoTypeDescriptor(typeBuf, 0, { ptrSize: 8, little: true });
  assert.equal(desc.kind, 'struct');
  assert.equal(desc.size, 24);
  assert.equal(desc.ptrdata, 8);
  assert.equal(desc.align, 8);
}

assert.equal(GO_PCLNTAB_MAGICS[0xfffffff1].version, '1.20+');
console.log('Go Metadata Provider tests passed.');
