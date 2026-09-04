import test from 'node:test';
import assert from 'node:assert/strict';
import { buildObjcRuntimeModel } from '../../../js/objc.js';

const CLASS_LIST = 0x1000n;
const CLASS = 0x2000n;
const CLASS_RO = 0x3000n;
const CLASS_NAME = 0x4000n;
const CLASS_METHODS = 0x5000n;
const CLASS_SELECTOR = 0x6000n;
const CLASS_IMP = 0x7000n;
const CATEGORY_LIST = 0x8000n;
const CATEGORY = 0x8100n;
const CATEGORY_NAME = 0x8200n;
const CATEGORY_METHODS = 0x8300n;
const CATEGORY_SELECTOR = 0x8400n;
const CATEGORY_IMP = 0x7100n;

function fixture({ classMethod = false, categoryMethod = false } = {}) {
  const memory = new Uint8Array(0x10000);
  const view = new DataView(memory.buffer);
  const u32 = (address, value) => view.setUint32(Number(address), value, true);
  const u64 = (address, value) => view.setBigUint64(Number(address), BigInt(value), true);
  const cstring = (address, value) => {
    memory.set(new TextEncoder().encode(value), Number(address));
    memory[Number(address) + value.length] = 0;
  };

  u64(CLASS_LIST, CLASS);
  u64(CLASS + 32n, CLASS_RO);
  u32(CLASS_RO + 8n, 32);
  u64(CLASS_RO + 24n, CLASS_NAME);
  if (classMethod) u64(CLASS_RO + 32n, CLASS_METHODS);
  cstring(CLASS_NAME, 'Victim');

  if (classMethod) {
    u32(CLASS_METHODS, 24);
    u32(CLASS_METHODS + 4n, 1);
    u64(CLASS_METHODS + 8n, CLASS_SELECTOR);
    u64(CLASS_METHODS + 16n, 0n);
    u64(CLASS_METHODS + 24n, CLASS_IMP);
    cstring(CLASS_SELECTOR, 'legacyEvil');
  }

  const sections = { architecture: 'arm64', executableRanges: [] };
  if (categoryMethod) {
    sections.categoryList = { vmAddr: CATEGORY_LIST, size: 8n };
    u64(CATEGORY_LIST, CATEGORY);
    u64(CATEGORY, CATEGORY_NAME);
    u64(CATEGORY + 8n, CLASS);
    u64(CATEGORY + 16n, CATEGORY_METHODS);
    cstring(CATEGORY_NAME, 'Injected');
    u32(CATEGORY_METHODS, 24);
    u32(CATEGORY_METHODS + 4n, 1);
    u64(CATEGORY_METHODS + 8n, CATEGORY_SELECTOR);
    u64(CATEGORY_METHODS + 16n, 0n);
    u64(CATEGORY_METHODS + 24n, CATEGORY_IMP);
    cstring(CATEGORY_SELECTOR, 'categoryEvil');
  }

  const read = async (address, length) => {
    const start = Number(address);
    if (!Number.isSafeInteger(start) || start < 0 || length < 0 || start >= memory.length) return null;
    return memory.subarray(start, Math.min(memory.length, start + length));
  };

  return {
    read,
    classList: { vmAddr: CLASS_LIST, size: 8n },
    sections,
  };
}

const maliciousOptions = {
  requireImplementationProof: false,
  validateImplementation: () => ({ ok: true }),
};

test('caller options cannot disable legacy Objective-C implementation proof', async () => {
  const input = fixture({ classMethod: true });
  const model = await buildObjcRuntimeModel(
    input.read,
    input.classList,
    input.sections,
    null,
    0n,
    null,
    maliciousOptions,
  );

  assert.equal(model.implementationProofRequired, true);
  assert.equal(model.classes.length, 1);
  assert.equal(model.classes[0].methods.length, 1);
  assert.equal(model.classes[0].methods[0].implementationProven, false);
  assert.equal(model.classes[0].methods[0].implementationValidationReason, 'method-imp-not-executable');
  assert.deepEqual(model.names, []);
});

test('caller options cannot disable extended Objective-C implementation proof', async () => {
  const input = fixture({ categoryMethod: true });
  const model = await buildObjcRuntimeModel(
    input.read,
    input.classList,
    input.sections,
    null,
    0n,
    null,
    maliciousOptions,
  );

  assert.equal(model.categories.length, 1);
  assert.equal(model.categories[0].instanceMethods.length, 1);
  assert.equal(model.categories[0].instanceMethods[0].implementationProven, false);
  assert.equal(model.categories[0].instanceMethods[0].implementationValidationReason, 'method-imp-not-executable');
  assert.deepEqual(model.names, []);
});

test('canonical executable proof remains accepted for legacy and extended methods', async () => {
  const input = fixture({ classMethod: true, categoryMethod: true });
  input.sections.executableRanges = [{ vmAddr: CLASS_IMP, size: 0x200n }];
  const model = await buildObjcRuntimeModel(
    input.read,
    input.classList,
    input.sections,
    null,
    0n,
    null,
    maliciousOptions,
  );

  assert.equal(model.classes[0].methods[0].implementationProven, true);
  assert.equal(model.categories[0].instanceMethods[0].implementationProven, true);
  assert.deepEqual(model.names.map((entry) => entry.addr), [CLASS_IMP, CATEGORY_IMP]);
});
