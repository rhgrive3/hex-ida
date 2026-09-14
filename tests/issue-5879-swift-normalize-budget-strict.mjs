import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSwiftMetadataModel,
  parseSwiftFieldDescriptorScan,
  parseSwiftFieldDescriptor,
  parseSwiftVTable,
  parseSwiftWitnessTable,
  readSwiftMangledName,
} from '../js/swift.js';

function descriptorBytes({ recordSize = 12, count = 0, records = [] } = {}) {
  const header = new Uint8Array(16);
  const view = new DataView(header.buffer);
  view.setUint16(10, recordSize, true);
  view.setUint32(12, count, true);
  return { header, records };
}

const baseOptions = { compilerMetadata: true };

test('#5879 readSwiftMangledName coerces no structured maxBytes into a real budget', async () => {
  const bytes = new TextEncoder().encode('$s1A\0');
  const read = async (_addr, len) => bytes.subarray(0, len);
  const normal = await readSwiftMangledName(read, 0x1000n, { compilerMetadata: true });
  const malformed = await readSwiftMangledName(read, 0x1000n, { compilerMetadata: true, maxBytes: true });
  assert.equal(normal.complete, true);
  assert.deepEqual(malformed, normal, 'non-number maxBytes must fall back to the default budget, not Number(true)=1');
  const arrayMax = await readSwiftMangledName(read, 0x1000n, { compilerMetadata: true, maxBytes: ['4'] });
  assert.deepEqual(arrayMax, normal, 'array maxBytes must not coerce through Number()');
});

test('#5879 valid numeric budgets keep floor/clamp semantics', async () => {
  const bytes = new TextEncoder().encode('$s1A\0');
  const read = async (_addr, len) => bytes.subarray(0, Math.min(len, 2));
  const short = await readSwiftMangledName(read, 0x1000n, { compilerMetadata: true, maxBytes: 2.9 });
  assert.equal(short.complete, false, '2.9 floors to 2, truncating the name before NUL');
});


function putU32(image, offset, value) {
  new DataView(image.buffer).setUint32(offset, value >>> 0, true);
}

function putI32(image, offset, value) {
  new DataView(image.buffer).setInt32(offset, value, true);
}

function imageReader(image) {
  return async (addr, len, allowPartial = false) => {
    const start = Number(BigInt(addr));
    const end = start + len;
    if (!Number.isSafeInteger(start) || start < 0 || start >= image.length) return null;
    if (end > image.length) return allowPartial ? image.subarray(start) : null;
    return image.subarray(start, end);
  };
}

function fieldDescriptorReader(count = 2) {
  const image = new Uint8Array(16 + count * 12);
  new DataView(image.buffer).setUint16(10, 12, true);
  putU32(image, 12, count);
  return imageReader(image);
}

function twoTypeModelFixture() {
  const image = new Uint8Array(512);
  putI32(image, 0, 100); // first __swift5_types relative pointer
  putI32(image, 4, 196); // second pointer -> descriptor @200
  putU32(image, 100, 17); // struct context descriptor
  putI32(image, 108, 192); // name @300
  putI32(image, 116, 0); // no field descriptor
  putU32(image, 120, 0); // numFields
  putU32(image, 124, 0); // fieldOffsetVectorOffset
  putU32(image, 200, 17);
  putI32(image, 208, 112); // name @320
  putI32(image, 216, 0);
  putU32(image, 220, 0);
  putU32(image, 224, 0);
  image.set(new TextEncoder().encode('First\0'), 300);
  image.set(new TextEncoder().encode('Second\0'), 320);
  return {
    read: imageReader(image),
    sections: [{ section: '__swift5_types', vmAddr: 0n, size: 8n }],
  };
}

function twoRequirementProtocolFixture() {
  const image = new Uint8Array(512);
  putI32(image, 0, 100); // __swift5_protos relative pointer
  putU32(image, 100, 3); // protocol context descriptor
  putI32(image, 108, 192); // name @300
  putU32(image, 112, 0); // generic requirements in signature
  putU32(image, 116, 2); // two protocol requirements
  putI32(image, 120, 0);
  putU32(image, 124, 1); // callable requirement kind
  putI32(image, 128, 0);
  putU32(image, 132, 1);
  putI32(image, 136, 0);
  image.set(new TextEncoder().encode('Proto\0'), 300);
  return {
    read: imageReader(image),
    sections: [{ section: '__swift5_protos', vmAddr: 0n, size: 4n }],
  };
}

test('#5879 field-descriptor consumer rejects structured budget coercion', async () => {
  const read = fieldDescriptorReader(2);
  const scan = await parseSwiftFieldDescriptorScan(read, 0n, true);
  assert.equal(scan.fields.length, 2, 'true must fall back to the default field budget, not budget=1');
  assert.equal(scan.completeness.complete, true);
});

test('#5879 protocol-requirement consumer rejects structured budget coercion', async () => {
  const fixture = twoRequirementProtocolFixture();
  const model = await buildSwiftMetadataModel(fixture.read, fixture.sections, { reader: fixture.read, budget: true });
  assert.equal(model.protocols.length, 1);
  assert.equal(model.protocols[0].requirements.length, 2, 'true must not cap protocol requirements to one');
  assert.equal(model.protocols[0].requirementsComplete, true);
});

test('#5879 vtable and witness consumers reject structured count coercion', async () => {
  const read = async (_addr, len) => new Uint8Array(len);
  assert.deepEqual(await parseSwiftVTable(read, 0n, true), [], 'boolean vtable count must use its fallback, not Number(true)');
  assert.deepEqual(await parseSwiftWitnessTable(read, 0n, '2'), [], 'string witness count must use its fallback, not Number("2")');
});

test('#5879 buildSwiftMetadataModel budget keeps all type entries', async () => {
  const fixture = twoTypeModelFixture();
  const model = await buildSwiftMetadataModel(fixture.read, fixture.sections, { reader: fixture.read, budget: true });
  assert.equal(model.types.length, 2, 'structured model budget must not shrink the type scan to one entry');
  assert.deepEqual(model.types.map((type) => type.name), ['First', 'Second']);
});
