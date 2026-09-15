/*
 * #8726 — Swift metadata nested scans must share one aggregate allowance and
 * cache the same descriptor. Nominal types aliasing one FieldDescriptor used to
 * re-read, re-decode and re-retain its full record set once per type, so
 * `budget` multiplied against `Math.min(budget,4096)` and a 159 KiB metadata
 * image could OOM a 256 MiB heap. This test pins the shared-descriptor cache,
 * the parse-wide aggregate charge, the deterministic exhaustion reason and the
 * unchanged lossless behavior for distinct descriptors up to the budget.
 */
import assert from 'node:assert/strict';
import { buildSwiftMetadataModel, parseSwiftFieldDescriptorScan } from '../js/swift.js';

function u32LE(v) { return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; }
function i32LE(v) { return u32LE(Number(BigInt.asUintN(32, BigInt(v)))); }
function u16LE(v) { return [v & 255, (v >>> 8) & 255]; }
function u64LE(v) {
  let n = BigInt(v);
  const out = [];
  for (let i = 0; i < 8; i++) { out.push(Number(n & 0xffn)); n >>= 8n; }
  return out;
}

function writeBytes(target, offset, bytes) {
  for (let i = 0; i < bytes.length; i++) target[offset + i] = bytes[i];
}

// Struct-shaped image: `typeCount` struct context descriptors in __swift5_types,
// every one of which has fieldDescriptor pointing to the SAME shared
// FieldDescriptor at fdAddress. Descriptor is a 16-byte header (recordSize +
// count) followed by `recordCount` twelve-byte FieldRecords. Each record's
// relative name reference resolves to a valid ASCII "f\0" so the parser stays
// on the well-formed path; type references are zero so mangled-name parsing is
// skipped.
function buildSharedFieldImage({ typeCount, fdAddress, recordCount }) {
  const SIZE = 0x20000;
  const mem = new Uint8Array(SIZE);
  const BASE = 0x1000n;
  const off = (a) => Number(BigInt(a) - BASE);

  const typesSectionAddr = BASE;
  const firstDescAddr = BASE + 0x800n;
  const nameAddr = BASE + 0x2000n;
  const fdAddr = BASE + BigInt(fdAddress);
  const nameBytes = new TextEncoder().encode('T\0');
  writeBytes(mem, off(nameAddr), nameBytes);

  for (let i = 0; i < typeCount; i++) {
    const entryAddr = typesSectionAddr + BigInt(i * 4);
    const descAddr = firstDescAddr + BigInt(i * 0x40);
    writeBytes(mem, off(entryAddr), i32LE(descAddr - entryAddr));
    // StructDescriptor prefix (20 bytes): flags (kind=struct=0x200 | kind=2),
    // parent (0), name (rel -> nameAddr), metadataAccessor (0), fieldDescriptor
    // (rel -> fdAddr).
    writeBytes(mem, off(descAddr), u32LE(17));
    writeBytes(mem, off(descAddr + 4n), u32LE(0));
    writeBytes(mem, off(descAddr + 8n), i32LE(nameAddr - (descAddr + 8n)));
    writeBytes(mem, off(descAddr + 12n), u32LE(0));
    writeBytes(mem, off(descAddr + 16n), i32LE(fdAddr - (descAddr + 16n)));
    // StructDescriptor tail (8 bytes): numFields, fieldOffsetVectorOffset.
    writeBytes(mem, off(descAddr + 20n), u32LE(recordCount));
    writeBytes(mem, off(descAddr + 24n), u32LE(0));
  }

  // Shared FieldDescriptor: 16-byte header (recordSize @10, count @12), then
  // `recordCount` twelve-byte records. Every record's name reference resolves
  // to a shared valid 'f\0' string at fdAddr + 0x1000.
  writeBytes(mem, off(fdAddr), new Array(10).fill(0));
  writeBytes(mem, off(fdAddr) + 10, u16LE(12));
  writeBytes(mem, off(fdAddr) + 12, u32LE(recordCount));
  const fieldStringRef = fdAddr + 0x1000n;
  writeBytes(mem, off(fieldStringRef), new TextEncoder().encode('f\0'));
  for (let i = 0; i < recordCount; i++) {
    const recordAddr = fdAddr + 16n + BigInt(i * 12);
    writeBytes(mem, off(recordAddr), u32LE(0));
    writeBytes(mem, off(recordAddr + 4n), i32LE(0));
    writeBytes(mem, off(recordAddr + 8n), i32LE(fieldStringRef - (recordAddr + 8n)));
  }

  const readHeaderCount = { value: 0 };
  const read = async (addr, len) => {
    const start = BigInt(addr), end = start + BigInt(len);
    if (start === fdAddr && len === 16) readHeaderCount.value++;
    if (start < BASE || end > BASE + BigInt(SIZE)) return null;
    return mem.subarray(Number(start - BASE), Number(end - BASE));
  };
  return { read, sections: [{ section: '__swift5_types', vmAddr: typesSectionAddr, size: BigInt(typeCount * 4) }], fdAddr, readHeaderCount };
}

