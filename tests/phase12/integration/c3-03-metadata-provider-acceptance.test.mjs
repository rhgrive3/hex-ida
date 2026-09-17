import assert from 'node:assert/strict';
import test from 'node:test';

import {
  METADATA_PROVIDER_CONTRACT_VERSION,
  METADATA_PROVIDER_SCHEMA_VERSION,
  createLanguageMetadataIdentity,
  createLanguageMetadataRecord,
  createLanguageMetadataResult,
  isLanguageRecordAuthoritative,
  languageMetadataFunctionEvidence,
} from '../../../js/metadata/provider.js';
import { parseUnifiedLanguageMetadata } from '../../../js/metadata/index.js';
import {
  GoMetadataProvider,
  GO_PCLNTAB_MAGICS,
  GO_PROVIDER_ID,
  GO_PROVIDER_VERSION,
} from '../../../js/metadata/go.js';
import {
  RustMetadataProvider,
  RUST_PROVIDER_ID,
  RUST_PROVIDER_VERSION,
} from '../../../js/metadata/rust.js';
import {
  SwiftMetadataProvider,
  SWIFT_PROVIDER_ID,
  SWIFT_PROVIDER_VERSION,
} from '../../../js/metadata/swift.js';
import {
  ObjcMetadataProvider,
  OBJC_PROVIDER_ID,
  OBJC_PROVIDER_VERSION,
} from '../../../js/metadata/objc.js';

// C3-03 acceptance is intentionally a finite, executable denominator. It
// checks the provider boundary and the supported metadata generations; it does
// not pretend that this small fixture set is a native-binary corpus.
const GO_ROWS = Object.freeze([
  { label: 'go-1.2', version: '1.2', magic: 0xfffffffb },
  { label: 'go-1.16', version: '1.16', magic: 0xfffffffa },
  { label: 'go-1.18', version: '1.18', magic: 0xfffffff0 },
  { label: 'go-1.20-plus', version: '1.20+', magic: 0xfffffff1 },
]);
const RUST_ROWS = Object.freeze([
  {
    label: 'rustc-1.56-legacy',
    toolchain: '1.56.0',
    symbol: '_ZN6my_app4main17haabbccddeeff0011E',
  },
  {
    label: 'rustc-1.80-v0',
    toolchain: '1.80.0',
    symbol: '_RNvNtC4core3fmt3num',
  },
]);
const SWIFT_ROWS = Object.freeze([
  { label: 'swift5-arm64', architecture: 'arm64' },
  { label: 'swift5-arm64-32', architecture: 'arm64_32' },
]);
const OBJC_ROWS = Object.freeze([
  { label: 'objc2-arm64-32', architecture: 'arm64_32' },
]);

const PROVIDER_ROWS = Object.freeze([
  { ecosystem: 'go', id: GO_PROVIDER_ID, version: GO_PROVIDER_VERSION, Provider: GoMetadataProvider },
  { ecosystem: 'rust', id: RUST_PROVIDER_ID, version: RUST_PROVIDER_VERSION, Provider: RustMetadataProvider },
  { ecosystem: 'swift', id: SWIFT_PROVIDER_ID, version: SWIFT_PROVIDER_VERSION, Provider: SwiftMetadataProvider },
  { ecosystem: 'objc', id: OBJC_PROVIDER_ID, version: OBJC_PROVIDER_VERSION, Provider: ObjcMetadataProvider },
]);

const binaryId = (label) => `sha256:c3-03-${label}`;

function writeCString(bytes, offset, value) {
  for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
  bytes[offset + value.length] = 0;
}

