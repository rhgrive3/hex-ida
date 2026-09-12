import assert from 'node:assert/strict';
import { SwiftMetadataProvider } from '../js/metadata/swift.js';
import { ObjcMetadataProvider } from '../js/metadata/objc.js';
import { RustMetadataProvider } from '../js/metadata/rust.js';
import { GoMetadataProvider } from '../js/metadata/go.js';
import {
  isLanguageRecordAuthoritative,
  applyLanguageMetadataTypesToGraph,
  languageMetadataFunctionEvidence,
} from '../js/metadata/provider.js';

console.log('Testing #4846: provider identity binding is required for matched-authoritative...');

function collectHard(result, records) {
  const events = [];
  applyLanguageMetadataTypesToGraph({
    addHardConstraint(c) { events.push({ type: 'hard', ...c }); },
    addSoftEvidence(e) { events.push({ type: 'soft', ...e }); },
  }, result, { records });
  return events;
}

function swiftFixture() {
  const mem = new Uint8Array(0x4000);
  const dv = new DataView(mem.buffer);
  dv.setUint32(0x1100, 17, true);
  dv.setInt32(0x1104, 0, true);
  dv.setInt32(0x1108, 0x1200 - 0x1108, true);
  dv.setInt32(0x110c, 0, true);
  dv.setInt32(0x1110, 0, true);
  dv.setUint32(0x1114, 0, true);
  dv.setUint32(0x1118, 0, true);
  const name = 'AppState';
  for (let i = 0; i < name.length; i++) mem[0x1200 + i] = name.charCodeAt(i);
  mem[0x1200 + name.length] = 0;
  dv.setInt32(0x1000, 0x1100 - 0x1000, true);
  const readAt = async (addr, len) => {
    const a = Number(addr);
    if (a < 0 || a >= mem.length) return null;
    return mem.subarray(a, Math.min(mem.length, a + len));
  };
  return (binaryIdentity) => new SwiftMetadataProvider({
    readAt,
    sections: [{ name: '__swift5_types', section: '__swift5_types', size: 4, vmAddr: 0x1000n, addr: 0x1000n }],
    binaryIdentity,
  });
}

function objcFixture() {
  const bytes = new Map();
  const put = (addr, data) => {
    const a = BigInt(addr);
    const u8 = data instanceof Uint8Array ? data : Uint8Array.from(data);
    for (let i = 0; i < u8.length; i++) bytes.set((a + BigInt(i)).toString(), u8[i]);
  };
  const p32 = (addr, value) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, Number(value) >>> 0, true);
    put(addr, b);
  };
  const p64 = (addr, value) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(value), true);
    put(addr, b);
  };
  const str = (addr, value) => {
    const out = new Uint8Array([...new TextEncoder().encode(String(value)), 0]);
    put(addr, out);
  };
  const classList = 0x1000n;
  const cls = 0x2000n;
  const ro = 0x3000n;
  const classNameAddr = 0x4000n;
  const selectorAddr = 0x4100n;
  const typesAddr = 0x4200n;
  const methods = 0x5000n;
  const imp = 0x6000n;
  p64(classList, cls);
  put(cls, new Uint8Array(40));
  p64(cls + 32n, ro);
  put(ro, new Uint8Array(72));
  p32(ro + 8n, 32);
  p64(ro + 24n, classNameAddr);
  p64(ro + 32n, methods);
  str(classNameAddr, 'HexBound');
  str(selectorAddr, 'persist:');
  str(typesAddr, 'v16@0:8');
  p32(methods, 24);
  p32(methods + 4n, 1);
  p64(methods + 8n, selectorAddr);
  p64(methods + 16n, typesAddr);
  p64(methods + 24n, imp);
  const readAt = async (addr, len) => {
    const a = BigInt(addr);
    const out = [];
    for (let i = 0; i < len; i++) {
      const value = bytes.get((a + BigInt(i)).toString());
      if (value == null) break;
      out.push(value);
    }
    return out.length ? Uint8Array.from(out) : null;
  };
  return (binaryIdentity) => new ObjcMetadataProvider({
    readAt,
    sections: [{ name: '__objc_classlist', section: '__objc_classlist', vmAddr: classList, addr: classList, size: 8n }],
    binaryIdentity,
    options: { runtimeSections: { executableRanges: [{ vmAddr: imp, size: 0x100n }] } },
  });
}

function rustFixture() {
  return (binaryIdentity) => new RustMetadataProvider({
    symbols: [
      { name: '_ZN6my_app4main17haabbccddeeff0011E', address: '0x1000', size: 32 },
      { name: '_RNvNtC4core3fmt3num', address: '0x2000', size: 64 },
    ],
    binaryIdentity,
  });
}