// Minimal protocol/vtable/witness image used to prove that all nested families
// consume the SAME parse-wide allowance, rather than each getting a fresh cap.
function buildNestedFamilyImage({ protocolCount = 1, requirementsPerProtocol = 3 } = {}) {
  const SIZE = 0x8000;
  const mem = new Uint8Array(SIZE);
  const BASE = 0x1000n;
  const off = (a) => Number(BigInt(a) - BASE);
  const protoSectionAddr = BASE;
  const firstProtoAddr = BASE + 0x400n;
  const vtableAddr = BASE + 0x3000n;
  const witnessAddr = BASE + 0x3200n;

  for (let i = 0; i < protocolCount; i++) {
    const entryAddr = protoSectionAddr + BigInt(i * 4);
    const protoAddr = firstProtoAddr + BigInt(i * 0x100);
    const nameAddr = BASE + 0x2000n + BigInt(i * 0x20);
    writeBytes(mem, off(entryAddr), i32LE(protoAddr - entryAddr));
    writeBytes(mem, off(protoAddr), u32LE(3)); // ContextDescriptorKind::Protocol
    writeBytes(mem, off(protoAddr + 4n), u32LE(0));
    writeBytes(mem, off(protoAddr + 8n), i32LE(nameAddr - (protoAddr + 8n)));
    writeBytes(mem, off(protoAddr + 12n), u32LE(0)); // signature requirements
    writeBytes(mem, off(protoAddr + 16n), u32LE(requirementsPerProtocol));
    writeBytes(mem, off(protoAddr + 20n), u32LE(0));
    writeBytes(mem, off(nameAddr), new TextEncoder().encode(`P${i}\0`));
    for (let k = 0; k < requirementsPerProtocol; k++) {
      const reqAddr = protoAddr + 24n + BigInt(k * 8);
      writeBytes(mem, off(reqAddr), u32LE(1)); // callable method requirement
      writeBytes(mem, off(reqAddr + 4n), i32LE(0));
    }
  }

  for (let i = 0; i < 4; i++) {
    const row = vtableAddr + BigInt(i * 8);
    writeBytes(mem, off(row), u32LE(0));
    writeBytes(mem, off(row + 4n), i32LE(0));
    writeBytes(mem, off(witnessAddr + BigInt(i * 8)), u64LE(0x5000n + BigInt(i * 8)));
  }

  const read = async (addr, len) => {
    const start = BigInt(addr), end = start + BigInt(len);
    if (start < BASE || end > BASE + BigInt(SIZE)) return null;
    return mem.subarray(Number(start - BASE), Number(end - BASE));
  };
  return {
    read,
    sections: [{ section: '__swift5_protos', vmAddr: protoSectionAddr, size: BigInt(protocolCount * 4) }],
    vtableAddr,
    witnessAddr,
  };
}

const cases = [];
const expect = (name, fn) => cases.push([name, fn]);

expect('shared FieldDescriptor is scanned once, not per aliasing type', async () => {
  const { read, sections, readHeaderCount } = buildSharedFieldImage({
    typeCount: 64, fdAddress: 0x8000, recordCount: 40,
  });
  const model = await buildSwiftMetadataModel(read, sections, { reader: read, budget: 20000 });
  assert.equal(model.types.length, 64, 'every aliasing type still resolves');
  assert.equal(readHeaderCount.value, 1,
    'the shared descriptor header must be physically read exactly once');
  const first = model.types[0].fields;
  assert.equal(first.length, 40, 'cached row array length preserved');
  for (const t of model.types.slice(1)) {
    assert.equal(t.fields, first, 'aliasing owners share the SAME immutable array reference');
  }
  assert.ok(Object.isFrozen(first), 'shared rows are frozen');
  assert.ok(Object.isFrozen(first[0]), 'individual rows are frozen');
  assert.equal(model.complete, true, 'shared-descriptor reuse is not an incompleteness signal');
});