function makeGoPclntab({ version, magic }) {
  const bytes = new Uint8Array(2048);
  const view = new DataView(bytes.buffer);
  const textStart = 0x400000n;
  const nameStart = 160;
  const pclnStart = 512;
  const funcOffset = 128;
  const funcPosition = pclnStart + funcOffset;

  view.setUint32(0, magic, true);
  bytes[4] = 0;
  bytes[5] = 0;
  bytes[6] = 1;
  bytes[7] = 8;
  view.setBigUint64(8, 1n, true);
  view.setBigUint64(16, 0n, true);

  if (version === '1.2') {
    view.setBigUint64(16, textStart, true);
    view.setBigUint64(24, BigInt(funcPosition), true);
    view.setBigUint64(32, 0n, true);
    view.setBigUint64(40, 0n, true);
    view.setBigUint64(funcPosition, textStart + 0x1000n, true);
    view.setInt32(funcPosition + 8, nameStart, true);
    view.setInt32(funcPosition + 12, 0, true);
    view.setInt32(funcPosition + 16, 32, true);
  } else {
    if (version === '1.16') {
      view.setBigUint64(24, BigInt(nameStart), true);
      view.setBigUint64(32, 240n, true);
      view.setBigUint64(40, 280n, true);
      view.setBigUint64(48, 320n, true);
      view.setBigUint64(56, BigInt(pclnStart), true);
    } else {
      view.setBigUint64(24, textStart, true);
      view.setBigUint64(32, BigInt(nameStart), true);
      view.setBigUint64(40, 240n, true);
      view.setBigUint64(48, 280n, true);
      view.setBigUint64(56, 320n, true);
      view.setBigUint64(64, BigInt(pclnStart), true);
    }
    if (version === '1.16') {
      view.setBigUint64(pclnStart, textStart + 0x1000n, true);
      view.setBigUint64(pclnStart + 8, BigInt(funcOffset), true);
      view.setBigUint64(funcPosition, textStart + 0x1000n, true);
      view.setInt32(funcPosition + 8, 0, true);
      view.setInt32(funcPosition + 12, 0, true);
    } else {
      view.setUint32(pclnStart, 0x1000, true);
      view.setUint32(pclnStart + 4, funcOffset, true);
      view.setUint32(funcPosition, 0x1000, true);
      view.setInt32(funcPosition + 4, 0, true);
      view.setInt32(funcPosition + 8, 0, true);
      view.setInt32(funcPosition + 12, 0, true);
    }
  }
  writeCString(bytes, nameStart, 'main.main');
  return bytes;
}

function makeSwiftFixture() {
  const bytes = new Uint8Array(0x4000);
  const view = new DataView(bytes.buffer);
  view.setUint32(0x1100, 17, true); // struct nominal descriptor
  view.setInt32(0x1104, 0, true);
  view.setInt32(0x1108, 0x1200 - 0x1108, true);
  view.setInt32(0x110c, 0, true);
  view.setInt32(0x1110, 0, true);
  view.setUint32(0x1114, 0, true);
  view.setUint32(0x1118, 0, true);
  view.setInt32(0x1000, 0x1100 - 0x1000, true);
  writeCString(bytes, 0x1200, 'C3SwiftState');
  const readAt = async (address, length) => {
    const start = Number(address);
    if (!Number.isSafeInteger(start) || start < 0 || start >= bytes.length) return null;
    return bytes.subarray(start, Math.min(bytes.length, start + length));
  };
  return {
    readAt,
    sections: [{ name: '__swift5_types', section: '__swift5_types', vmAddr: 0x1000n, size: 4n }],
  };
}

