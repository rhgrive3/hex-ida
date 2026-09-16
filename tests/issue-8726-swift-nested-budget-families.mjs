/*
 * #8726 — every nested Swift metadata family must consume one parse-wide
 * aggregate allowance. These focused regressions cover the families that the
 * original FieldDescriptor regression did not exercise: protocol requirements,
 * vtable entries, and witness-table entries.
 */
import assert from 'node:assert/strict';
import { buildSwiftMetadataModel } from '../js/swift.js';

function u32LE(v) {
  return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
}
function i32LE(v) { return u32LE(Number(BigInt.asUintN(32, BigInt(v)))); }
function u64LE(v) {
  let value = BigInt(v);
  const out = [];
  for (let i = 0; i < 8; i++) {
    out.push(Number(value & 0xffn));
    value >>= 8n;
  }
  return out;
}
function writeBytes(target, offset, bytes) {
  for (let i = 0; i < bytes.length; i++) target[offset + i] = bytes[i];
}

function memoryImage(size = 0x10000) {
  const BASE = 0x1000n;
  const mem = new Uint8Array(size);
  const off = (address) => Number(BigInt(address) - BASE);
  const read = async (address, length) => {
    const start = BigInt(address), end = start + BigInt(length);
    if (start < BASE || end > BASE + BigInt(size)) return null;
    return mem.subarray(Number(start - BASE), Number(end - BASE));
  };
  return { BASE, mem, off, read };
}

function buildProtocolRequirementsImage(counts = [3, 3]) {
  const image = memoryImage();
  const { BASE, mem, off } = image;
  const sectionAddress = BASE;
  const firstDescriptor = BASE + 0x400n;
  const firstName = BASE + 0x3000n;

  for (let i = 0; i < counts.length; i++) {
    const entryAddress = sectionAddress + BigInt(i * 4);
    const descriptorAddress = firstDescriptor + BigInt(i * 0x100);
    const nameAddress = firstName + BigInt(i * 0x20);
    writeBytes(mem, off(entryAddress), i32LE(descriptorAddress - entryAddress));
    writeBytes(mem, off(nameAddress), new TextEncoder().encode(`P${i}\0`));

    // ProtocolDescriptor prefix: flags(kind=protocol), parent, name,
    // numRequirementsInSignature, numRequirements, associatedTypeNames.
    writeBytes(mem, off(descriptorAddress), u32LE(3));
    writeBytes(mem, off(descriptorAddress + 4n), u32LE(0));
    writeBytes(mem, off(descriptorAddress + 8n), i32LE(nameAddress - (descriptorAddress + 8n)));
    writeBytes(mem, off(descriptorAddress + 12n), u32LE(0));
    writeBytes(mem, off(descriptorAddress + 16n), u32LE(counts[i]));
    writeBytes(mem, off(descriptorAddress + 20n), u32LE(0));

    for (let k = 0; k < counts[i]; k++) {
      const requirementAddress = descriptorAddress + 24n + BigInt(k * 8);
      // Kind 1 is a callable protocol requirement; a zero default
      // implementation is valid and keeps this fixture focused on budgeting.
      writeBytes(mem, off(requirementAddress), u32LE(1));
      writeBytes(mem, off(requirementAddress + 4n), i32LE(0));
    }
  }

  return {
    ...image,
    sections: [{
      section: '__swift5_protos',
      vmAddr: sectionAddress,
      size: BigInt(counts.length * 4),
    }],
  };
}

function buildTwoVTableImage() {
  const image = memoryImage();
  const { BASE, mem, off } = image;
  const addresses = [BASE + 0x1000n, BASE + 0x2000n];
  for (const address of addresses) {
    for (let i = 0; i < 3; i++) {
      const entry = address + BigInt(i * 8);
      writeBytes(mem, off(entry), u32LE(1));
      writeBytes(mem, off(entry + 4n), i32LE(0));
    }
  }
  return { ...image, addresses };
}

function buildTwoWitnessTableImage() {
  const image = memoryImage();
  const { BASE, mem, off } = image;
  const addresses = [BASE + 0x1000n, BASE + 0x2000n];
  for (let table = 0; table < addresses.length; table++) {
    for (let i = 0; i < 3; i++) {
      const entry = addresses[table] + BigInt(i * 8);
      writeBytes(mem, off(entry), u64LE(0x5000n + BigInt(table * 0x100 + i * 8)));
    }
  }
  return { ...image, addresses };
}