expect('aggregate nested budget exhausts fail-closed with a deterministic reason', async () => {
  // Build an image with 20 struct types whose FieldDescriptors are 40 rows
  // each: 800 total. Cap the model budget to 400 so exhaustion is triggered
  // mid-parse. The first ten scans fit (400 records); every scan thereafter
  // must be a fail-closed empty result with the aggregate reason, and the
  // model-level completeness must reflect that.
  const mem = new Uint8Array(0x20000);
  const BASE = 0x1000n;
  const off = (a) => Number(BigInt(a) - BASE);
  const typesSectionAddr = BASE;
  const firstDescAddr = BASE + 0x800n;
  const nameAddr = BASE + 0x2000n;
  const firstFdAddr = BASE + 0x4000n;
  const fdStride = 0x800n;
  const recordCount = 40;
  const typeCount = 20;
  writeBytes(mem, off(nameAddr), new TextEncoder().encode('T\0'));
  for (let i = 0; i < typeCount; i++) {
    const entryAddr = typesSectionAddr + BigInt(i * 4);
    const descAddr = firstDescAddr + BigInt(i * 0x40);
    const fdAddr = firstFdAddr + fdStride * BigInt(i);
    writeBytes(mem, off(entryAddr), i32LE(descAddr - entryAddr));
    writeBytes(mem, off(descAddr), u32LE(17));
    writeBytes(mem, off(descAddr + 8n), i32LE(nameAddr - (descAddr + 8n)));
    writeBytes(mem, off(descAddr + 16n), i32LE(fdAddr - (descAddr + 16n)));
    writeBytes(mem, off(descAddr + 20n), u32LE(recordCount));
    writeBytes(mem, off(fdAddr) + 10, u16LE(12));
    writeBytes(mem, off(fdAddr) + 12, u32LE(recordCount));
    const fieldStringRef = fdAddr + 0x400n;
    writeBytes(mem, off(fieldStringRef), new TextEncoder().encode('f\0'));
    for (let k = 0; k < recordCount; k++) {
      const recordAddr = fdAddr + 16n + BigInt(k * 12);
      writeBytes(mem, off(recordAddr + 8n), i32LE(fieldStringRef - (recordAddr + 8n)));
    }
  }
  const read = async (addr, len) => {
    const start = BigInt(addr), end = start + BigInt(len);
    if (start < BASE || end > BASE + BigInt(0x20000)) return null;
    return mem.subarray(Number(start - BASE), Number(end - BASE));
  };
  const model = await buildSwiftMetadataModel(read,
    [{ section: '__swift5_types', vmAddr: typesSectionAddr, size: BigInt(typeCount * 4) }],
    { reader: read, budget: 400 });
  const incomplete = model.types.filter((t) => t.fields.length === 0);
  const complete = model.types.filter((t) => t.fields.length > 0);
  assert.ok(complete.length >= 8 && complete.length <= 12,
    `aggregate charge must stop after ~10 distinct scans, got ${complete.length}`);
  assert.ok(incomplete.length >= typeCount - complete.length);
  assert.ok(model.warnings.some((w) => w.includes('nested-record-budget-exhausted')),
    'exhaustion is reported with the deterministic budget reason');
  assert.equal(model.complete, false, 'aggregate exhaustion propagates to model completeness');
});

expect('distinct normal descriptors still parse losslessly up to the aggregate budget', async () => {
  // 8 types × 50 rows = 400 records under a 20,000 aggregate budget. Every
  // type must keep a full 50-row array (independent, not shared).
  const { read, sections } = (() => {
    const mem = new Uint8Array(0x20000);
    const BASE = 0x1000n;
    const off = (a) => Number(BigInt(a) - BASE);
    const firstDesc = BASE + 0x800n, nameAddr = BASE + 0x2000n, firstFd = BASE + 0x4000n;
    writeBytes(mem, off(nameAddr), new TextEncoder().encode('T\0'));
    for (let i = 0; i < 8; i++) {
      const entryAddr = BASE + BigInt(i * 4);
      const descAddr = firstDesc + BigInt(i * 0x40);
      const fdAddr = firstFd + 0x800n * BigInt(i);
      writeBytes(mem, off(entryAddr), i32LE(descAddr - entryAddr));
      writeBytes(mem, off(descAddr), u32LE(17));
      writeBytes(mem, off(descAddr + 8n), i32LE(nameAddr - (descAddr + 8n)));
      writeBytes(mem, off(descAddr + 16n), i32LE(fdAddr - (descAddr + 16n)));
      writeBytes(mem, off(descAddr + 20n), u32LE(50));
      writeBytes(mem, off(fdAddr) + 10, u16LE(12));
      writeBytes(mem, off(fdAddr) + 12, u32LE(50));
      const fieldStringRef = fdAddr + 0x400n;
      writeBytes(mem, off(fieldStringRef), new TextEncoder().encode('f\0'));
      for (let k = 0; k < 50; k++) {
        const recordAddr = fdAddr + 16n + BigInt(k * 12);
        writeBytes(mem, off(recordAddr + 8n), i32LE(fieldStringRef - (recordAddr + 8n)));
      }
    }
    const read = async (addr, len) => {
      const start = BigInt(addr), end = start + BigInt(len);
      if (start < BASE || end > BASE + BigInt(0x20000)) return null;
      return mem.subarray(Number(start - BASE), Number(end - BASE));
    };
    return { read, sections: [{ section: '__swift5_types', vmAddr: BASE, size: 8n * 4n }] };
  })();
  const model = await buildSwiftMetadataModel(read, sections, { reader: read, budget: 20000 });
  assert.equal(model.types.length, 8);
  for (const t of model.types) assert.equal(t.fields.length, 50);
  // Distinct descriptors => distinct arrays (not shared identity).
  assert.notEqual(model.types[0].fields, model.types[1].fields);
  assert.equal(model.complete, true);
});