function makeObjcFixture() {
  const bytes = new Uint8Array(0x4000);
  const view = new DataView(bytes.buffer);
  const p32 = (address, value) => view.setUint32(Number(address), Number(value) >>> 0, true);
  const string = (address, value) => writeCString(bytes, Number(address), value);
  const classList = 0x200;
  const classAddress = 0x1000;
  const classRo = 0x1200;
  const classMethods = 0x1400;
  const className = 0x1800;
  const classSelector = 0x1900;
  const categoryList = 0x400;
  const categoryAddress = 0x2c00;
  const categoryName = 0x2e00;
  const categoryMethods = 0x2f00;
  const categorySelector = 0x2f80;
  const protocolList = 0x300;
  const protocolAddress = 0x2400;
  const protocolName = 0x2800;
  const protocolProperties = 0x1b00;
  const protocolClassProperties = 0x1b20;

  p32(classList, classAddress);
  p32(classAddress + 16, classRo);
  p32(classRo + 8, 0x20);
  p32(classRo + 16, className);
  p32(classRo + 20, classMethods);
  p32(classRo + 28, 0);
  p32(classRo + 36, 0);
  string(className, 'C3ObjcState');
  p32(classMethods, 12);
  p32(classMethods + 4, 1);
  p32(classMethods + 8, classSelector);
  p32(classMethods + 12, 0);
  p32(classMethods + 16, 0x2100);
  string(classSelector, 'persist:');

  p32(protocolList, protocolAddress);
  p32(protocolAddress + 4, protocolName);
  p32(protocolAddress + 28, protocolProperties);
  p32(protocolAddress + 32, 52);
  p32(protocolAddress + 36, 0);
  p32(protocolAddress + 48, protocolClassProperties);
  string(protocolName, 'C3ObjcProtocol');
  p32(protocolProperties, 8);
  p32(protocolProperties + 4, 0);
  p32(protocolClassProperties, 8);
  p32(protocolClassProperties + 4, 0);

  p32(categoryList, categoryAddress);
  p32(categoryAddress, categoryName);
  p32(categoryAddress + 4, classAddress);
  p32(categoryAddress + 8, categoryMethods);
  p32(categoryAddress + 20, 0);
  p32(categoryAddress + 24, 0);
  string(categoryName, 'C3ObjcCategory');
  p32(categoryMethods, 12);
  p32(categoryMethods + 4, 1);
  p32(categoryMethods + 8, categorySelector);
  p32(categoryMethods + 12, 0);
  p32(categoryMethods + 16, 0x2200);
  string(categorySelector, 'categoryWork:');

  const readAt = async (address, length) => {
    const start = Number(address);
    if (!Number.isSafeInteger(start) || start < 0 || start >= bytes.length) return null;
    return bytes.subarray(start, Math.min(bytes.length, start + length));
  };
  return {
    readAt,
    sections: [
      { name: '__objc_classlist', section: '__objc_classlist', vmAddr: BigInt(classList), size: 4n },
      { name: '__objc_protolist', section: '__objc_protolist', vmAddr: BigInt(protocolList), size: 4n },
      { name: '__objc_catlist', section: '__objc_catlist', vmAddr: BigInt(categoryList), size: 4n },
    ],
    options: { runtimeSections: { executableRanges: [{ vmAddr: 0x2000n, size: 0x1000n }] } },
  };
}

function collectRecords(provider) {
  return ['symbols', 'types', 'vtables', 'conformances', 'protocols', 'methods']
    .filter((method) => typeof provider[method] === 'function')
    .flatMap((method) => provider[method]().records);
}

async function positiveProviderCases() {
  const go = new GoMetadataProvider({
    pclntabBuffer: makeGoPclntab(GO_ROWS[3]),
    binaryIdentity: binaryId('identity-go'),
  });
  const rust = new RustMetadataProvider({
    symbols: [{ name: RUST_ROWS[1].symbol, address: '0x2000' }],
    commentBuffer: new TextEncoder().encode(`rustc version ${RUST_ROWS[1].toolchain}`),
    binaryIdentity: binaryId('identity-rust'),
  });
  const swiftFixture = makeSwiftFixture();
  const swift = new SwiftMetadataProvider({
    ...swiftFixture,
    architecture: 'arm64',
    binaryIdentity: binaryId('identity-swift'),
  });
  const objcFixture = makeObjcFixture();
  const objc = new ObjcMetadataProvider({
    ...objcFixture,
    architecture: 'arm64_32',
    binaryIdentity: binaryId('identity-objc'),
  });
  const cases = [
    { ecosystem: 'go', provider: go },
    { ecosystem: 'rust', provider: rust },
    { ecosystem: 'swift', provider: swift },
    { ecosystem: 'objc', provider: objc },
  ];
  return Promise.all(cases.map(async (entry) => ({ ...entry, result: await entry.provider.probe() })));
}

test('C3-03 provider contract is versioned and total over all four ecosystems', () => {
  assert.equal(PROVIDER_ROWS.length, 4);
  assert.equal(METADATA_PROVIDER_CONTRACT_VERSION, '1.0.0');
  assert.equal(METADATA_PROVIDER_SCHEMA_VERSION, 1);
  const ids = new Set();
  const ecosystems = new Set();
  for (const row of PROVIDER_ROWS) {
    assert.match(row.id, /^metadata\.[a-z]+$/);
    assert.match(row.version, /^\d+\.\d+\.\d+$/);
    assert.equal(new row.Provider({}).id, row.id);
    assert.equal(new row.Provider({}).version, row.version);
    assert.equal(new row.Provider({}).ecosystem, row.ecosystem);
    assert.equal(ids.has(row.id), false, `duplicate provider ${row.id}`);
    assert.equal(ecosystems.has(row.ecosystem), false, `duplicate ecosystem ${row.ecosystem}`);
    ids.add(row.id);
    ecosystems.add(row.ecosystem);
  }
  assert.deepEqual([...ecosystems].sort(), ['go', 'objc', 'rust', 'swift']);
});