function goFixture() {
  const buf = new Uint8Array(2048);
  const dv = new DataView(buf.buffer);
  const textStart = 0x400000n;
  const nameTabStart = 160;
  const pclnStart = 512;
  const writeCString = (off, value) => {
    for (let i = 0; i < value.length; i++) buf[off + i] = value.charCodeAt(i);
    buf[off + value.length] = 0;
  };
  dv.setUint32(0, 0xfffffff1, true);
  buf[6] = 1;
  buf[7] = 8;
  dv.setBigUint64(8, 1n, true);
  dv.setBigUint64(16, 0n, true);
  dv.setBigUint64(24, textStart, true);
  dv.setBigUint64(32, BigInt(nameTabStart), true);
  dv.setBigUint64(40, 240n, true);
  dv.setBigUint64(48, 280n, true);
  dv.setBigUint64(56, 320n, true);
  dv.setBigUint64(64, BigInt(pclnStart), true);
  writeCString(nameTabStart, 'main.main');
  const funcOff = 128;
  const funcPos = pclnStart + funcOff;
  dv.setUint32(pclnStart, 0x1000, true);
  dv.setUint32(pclnStart + 4, funcOff, true);
  dv.setUint32(funcPos, 0x1000, true);
  dv.setInt32(funcPos + 4, 0, true);
  dv.setInt32(funcPos + 8, 16, true);
  dv.setInt32(funcPos + 12, 0, true);
  return (binaryIdentity) => new GoMetadataProvider({
    pclntabBuffer: buf,
    binaryIdentity,
    architecture: 'x86_64',
    platform: 'linux',
  });
}

const CASES = [
  { ecosystem: 'swift', make: swiftFixture(), page: (p) => p.types(), typeRecords: true },
  { ecosystem: 'objc', make: objcFixture(), page: (p) => p.types(), typeRecords: true },
  { ecosystem: 'rust', make: rustFixture(), page: (p) => p.symbols(), typeRecords: false },
  { ecosystem: 'go', make: goFixture(), page: (p) => p.symbols(), typeRecords: false },
];

for (const { ecosystem, make, page, typeRecords } of CASES) {
  const unboundProvider = make(null);
  const unbound = await unboundProvider.probe();
  const unboundRecords = page(unboundProvider).records;

  assert.equal(unbound.completeness.complete, true, `${ecosystem}: fixture model must be fully parsed`);
  assert.ok(unboundRecords.length > 0, `${ecosystem}: fixture must emit records`);
  assert.equal(unbound.identity.binaryIdentity, null, `${ecosystem}: fixture must be identity-unbound`);
  assert.equal(unbound.identity.verdict, 'identity-unavailable', `${ecosystem}: unbound complete model must fail closed`);
  assert.equal(unbound.authoritative, false, `${ecosystem}: unbound model must not be authoritative`);
  assert.equal(
    unboundRecords.some((record) => isLanguageRecordAuthoritative(unbound, record)),
    false,
    `${ecosystem}: no unbound record may carry authority`,
  );
  assert.equal(
    collectHard(unbound, unboundRecords).some((event) => event.type === 'hard'),
    false,
    `${ecosystem}: unbound records must not become hard constraints`,
  );

  const boundProvider = make(`sha256:${ecosystem}-bound`);
  const bound = await boundProvider.probe();
  const boundRecords = page(boundProvider).records;

  assert.equal(bound.identity.verdict, 'matched-authoritative', `${ecosystem}: proven identity binding stays authoritative`);
  assert.equal(bound.authoritative, true, `${ecosystem}: proven identity binding must remain authoritative`);
  assert.ok(
    boundRecords.every((record) => isLanguageRecordAuthoritative(bound, record)),
    `${ecosystem}: bound records stay authoritative`,
  );
  if (typeRecords) {
    assert.ok(
      collectHard(bound, boundRecords).some((event) => event.type === 'hard'),
      `${ecosystem}: proven identity binding must still reach hard constraints`,
    );
  }

  const functionRecords = boundRecords.filter((record) => (record.kind === 'symbol' || record.kind === 'method') && record.address != null);
  if (functionRecords.length > 0) {
    const exact = languageMetadataFunctionEvidence(bound, { records: functionRecords });
    assert.ok(exact.some((entry) => entry.confidence === 'exact'), `${ecosystem}: bound evidence is exact`);
    const unboundExact = languageMetadataFunctionEvidence(unbound, { records: unboundRecords.filter((record) => (record.kind === 'symbol' || record.kind === 'method') && record.address != null) });
    assert.ok(unboundExact.length > 0 && unboundExact.every((entry) => entry.confidence === 'heuristic'), `${ecosystem}: unbound evidence stays heuristic`);
  }
}

{
  const partialProvider = new RustMetadataProvider({
    symbols: [
      { name: '_ZN6my_app4main17haabbccddeeff0011E', address: '0x1000', size: 32 },
      { name: '_R?', address: '0x2000' },
    ],
    binaryIdentity: 'sha256:rust-partial',
  });
  const partial = await partialProvider.probe();
  assert.equal(partial.identity.verdict, 'matched-partial', 'incomplete model keeps matched-partial semantics');
  assert.equal(partial.completeness.complete, false, 'incomplete model stays incomplete');
  assert.deepEqual(
    partial.identity.coverage.recordKinds,
    ['symbol', 'type'],
    'incomplete model keeps its explicit coverage declaration',
  );
  assert.ok(partialProvider.symbols().records.length > 0, 'partial fixture must still emit records');

  const unboundPartial = new RustMetadataProvider({
    symbols: [
      { name: '_ZN6my_app4main17haabbccddeeff0011E', address: '0x1000', size: 32 },
      { name: '_R?', address: '0x2000' },
    ],
  }).probe();
  assert.equal(unboundPartial.identity.verdict, 'matched-partial', 'unbound incomplete model keeps matched-partial');
  assert.equal(unboundPartial.authoritative, true, 'matched-partial coverage semantics are unchanged');
}

console.log('#4846 tests passed successfully.');