expect('protocol requirements share the same aggregate nested allowance', async () => {
  const { read, sections } = buildNestedFamilyImage({ protocolCount: 2, requirementsPerProtocol: 3 });
  const model = await buildSwiftMetadataModel(read, sections, { reader: read, budget: 4 });
  assert.equal(model.protocols.length, 2);
  assert.equal(model.protocols[0].requirements.length, 3, 'first protocol consumes three nested rows');
  assert.equal(model.protocols[0].requirementsComplete, true);
  assert.equal(model.protocols[1].requirements.length, 0, 'second protocol is refused instead of receiving a fresh allowance');
  assert.equal(model.protocols[1].requirementsComplete, false);
  assert.ok(model.warnings.some((w) => w.includes('nested-record-budget-exhausted')),
    'protocol exhaustion reports the aggregate reason');
  assert.equal(model.completeness.protocols.complete, false);
  assert.equal(model.complete, false);
});

expect('vtable rows consume the protocol-shared aggregate allowance', async () => {
  const { read, sections, vtableAddr } = buildNestedFamilyImage({ protocolCount: 1, requirementsPerProtocol: 3 });
  const model = await buildSwiftMetadataModel(read, sections, {
    reader: read,
    budget: 4,
    vtables: [{ address: vtableAddr, count: 2 }],
  });
  assert.equal(model.protocols[0].requirements.length, 3);
  assert.equal(model.vtables.length, 1);
  assert.equal(model.vtables[0].methods.length, 0,
    'vtable scan must fail before materializing rows once the shared cap would be exceeded');
  assert.equal(model.completeness.vtables.complete, false);
  assert.equal(model.complete, false);
});

expect('witness rows consume the protocol-shared aggregate allowance', async () => {
  const { read, sections, witnessAddr } = buildNestedFamilyImage({ protocolCount: 1, requirementsPerProtocol: 3 });
  const model = await buildSwiftMetadataModel(read, sections, {
    reader: read,
    budget: 4,
    pointerBytes: 8,
    allowRawPointers: true,
    witnessTables: [{ address: witnessAddr, count: 2 }],
  });
  assert.equal(model.protocols[0].requirements.length, 3);
  assert.equal(model.witnessTables.length, 1);
  assert.equal(model.witnessTables[0].entries.length, 0,
    'witness scan must fail before materializing rows once the shared cap would be exceeded');
  assert.equal(model.completeness.witnessTables.complete, false);
  assert.equal(model.complete, false);
});

expect('standalone parseSwiftFieldDescriptorScan keeps legacy semantics without a nested state', async () => {
  // The legacy helper signature is unchanged: without parseNested, the scan
  // must return the previous array of fresh objects each call (no cache).
  const { read } = buildSharedFieldImage({ typeCount: 1, fdAddress: 0x8000, recordCount: 4 });
  const a = await parseSwiftFieldDescriptorScan(read, 0x9000n, 4096);
  const b = await parseSwiftFieldDescriptorScan(read, 0x9000n, 4096);
  assert.notEqual(a.fields, b.fields, 'without a parseState there is no cross-call cache');
  assert.equal(a.completeness.complete, true);
  assert.equal(b.completeness.complete, true);
  assert.equal(a.fields.length, 4);
});

let failed = 0;
for (const [name, fn] of cases) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (err) { failed++; console.log(`FAIL ${name}: ${err.message}`); }
}
if (failed) { console.error(`${failed} of ${cases.length} failed`); process.exit(1); }
console.log(`issue-8726 swift nested budget: ${cases.length} cases ok`);