for (const row of GO_ROWS) {
  test(`C3-03 Go version row ${row.label} is parsed without exactness overclaim`, () => {
    assert.equal(GO_PCLNTAB_MAGICS[row.magic]?.version, row.version);
    const provider = new GoMetadataProvider({
      pclntabBuffer: makeGoPclntab(row),
      binaryIdentity: binaryId(row.label),
      architecture: 'x86_64',
      platform: 'linux',
    });
    const result = provider.probe();
    const records = provider.symbols().records;
    assert.equal(result.providerId, GO_PROVIDER_ID);
    assert.equal(result.providerVersion, GO_PROVIDER_VERSION);
    assert.equal(result.ecosystem, 'go');
    assert.equal(result.identity.toolchainVersion, `go${row.version}`);
    assert.equal(result.identity.verdict, 'matched-partial');
    assert.equal(result.completeness.complete, false);
    assert.ok(result.completeness.reasons.includes('go-runtime-types-unscanned'));
    assert.equal(records.length, 1);
    assert.equal(records.every((record) => isLanguageRecordAuthoritative(result, record)), false,
      'pclntab-only function evidence must not become whole-provider exactness');
    assert.equal(languageMetadataFunctionEvidence(result, { records }).every((entry) => entry.confidence === 'heuristic'), true);
  });
}

for (const row of RUST_ROWS) {
  test(`C3-03 Rust compiler/mangling row ${row.label} is version-bound`, () => {
    const provider = new RustMetadataProvider({
      symbols: [{ name: row.symbol, address: '0x2000' }],
      commentBuffer: new TextEncoder().encode(`rustc version ${row.toolchain}`),
      binaryIdentity: binaryId(row.label),
    });
    const result = provider.probe();
    const records = provider.symbols().records;
    assert.equal(result.providerId, RUST_PROVIDER_ID);
    assert.equal(result.providerVersion, RUST_PROVIDER_VERSION);
    assert.equal(result.identity.toolchainVersion, row.toolchain);
    assert.equal(result.identity.verdict, 'matched-authoritative');
    assert.equal(result.completeness.complete, true);
    assert.equal(records.length, 1);
    assert.equal(records.every((record) => isLanguageRecordAuthoritative(result, record)), true);
  });
}

for (const row of SWIFT_ROWS) {
  test(`C3-03 Swift runtime ABI row ${row.label} is version-bound`, async () => {
    const provider = new SwiftMetadataProvider({
      ...makeSwiftFixture(),
      architecture: row.architecture,
      binaryIdentity: binaryId(row.label),
    });
    const result = await provider.probe();
    const records = provider.types().records;
    assert.equal(result.providerId, SWIFT_PROVIDER_ID);
    assert.equal(result.providerVersion, SWIFT_PROVIDER_VERSION);
    assert.equal(result.identity.toolchainVersion, 'swift-5.x');
    assert.equal(result.identity.verdict, 'matched-authoritative');
    assert.equal(result.completeness.complete, true);
    assert.equal(records.length, 1);
    assert.equal(records[0].address, '0x1100');
    assert.equal(isLanguageRecordAuthoritative(result, records[0]), true);
  });
}

