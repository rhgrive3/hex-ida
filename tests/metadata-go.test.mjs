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

// Helper to construct synthetic pclntab buffers
function createPclntab120({ nfunc = 2, textStart = 0x400000n, functions = [] } = {}) {
  // Pclntab 1.20 layout
  // 0: magic (0xfffffff1)
  // 4: pad0 (0), pad1 (0), minLC (1), ptrSize (8)
  // 8: nfunc (uint64)
  // 16: nfiles (uint64)
  // 24: textStart (uint64)
  // 32: funcnametab offset (uint64) = 96
  // 40: cutab offset (uint64) = 96
  // 48: filetab offset (uint64) = 96
  // 56: pctab offset (uint64) = 96
  // 64: pcln offset (uint64) = 96
  // 72: ftab offset starts here! (8 uint64s = 64 bytes offset from 8 => 72)
  // ftab: nfunc entries of { entryOff (uint32), funcOff (uint32) }
  const buf = new Uint8Array(2048);
  const dv = new DataView(buf.buffer);

  dv.setUint32(0, 0xfffffff1, true);
  buf[4] = 0; buf[5] = 0; buf[6] = 1; buf[7] = 8;
  dv.setBigUint64(8, BigInt(nfunc), true);
  dv.setBigUint64(16, 0n, true);
  dv.setBigUint64(24, textStart, true);
  dv.setBigUint64(32, 200n, true); // funcnametab offset
  dv.setBigUint64(40, 200n, true);
  dv.setBigUint64(48, 200n, true);
  dv.setBigUint64(56, 200n, true);
  dv.setBigUint64(64, 200n, true);

  const ftabStart = 72;
  const funcDataStart = 400;
  const nameTabStart = 200;

  // Add strings to nameTabStart
  let nameCursor = nameTabStart;
  const nameOffsets = [];
  for (const fn of functions) {
    const off = nameCursor - nameTabStart;
    nameOffsets.push(off);
    const str = fn.name || 'pkg.Func';
    for (let i = 0; i < str.length; i++) buf[nameCursor + i] = str.charCodeAt(i);
    buf[nameCursor + str.length] = 0;
    nameCursor += str.length + 1;
  }

  for (let i = 0; i < nfunc; i++) {
    const fn = functions[i] || { entryOff: i * 0x100, name: `func_${i}` };
    const funcDescOff = funcDataStart + i * 32;
    // ftab slot
    dv.setUint32(ftabStart + i * 8, fn.entryOff, true);
    dv.setUint32(ftabStart + i * 8 + 4, funcDescOff, true);

    // _func descriptor
    dv.setUint32(funcDescOff + 0, fn.entryOff, true);
    dv.setInt32(funcDescOff + 4, nameOffsets[i] ?? 0, true);
    dv.setInt32(funcDescOff + 8, fn.argsSize ?? 16, true);
    dv.setInt32(funcDescOff + 12, 0, true);
  }

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

console.log('Go Metadata Provider tests passed.');