const cases = [];
const expect = (name, fn) => cases.push([name, fn]);

expect('protocol requirements consume one parse-wide aggregate allowance', async () => {
  const { read, sections } = buildProtocolRequirementsImage([3, 3]);

  const exhausted = await buildSwiftMetadataModel(read, sections, {
    reader: read,
    budget: 4,
  });
  assert.equal(exhausted.protocols.length, 2);
  assert.equal(exhausted.protocols[0].requirements.length, 3,
    'the first protocol consumes three nested rows');
  assert.equal(exhausted.protocols[0].requirementsComplete, true);
  assert.equal(exhausted.protocols[1].requirements.length, 0,
    'the second protocol must not receive a fresh independent allowance');
  assert.equal(exhausted.protocols[1].requirementsComplete, false);
  assert.equal(exhausted.completeness.protocols.complete, false);
  assert.equal(exhausted.complete, false,
    'protocol nested exhaustion propagates to whole-model completeness');
  assert.ok(exhausted.warnings.some((warning) => warning.includes('nested-record-budget-exhausted')),
    'protocol exhaustion keeps the deterministic nested-budget reason');

  const admitted = await buildSwiftMetadataModel(read, sections, {
    reader: read,
    budget: 6,
  });
  assert.deepEqual(admitted.protocols.map((protocol) => protocol.requirements.length), [3, 3]);
  assert.ok(admitted.protocols.every((protocol) => protocol.requirementsComplete === true));
  assert.equal(admitted.completeness.protocols.complete, true,
    'the exact aggregate allowance admits both normal protocol scans losslessly');
});

expect('vtable entries do not get a fresh allowance per vtable seed', async () => {
  const { read, addresses } = buildTwoVTableImage();
  const seeds = addresses.map((address) => ({ address, count: 3 }));

  const exhausted = await buildSwiftMetadataModel(read, [], {
    reader: read,
    budget: 4,
    vtables: seeds,
  });
  assert.equal(exhausted.vtables.length, 2);
  assert.equal(exhausted.vtables[0].methods.length, 3,
    'the first vtable consumes three nested rows');
  assert.equal(exhausted.vtables[1].methods.length, 0,
    'the second vtable must fail closed instead of receiving a fresh allowance');
  assert.equal(exhausted.completeness.vtables.complete, false);
  assert.equal(exhausted.complete, false,
    'vtable nested exhaustion propagates to whole-model completeness');

  const admitted = await buildSwiftMetadataModel(read, [], {
    reader: read,
    budget: 6,
    vtables: seeds,
  });
  assert.deepEqual(admitted.vtables.map((vtable) => vtable.methods.length), [3, 3]);
  assert.equal(admitted.completeness.vtables.complete, true,
    'the exact aggregate allowance admits both normal vtable scans losslessly');
});

expect('witness-table entries do not get a fresh allowance per witness seed', async () => {
  const { read, addresses } = buildTwoWitnessTableImage();
  const seeds = addresses.map((address) => ({ address, count: 3 }));

  const exhausted = await buildSwiftMetadataModel(read, [], {
    reader: read,
    budget: 4,
    allowRawPointers: true,
    witnessTables: seeds,
  });
  assert.equal(exhausted.witnessTables.length, 2);
  assert.equal(exhausted.witnessTables[0].entries.length, 3,
    'the first witness table consumes three nested rows');
  assert.ok(exhausted.witnessTables[0].entries.every((entry) => entry.resolved === true));
  assert.equal(exhausted.witnessTables[1].entries.length, 0,
    'the second witness table must fail closed instead of receiving a fresh allowance');
  assert.equal(exhausted.completeness.witnessTables.complete, false);
  assert.equal(exhausted.complete, false,
    'witness nested exhaustion propagates to whole-model completeness');

  const admitted = await buildSwiftMetadataModel(read, [], {
    reader: read,
    budget: 6,
    allowRawPointers: true,
    witnessTables: seeds,
  });
  assert.deepEqual(admitted.witnessTables.map((table) => table.entries.length), [3, 3]);
  assert.ok(admitted.witnessTables.flatMap((table) => table.entries)
    .every((entry) => entry.resolved === true));
  assert.equal(admitted.completeness.witnessTables.complete, true,
    'the exact aggregate allowance admits both normal witness scans losslessly');
});

let failed = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}
if (failed) {
  console.error(`${failed} of ${cases.length} failed`);
  process.exit(1);
}
console.log(`issue-8726 swift nested family budgets: ${cases.length} cases ok`);