for (const row of OBJC_ROWS) {
  test(`C3-03 Objective-C runtime row ${row.label} exposes class/category/protocol pages`, async () => {
    const fixture = makeObjcFixture();
    const provider = new ObjcMetadataProvider({
      ...fixture,
      architecture: row.architecture,
      binaryIdentity: binaryId(row.label),
    });
    const result = await provider.probe();
    const types = provider.types().records;
    const protocols = provider.protocols().records;
    const methods = provider.methods().records;
    assert.equal(result.providerId, OBJC_PROVIDER_ID);
    assert.equal(result.providerVersion, OBJC_PROVIDER_VERSION);
    assert.equal(result.identity.toolchainVersion, 'objc-2.0');
    assert.equal(result.identity.verdict, 'matched-authoritative');
    assert.equal(result.completeness.complete, true);
    assert.equal(result.counts.types, 1);
    assert.equal(result.counts.categories, 1);
    assert.equal(result.counts.protocols, 1);
    assert.equal(types[0]?.name, 'C3ObjcState');
    assert.equal(types[0]?.address, '0x1000');
    assert.equal(protocols[0]?.name, 'C3ObjcProtocol');
    assert.equal(protocols[0]?.address, '0x2400');
    assert.equal(protocols[0]?.descriptor.kind, 'protocol');
    const categoryMethod = methods.find((record) => record.descriptor.categoryName === 'C3ObjcCategory');
    assert.equal(categoryMethod?.address, '0x2200');
    assert.equal(categoryMethod?.descriptor.source, 'category');
    assert.equal(new Set([types[0]?.address, protocols[0]?.address, categoryMethod?.address]).size, 3);
    assert.equal([...types, ...protocols, ...methods].every((record) => isLanguageRecordAuthoritative(result, record)), true);
  });
}

const FAIL_CLOSED_ROWS = Object.freeze([
  {
    label: 'go-unknown-version',
    run: () => {
      const provider = new GoMetadataProvider({
        pclntabBuffer: makeGoPclntab({ version: '1.20+', magic: 0xfffffff2 }),
        binaryIdentity: binaryId('unknown-go'),
      });
      return { provider, result: provider.probe(), expected: 'unsupported' };
    },
  },
  {
    label: 'go-truncated',
    run: () => {
      const provider = new GoMetadataProvider({ pclntabBuffer: new Uint8Array(8), binaryIdentity: binaryId('truncated-go') });
      return { provider, result: provider.probe(), expected: 'malformed' };
    },
  },
  {
    label: 'rust-self-backreference-cycle',
    run: () => {
      const provider = new RustMetadataProvider({
        symbols: [{ name: '_RB_', address: '0x2000' }],
        binaryIdentity: binaryId('cyclic-rust'),
      });
      return { provider, result: provider.probe(), expected: 'matched-partial' };
    },
  },
  {
    label: 'swift-truncated-descriptor',
    run: async () => {
      const fixture = makeSwiftFixture();
      const provider = new SwiftMetadataProvider({
        ...fixture,
        readAt: async () => null,
        binaryIdentity: binaryId('truncated-swift'),
      });
      return { provider, result: await provider.probe(), expected: 'matched-partial' };
    },
  },
  {
    label: 'objc-truncated-classlist',
    run: async () => {
      const fixture = makeObjcFixture();
      const provider = new ObjcMetadataProvider({
        ...fixture,
        readAt: async () => null,
        architecture: 'arm64_32',
        binaryIdentity: binaryId('truncated-objc'),
      });
      return { provider, result: await provider.probe(), expected: 'matched-partial' };
    },
  },
  {
    label: 'objc-unknown-pointer-abi',
    run: async () => {
      const fixture = makeObjcFixture();
      const provider = new ObjcMetadataProvider({
        ...fixture,
        architecture: 'mips64',
        binaryIdentity: binaryId('unknown-objc-abi'),
      });
      return { provider, result: await provider.probe(), expected: 'matched-partial' };
    },
  },
]);

for (const row of FAIL_CLOSED_ROWS) {
  test(`C3-03 fail-closed row ${row.label}`, async () => {
    const { provider, result, expected } = await row.run();
    assert.equal(result.identity.verdict, expected);
    assert.equal(result.completeness.complete, false);
    const records = collectRecords(provider);
    assert.equal(records.length, 0, 'invalid metadata must not fabricate public records');
    assert.equal(records.some((record) => isLanguageRecordAuthoritative(result, record)), false);
  });
}

test('C3-03 unknown record kinds are rejected before canonical publication', () => {
  const fields = {
    entityId: 'future@0x1000',
    name: 'FutureKind',
    address: '0x1000',
    providerId: 'metadata.future',
    providerVersion: '1.0.0',
    ecosystem: 'future',
    buildIdentity: binaryId('future-kind'),
  };
  assert.throws(
    () => createLanguageMetadataRecord({ ...fields, kind: 'future-kind' }),
    /metadata-record-invalid-kind/,
  );
  const identity = createLanguageMetadataIdentity({
    verdict: 'matched-authoritative',
    providerId: fields.providerId,
    providerVersion: fields.providerVersion,
    ecosystem: fields.ecosystem,
    binaryIdentity: fields.buildIdentity,
    expected: fields.buildIdentity,
    observed: fields.buildIdentity,
    method: 'c3-03-unknown-kind',
  });
  const result = createLanguageMetadataResult({
    identity,
    completeness: { present: true, declared: 1, scanned: 1, parsed: 1, complete: true },
  });
  assert.equal(isLanguageRecordAuthoritative(result, { ...fields, kind: 'future-kind' }), false);
});

