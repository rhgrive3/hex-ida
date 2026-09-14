// Regression for #4926: ObjcMetadataProvider.matched-partial coverage used to
// enumerate class metadata addresses while methods() emits records addressed by
// the method implementation, so the conjunctive coverage selectors could never
// be satisfied by a parsed method record. Coverage must be generated from the
// provider's own record identities.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ObjcMetadataProvider } from '../js/metadata/objc.js';
import {
  createLanguageMetadataIdentity,
  createLanguageMetadataRecord,
  createLanguageMetadataResult,
  isLanguageRecordAuthoritative,
} from '../js/metadata/provider.js';

const BINARY = 'sha256:issue-4926';
const CLASS_ADDR = 0x1000;
const METHOD_IMP_A = 0x2100;
const METHOD_IMP_B = 0x2110;

function objcFixtureRead() {
  const mem = new Uint8Array(0x4000);
  const dv = new DataView(mem.buffer);
  const p64 = (at, v) => dv.setBigUint64(at, BigInt(v), true);
  const p32 = (at, v) => dv.setUint32(at, Number(v) >>> 0, true);
  const str = (at, s) => {
    for (let i = 0; i < s.length; i++) mem[at + i] = s.charCodeAt(i);
    mem[at + s.length] = 0;
  };
  const metaAddr = 0x1100, classRo = 0x1200, metaRo = 0x1300, listAddr = 0x1400, classNameAddr = 0x1800;
  p64(0x200, CLASS_ADDR);
  p64(CLASS_ADDR + 0, metaAddr);
  p64(CLASS_ADDR + 32, classRo);
  p64(metaAddr + 0, 0);
  p64(metaAddr + 32, metaRo);
  p64(classRo + 24, classNameAddr);
  p64(classRo + 32, listAddr);
  p64(metaRo + 24, classNameAddr);
  str(classNameAddr, 'Victim');
  p32(listAddr, 24);
  p32(listAddr + 4, 2);
  const imps = [METHOD_IMP_A, METHOD_IMP_B];
  for (let i = 0; i < 2; i++) {
    const entry = listAddr + 8 + i * 24;
    const selAddr = 0x1900 + i * 0x20, typeAddr = 0x1a00 + i * 0x20;
    str(selAddr, `m${i}:`);
    str(typeAddr, 'v16@0:8');
    p64(entry + 0, selAddr);
    p64(entry + 8, typeAddr);
    p64(entry + 16, imps[i]);
  }
  return async (addr, len) => {
    const at = Number(addr);
    if (!Number.isSafeInteger(at) || at < 0 || at >= mem.length) return null;
    return mem.subarray(at, Math.min(mem.length, at + len));
  };
}

function makeProvider({ executable = false } = {}) {
  return new ObjcMetadataProvider({
    sections: [{ name: '__objc_classlist', section: '__objc_classlist', vmAddr: 0x200n, size: 8n }],
    readAt: objcFixtureRead(),
    binaryIdentity: BINARY,
    ...(executable
      ? { options: { runtimeSections: { executableRanges: [{ vmAddr: 0x2000n, size: 0x200n }] } } }
      : {}),
  });
}

async function partialProbe() {
  const provider = makeProvider();
  const probe = await provider.probe();
  assert.equal(probe.identity.verdict, 'matched-partial', 'unproven implementation addresses must keep the model partial');
  return { provider, probe };
}

function structurallyComplete(probe) {
  return createLanguageMetadataResult({
    identity: probe.identity,
    completeness: {
      present: true,
      declared: probe.completeness.declared,
      scanned: probe.completeness.scanned,
      parsed: probe.completeness.parsed,
      complete: true,
    },
  });
}

test('#4926 partial model keeps a parsed type record authoritative', async () => {
  const { provider, probe } = await partialProbe();
  const result = structurallyComplete(probe);
  const typeRecord = provider.types().records[0];
  assert.equal(typeRecord.kind, 'type');
  assert.equal(isLanguageRecordAuthoritative(result, typeRecord), true);
});

