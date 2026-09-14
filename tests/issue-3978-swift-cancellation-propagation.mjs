// Regression for #3978: js/swift.js caught every parser/resolver failure with
// a broad catch, laundering provider-thrown cancellation (AbortError) into
// `invalidEntries++` / unresolved-pointer results. A cancelled nested
// descriptor read must propagate as cancellation, must not be counted as a
// malformed entry, and must stop further entry/section scanning, while
// ordinary malformed entries keep their fail-soft contract (#3808 precedent).
import assert from 'node:assert/strict';
import {
  buildSwiftMetadataModel,
  parseSwiftWitnessTable,
  parseSwiftConformanceDescriptor,
} from '../js/swift.js';

function abortError() {
  const error = new Error('provider aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function le32(value) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, value >>> 0, true);
  return b;
}

// A __swift5_types section holding two entries: entry 0 points at descriptor
// 0x3000 whose read throws AbortError, entry 1 at 0x4000.
const TYPE_SECTION = [{ name: '__swift5_types', addr: 0x2000n, size: 8n }];
const DESCRIPTOR_A = 0x3000n;
const TYPE_FIELD_B = 0x2004n;

async function scanTypeSection({ descriptorRead, malformed = false }) {
  const reads = [];
  const read = async (address, length) => {
    const at = BigInt(address);
    reads.push(at);
    if (at === 0x2000n) return le32(Number(DESCRIPTOR_A - 0x2000n));
    if (at === TYPE_FIELD_B) return le32(malformed ? 0 : 0x2000);
    if (at === DESCRIPTOR_A) return descriptorRead(at, length);
    return new Uint8Array(length);
  };
  return { reads, model: buildSwiftMetadataModel(read, TYPE_SECTION, { reader: read, budget: 100 }) };
}

// 1. Provider AbortError from a nested descriptor read propagates and stops
//    scanning before the next entry (#3978 acceptance 1, 5).
{
  const { reads, model } = await scanTypeSection({
    descriptorRead: () => { throw abortError(); },
  });
  await assert.rejects(model, (error) => error?.name === 'AbortError',
    'descriptor provider AbortError must propagate, not become invalidEntries');
  assert.ok(!reads.includes(TYPE_FIELD_B), 'no further entry reads after cancellation');
}

// 2. Non-cancellation parser failures stay fail-soft malformed entries.
{
  const { model } = await scanTypeSection({
    descriptorRead: () => { throw new Error('malformed descriptor'); },
  });
  const built = await model;
  assert.equal(built.types.length, 0);
  assert.equal(built.completeness.types.invalidEntries >= 1, true,
    'ordinary parser errors must still count as invalid entries');
}

// 3. Pre-aborted signal and provider-thrown cancellation must not launder
//    into invalid-entry diagnostics (acceptance 4).
{
  const controller = new AbortController();
  controller.abort();
  let descriptorReads = 0;
  const read = async (address, length) => {
    if (BigInt(address) === DESCRIPTOR_A) descriptorReads++;
    return new Uint8Array(length);
  };
  const model = await buildSwiftMetadataModel(read, TYPE_SECTION, {
    reader: read, budget: 100, signal: controller.signal,
  });
  assert.equal(model, null, 'a cancelled model is never produced as a normal partial artifact');
  assert.equal(descriptorReads, 0, 'pre-aborted parsing must not scan descriptor bodies');
}

// 4. Pointer resolver AbortError must not become an unresolved pointer
//    (acceptance 2). Witness table resolver first.
{
  let calls = 0;
  const read = async (address, length) => {
    const b = new Uint8Array(Math.max(length, 8));
    new DataView(b.buffer).setBigUint64(0, 0x8000n, true);
    return b.subarray(0, length);
  };
  await assert.rejects(
    parseSwiftWitnessTable(read, 0x5000n, 2, 2, {
      architecture: 'arm64',
      resolvePointer: () => { calls++; throw abortError(); },
    }),
    (error) => error?.name === 'AbortError',
    'witness-table resolver AbortError must propagate',
  );
  assert.equal(calls, 1, 'no further witness entries after cancellation');
}

// 5. Absolute-pointer resolver path (conformance type reference).
{
  const read = async (address, length) => {
    const at = BigInt(address);
    if (at === 0x6000n) {
      const b = new Uint8Array(16);
      const dv = new DataView(b.buffer);
      dv.setInt32(0, 4, true);            // protocol: indirectable relative
      dv.setInt32(4, -16, true);          // type ref (raw relative)
      dv.setInt32(8, 0, true);            // witness table
      dv.setUint32(12, (1 & 7) << 3, true); // typeReferenceKind = 1 (absolute)
      return b.subarray(0, length);
    }
    const b = new Uint8Array(Math.max(length, 8));
    new DataView(b.buffer).setBigUint64(0, 0x9000n, true);
    return b.subarray(0, length);
  };
  let resolverCalls = 0;
  await assert.rejects(
    parseSwiftConformanceDescriptor(read, 0x6000n, {
      architecture: 'arm64',
      resolvePointer: () => { resolverCalls++; throw abortError(); },
    }),
    (error) => error?.name === 'AbortError',
    'absolute-pointer resolver AbortError must propagate',
  );
  assert.equal(resolverCalls, 1);
}

// 6. Malformed (non-cancel) resolver errors keep returning unresolved.
{
  const read = async (address, length) => {
    const b = new Uint8Array(Math.max(length, 8));
    new DataView(b.buffer).setBigUint64(0, 0x8000n, true);
    return b.subarray(0, length);
  };
  const entries = await parseSwiftWitnessTable(read, 0x5000n, 1, 1, {
    architecture: 'arm64',
    resolvePointer: () => { throw new Error('pointer not mapped'); },
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].resolved, false);
}

console.log('issue #3978 Swift metadata cancellation propagation regression passed');