test('C3-03 provider identity mismatch never crosses the exactness boundary', async () => {
  for (const { provider, result, ecosystem } of await positiveProviderCases()) {
    const source = collectRecords(provider)[0];
    assert.ok(source, `${ecosystem} positive fixture must emit a record`);
    assert.equal(source.providerId, result.providerId);
    assert.equal(source.providerVersion, result.providerVersion);
    assert.equal(source.ecosystem, result.ecosystem);
    for (const change of [
      { providerId: 'metadata.foreign' },
      { providerVersion: '99.99.99' },
      { ecosystem: 'foreign' },
      { buildIdentity: binaryId('foreign-build') },
    ]) {
      const forged = createLanguageMetadataRecord({ ...source, ...change });
      assert.equal(isLanguageRecordAuthoritative(result, forged), false,
        `${ecosystem}: ${JSON.stringify(change)} must not be authoritative`);
    }
    const foreignIdentity = createLanguageMetadataIdentity({
      ...result.identity,
      providerId: 'metadata.foreign',
      providerVersion: '99.99.99',
      ecosystem: 'foreign',
      binaryIdentity: binaryId('foreign-identity'),
      expected: binaryId('foreign-identity'),
      observed: binaryId('foreign-identity'),
    });
    assert.equal(isLanguageRecordAuthoritative({ ...result, identity: foreignIdentity }, source), false,
      `${ecosystem}: foreign provider identity must not authorize source records`);
  }
});

test('C3-03 unified dispatch returns all four versioned providers and stays incomplete when Apple readers are absent', async () => {
  const unified = await parseUnifiedLanguageMetadata({
    pclntabBuffer: makeGoPclntab(GO_ROWS[3]),
    symbols: [{ name: RUST_ROWS[1].symbol, address: '0x2000' }],
    sections: [
      { name: '__swift5_types', vmAddr: 0x1000n, size: 4n },
      { name: '__objc_classlist', vmAddr: 0x200n, size: 4n },
    ],
    binaryIdentity: binaryId('unified'),
  });
  assert.deepEqual(unified.ecosystems, ['go', 'rust', 'swift', 'objc']);
  assert.equal(unified.results.length, 4);
  assert.equal(unified.complete, false);
  assert.deepEqual(unified.results.map((entry) => [entry.provider.id, entry.result.providerVersion]), [
    [GO_PROVIDER_ID, GO_PROVIDER_VERSION],
    [RUST_PROVIDER_ID, RUST_PROVIDER_VERSION],
    [SWIFT_PROVIDER_ID, SWIFT_PROVIDER_VERSION],
    [OBJC_PROVIDER_ID, OBJC_PROVIDER_VERSION],
  ]);
  for (const entry of unified.results.filter((item) => ['swift', 'objc'].includes(item.ecosystem))) {
    assert.equal(entry.result.completeness.complete, false);
    assert.equal(entry.result.identity.verdict, 'identity-unavailable');
  }
});

test('C3-03 Objective-C successor probe clears the previous generation before publishing a failed scan', async () => {
  const fixture = makeObjcFixture();
  const provider = new ObjcMetadataProvider({
    ...fixture,
    architecture: 'arm64_32',
    binaryIdentity: binaryId('cache-generation'),
  });
  const first = await provider.probe();
  assert.equal(first.completeness.complete, true);
  assert.ok(provider.types().records.length > 0);
  assert.ok(provider.protocols().records.length > 0);
  provider.readAt = null;
  const successor = await provider.probe();
  assert.equal(successor.completeness.complete, false);
  assert.equal(successor.identity.verdict, 'identity-unavailable');
  assert.equal(provider.cachedModel, null);
  assert.equal(provider.cachedIndex, null);
  assert.equal(collectRecords(provider).length, 0, 'failed successor must not expose prior-generation records');
});