test('#4926 partial model makes parsed method records authoritative', async () => {
  const { provider, probe } = await partialProbe();
  const result = structurallyComplete(probe);
  const methodRecords = provider.methods().records;
  assert.equal(methodRecords.length, 2);
  for (const record of methodRecords) {
    assert.equal(record.kind, 'method');
    assert.equal(
      isLanguageRecordAuthoritative(result, record),
      true,
      `parsed method ${record.entityId} must satisfy the coverage selectors`,
    );
  }
});

test('#4926 class metadata address and method implementation address differ', async () => {
  const { provider, probe } = await partialProbe();
  const result = structurallyComplete(probe);
  const methodRecords = provider.methods().records;
  assert.equal(methodRecords[0].address, '0x2100');
  assert.equal(methodRecords[1].address, '0x2110');
  assert.notEqual(BigInt(methodRecords[0].address), BigInt(CLASS_ADDR));
  for (const record of methodRecords) {
    assert.equal(isLanguageRecordAuthoritative(result, record), true);
  }
});

test('#4926 method outside the parsed coverage stays non-authoritative', async () => {
  const { probe } = await partialProbe();
  const result = structurallyComplete(probe);
  const outside = createLanguageMetadataRecord({
    kind: 'method',
    entityId: 'method@Victim:-:neverParsed',
    name: '-[Victim neverParsed]',
    address: '0x3500',
    providerId: 'metadata.objc',
    providerVersion: '1.0.0',
    ecosystem: 'objc',
    buildIdentity: BINARY,
    descriptor: { selector: 'neverParsed', className: 'Victim', classMethod: false },
  });
  assert.equal(isLanguageRecordAuthoritative(result, outside), false);
  const coveredEntity = providerEntityOf(probe);
  const wrongKind = createLanguageMetadataRecord({
    kind: 'symbol',
    entityId: coveredEntity,
    providerId: 'metadata.objc',
    providerVersion: '1.0.0',
    ecosystem: 'objc',
    buildIdentity: BINARY,
  });
  assert.equal(isLanguageRecordAuthoritative(result, wrongKind), false);
});

function providerEntityOf(probe) {
  const ids = probe.identity.coverage?.entityIds || [];
  assert.ok(ids.length > 0, 'partial coverage must enumerate the parsed record identities');
  return ids[0];
}

test('#4926 raw partial probe result stays fail-closed for every record', async () => {
  const { provider, probe } = await partialProbe();
  for (const record of [...provider.types().records, ...provider.methods().records]) {
    assert.equal(isLanguageRecordAuthoritative(probe, record), false);
  }
});

test('#4926 matched-authoritative complete model keeps its existing behavior', async () => {
  const provider = makeProvider({ executable: true });
  const probe = await provider.probe();
  assert.equal(probe.identity.verdict, 'matched-authoritative');
  assert.equal(probe.identity.coverage, null);
  assert.equal(probe.completeness.complete, true);
  for (const record of [...provider.types().records, ...provider.methods().records]) {
    assert.equal(isLanguageRecordAuthoritative(probe, record), true);
  }
});

test('#4926 unknown/ambiguous/malformed identities never gain hard authority', async () => {
  const { probe } = await partialProbe();
  const parsedType = createLanguageMetadataRecord({
    kind: 'type',
    entityId: providerEntityOf(probe),
    providerId: 'metadata.objc',
    providerVersion: '1.0.0',
    ecosystem: 'objc',
    buildIdentity: BINARY,
  });
  for (const verdict of ['identity-unavailable', 'identity-mismatch', 'unsupported', 'malformed', 'ambiguous']) {
    const identity = createLanguageMetadataIdentity({
      verdict,
      providerId: 'metadata.objc',
      providerVersion: '1.0.0',
      ecosystem: 'objc',
      method: 'objc-2.0-runtime',
      coverage: { recordKinds: ['type', 'method'], entityIds: [parsedType.entityId] },
    });
    const result = createLanguageMetadataResult({ identity, completeness: { complete: true } });
    assert.equal(isLanguageRecordAuthoritative(result, parsedType), false, `${verdict} must not create hard authority`);
  }
});
