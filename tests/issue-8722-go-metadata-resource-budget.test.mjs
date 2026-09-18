import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GoMetadataProvider,
  parseGoFunctions,
  parsePclntabHeader,
} from '../js/metadata/go.js';

const GO120_MAGIC = 0xfffffff1;
const FUNCTION_COUNT = 50_000;
const FUNCTION_TABLE_OFFSET = 0x400;
const FUNCTION_ENTRY_BYTES = 8;
const FUNCTION_DESCRIPTOR_BYTES = 44;

function writeAscii(bytes, offset, text, terminated = true) {
  for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  if (terminated) bytes[offset + text.length] = 0;
}

function functionName(index, length) {
  const prefix = `pkg.F${index.toString(36)}.`;
  return `${prefix}${'A'.repeat(Math.max(0, length - prefix.length))}`.slice(0, length);
}

/**
 * Make a structurally valid Go 1.20+ table with distinct _func storage.
 * The 44-byte descriptor spacing mirrors the issue's primary counterexample,
 * while the parser only admits the fields it actually reads.
 */
function makePclntab({
  nfunc,
  nameLength = 16,
  nameMode = 'distinct',
  terminated = true,
} = {}) {
  const ftabBytes = nfunc * FUNCTION_ENTRY_BYTES;
  const descriptorStart = FUNCTION_TABLE_OFFSET + ftabBytes;
  const descriptorEnd = descriptorStart + nfunc * FUNCTION_DESCRIPTOR_BYTES;
  const nameTabStart = descriptorEnd + 0x40;
  const nameStride = nameLength + (terminated ? 1 : 0);
  const nameBytes = nameMode === 'shared' ? nameStride : nameMode === 'invalid' ? 1 : nfunc * nameStride;
  const length = nameTabStart + nameBytes;
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  const textStart = 0x400000n;

  view.setUint32(0, GO120_MAGIC, true);
  bytes[4] = 0;
  bytes[5] = 0;
  bytes[6] = 1;
  bytes[7] = 8;
  view.setBigUint64(8, BigInt(nfunc), true);
  view.setBigUint64(16, 0n, true);
  view.setBigUint64(24, textStart, true);
  view.setBigUint64(32, BigInt(nameTabStart), true);
  view.setBigUint64(40, 0x100n, true);
  view.setBigUint64(48, 0x120n, true);
  view.setBigUint64(56, 0x140n, true);
  view.setBigUint64(64, BigInt(FUNCTION_TABLE_OFFSET), true);

  if (nameMode === 'shared') writeAscii(bytes, nameTabStart, 'A'.repeat(nameLength), terminated);

  let nameCursor = nameTabStart;
  for (let i = 0; i < nfunc; i++) {
    const slot = FUNCTION_TABLE_OFFSET + i * FUNCTION_ENTRY_BYTES;
    const funcOffset = ftabBytes + i * FUNCTION_DESCRIPTOR_BYTES;
    const funcPos = FUNCTION_TABLE_OFFSET + funcOffset;
    const entryOffset = i * 0x10;
    const nameOffset = nameMode === 'shared'
      ? 0
      : nameMode === 'invalid'
        ? 0x7fffffff
        : nameCursor - nameTabStart;

    view.setUint32(slot, entryOffset, true);
    view.setUint32(slot + 4, funcOffset, true);
    view.setUint32(funcPos, entryOffset, true);
    view.setInt32(funcPos + 4, nameOffset, true);
    view.setInt32(funcPos + 8, 0, true);
    view.setInt32(funcPos + 12, 0, true);

    if (nameMode === 'distinct') {
      writeAscii(bytes, nameCursor, functionName(i, nameLength), terminated);
      nameCursor += nameStride;
    }
  }

  const header = parsePclntabHeader(bytes);
  assert.equal(header.valid, true, 'fixture must remain a valid Go pclntab');
  return { bytes, header, firstName: functionName(0, nameLength) };
}

const GENEROUS_LIMITS = Object.freeze({
  maxBytesScanned: 16 * 1024 * 1024,
  maxOutputBytes: 16 * 1024 * 1024,
  maxEstimatedHeapBytes: 64 * 1024 * 1024,
});

test('#8722 shared function names are decoded once and remain bounded', () => {
  const fixture = makePclntab({
    nfunc: FUNCTION_COUNT,
    nameLength: 1023,
    nameMode: 'shared',
  });
  const result = parseGoFunctions(fixture.bytes, fixture.header, {
    maxRecords: FUNCTION_COUNT,
    ...GENEROUS_LIMITS,
  });

  assert.equal(result.completeness.complete, true);
  assert.equal(result.functions.length, FUNCTION_COUNT);
  assert.equal(result.functions[0].name.length, 1023);
  assert.equal(result.resourceAccounting.nameDecodes, 1);
  assert.equal(result.resourceAccounting.nameCacheMisses, 1);
  assert.equal(result.resourceAccounting.nameCacheHits, FUNCTION_COUNT - 1);
  assert.ok(result.resourceAccounting.bytesScanned < 4 * 1024 * 1024);
});

test('#8722 shared names cannot publish all records after heap admission stops', () => {
  const fixture = makePclntab({
    nfunc: FUNCTION_COUNT,
    nameLength: 1023,
    nameMode: 'shared',
  });
  const result = parseGoFunctions(fixture.bytes, fixture.header, {
    maxRecords: FUNCTION_COUNT,
    ...GENEROUS_LIMITS,
    maxEstimatedHeapBytes: 4 * 1024 * 1024,
  });

  assert.equal(result.completeness.complete, false);
  assert.ok(result.completeness.parsed < FUNCTION_COUNT);
  assert.equal(result.completeness.capped, true);
  assert.deepEqual(result.completeness.reasons, ['go-metadata-budget-exhausted']);
  assert.equal(result.resourceAccounting.nameDecodes, 1);
  assert.ok(
    result.resourceAccounting.nameCacheHits >= result.completeness.parsed - 1,
    'the admitted records and the budget-rejected next lookup reuse the cached name',
  );
});

test('#8722 public probe keeps the shared-name counterexample partial', () => {
  const fixture = makePclntab({
    nfunc: FUNCTION_COUNT,
    nameLength: 1023,
    nameMode: 'shared',
  });
  const provider = new GoMetadataProvider({
    pclntabBuffer: fixture.bytes,
    binaryIdentity: 'sha256:issue-8722-shared',
  });

  const probe = provider.probe();
  assert.equal(probe.completeness.complete, false);
  assert.ok(probe.completeness.parsed < FUNCTION_COUNT);
  assert.ok(probe.completeness.reasons.includes('go-metadata-budget-exhausted'));
  assert.equal(probe.status.completeness, 'partial');
  assert.equal(probe.status.stopReason, 'budget-exhausted');
  assert.equal(provider.symbols().truncated, true);
});

test('#8722 distinct long names stop on aggregate output/heap budget', () => {
  const fixture = makePclntab({
    nfunc: FUNCTION_COUNT,
    nameLength: 1023,
    nameMode: 'distinct',
  });
  const provider = new GoMetadataProvider({
    pclntabBuffer: fixture.bytes,
    binaryIdentity: 'sha256:issue-8722-distinct',
    options: {
      maxRecords: FUNCTION_COUNT,
      maxBytesScanned: 16 * 1024 * 1024,
      maxOutputBytes: 64 * 1024,
      maxEstimatedHeapBytes: 8 * 1024 * 1024,
    },
  });

  const probe = provider.probe();
  assert.equal(probe.completeness.complete, false);
  assert.ok(probe.completeness.parsed < FUNCTION_COUNT);
  assert.ok(probe.completeness.reasons.includes('go-metadata-budget-exhausted'));
  assert.equal(probe.status.completeness, 'partial');
  assert.equal(probe.status.stopReason, 'budget-exhausted');

  const page = provider.symbols();
  assert.equal(page.records.length, probe.completeness.parsed);
  assert.equal(page.truncated, true);
  assert.equal(page.records[0].name, fixture.firstName);
  assert.equal(page.records[0].address, '0x400000');
});

test('#8722 invalid and unterminated offsets are negatively cached', () => {
  const invalid = makePclntab({ nfunc: 100, nameMode: 'invalid' });
  const invalidResult = parseGoFunctions(invalid.bytes, invalid.header, {
    maxRecords: 100,
    ...GENEROUS_LIMITS,
  });
  assert.equal(invalidResult.functions.length, 0);
  assert.equal(invalidResult.completeness.invalidEntries, 100);
  assert.equal(invalidResult.resourceAccounting.nameCacheMisses, 1);
  assert.equal(invalidResult.resourceAccounting.nameCacheHits, 99);

  const unterminated = makePclntab({
    nfunc: 50,
    nameLength: 1023,
    nameMode: 'shared',
    terminated: false,
  });
  const unterminatedResult = parseGoFunctions(unterminated.bytes, unterminated.header, {
    maxRecords: 50,
    ...GENEROUS_LIMITS,
  });
  assert.equal(unterminatedResult.functions.length, 0);
  assert.equal(unterminatedResult.completeness.invalidEntries, 50);
  assert.equal(unterminatedResult.resourceAccounting.nameCacheMisses, 1);
  assert.equal(unterminatedResult.resourceAccounting.nameCacheHits, 49);
  assert.equal(unterminatedResult.resourceAccounting.nameDecodes, 0);
});

test('#8722 exact byte admission is deterministic at the boundary', () => {
  const fixture = makePclntab({ nfunc: 2, nameLength: 1, nameMode: 'shared' });
  const first = parseGoFunctions(fixture.bytes, fixture.header, {
    maxRecords: 1,
    ...GENEROUS_LIMITS,
  });
  const firstBytes = first.resourceAccounting.bytesScanned;
  assert.ok(Number.isSafeInteger(firstBytes));

  const exact = parseGoFunctions(fixture.bytes, fixture.header, {
    maxRecords: 2,
    ...GENEROUS_LIMITS,
    maxBytesScanned: firstBytes,
  });
  assert.equal(exact.functions.length, 1);
  assert.equal(exact.completeness.complete, false);
  assert.deepEqual(exact.completeness.reasons, ['go-metadata-budget-exhausted']);

  const below = parseGoFunctions(fixture.bytes, fixture.header, {
    maxRecords: 2,
    ...GENEROUS_LIMITS,
    maxBytesScanned: firstBytes - 1,
  });
  assert.equal(below.functions.length, 0);
  assert.equal(below.completeness.complete, false);
  assert.deepEqual(below.completeness.reasons, ['go-metadata-budget-exhausted']);
});
