import assert from 'node:assert/strict';
import test from 'node:test';
import { parseObjcExtendedMetadata } from '../js/apple/objc-metadata.js';
import { buildObjcRuntimeIndex, resolveObjcDispatch } from '../js/apple/objc-runtime.js';

const CATLIST = 0x1000n;
const CAT = 0x2000n;
const CAT_NAME = 0x3000n;
const CLASS_POINTER = 0x4000n;
const INSTANCE_METHODS = 0x5000n;
const CLASS_METHODS = 0x5400n;
const INSTANCE_SELECTOR = 0x6000n;
const INSTANCE_TYPES = 0x6100n;
const CLASS_SELECTOR = 0x6200n;
const CLASS_TYPES = 0x6300n;
const INSTANCE_IMP = 0x7000n;
const CLASS_IMP = 0x7100n;
const PROTOCOL_REFS = 0x7400n;
const PROTOCOL = 0x7500n;
const PROTOCOL_NAME = 0x7600n;
const EXTERNAL_RAW = 0xdeadbeefn;
const CLASS_STORAGE = CAT + 8n;

function buildFixture({ local = false, rawClassPointer = local ? CLASS_POINTER : EXTERNAL_RAW, withProtocol = true } = {}) {
  const mem = new Uint8Array(0x10000);
  const view = new DataView(mem.buffer);
  const setU64 = (address, value) => view.setBigUint64(Number(address), BigInt(value), true);
  const setU32 = (address, value) => view.setUint32(Number(address), Number(value), true);
  const setString = (address, value) => mem.set(new TextEncoder().encode(`${value}\0`), Number(address));
  const setMethodList = (address, selector, types, implementation) => {
    setU32(address, 24);
    setU32(address + 4n, 1);
    setU64(address + 8n, selector);
    setU64(address + 16n, types);
    setU64(address + 24n, implementation);
  };

  setU64(CATLIST, CAT);
  setU64(CAT, CAT_NAME);
  setU64(CAT + 8n, rawClassPointer);
  setU64(CAT + 16n, INSTANCE_METHODS);
  setU64(CAT + 24n, CLASS_METHODS);
  setU64(CAT + 32n, withProtocol ? PROTOCOL_REFS : 0n);
  setU64(CAT + 40n, 0n);
  setU64(CAT + 48n, 0n);
  setString(CAT_NAME, 'HexAudit');

  setMethodList(INSTANCE_METHODS, INSTANCE_SELECTOR, INSTANCE_TYPES, INSTANCE_IMP);
  setMethodList(CLASS_METHODS, CLASS_SELECTOR, CLASS_TYPES, CLASS_IMP);
  setString(INSTANCE_SELECTOR, 'hex_isInteresting');
  setString(INSTANCE_TYPES, 'c@:');
  setString(CLASS_SELECTOR, 'classHexValue');
  setString(CLASS_TYPES, 'q@:');

  if (withProtocol) {
    setU64(PROTOCOL_REFS, 1n);
    setU64(PROTOCOL_REFS + 8n, PROTOCOL);
    setU64(PROTOCOL, 0n);
    setU64(PROTOCOL + 8n, PROTOCOL_NAME);
    setString(PROTOCOL_NAME, 'CategoryProtocol');
  }

  return { mem };
}

function makeRead(mem) {
  return async (address, length, soft = false) => {
    const at = Number(address);
    if (!Number.isSafeInteger(at) || at < 0 || at >= mem.length) return null;
    const end = Math.min(mem.length, at + length);
    if (end - at < length && !soft) return null;
    return mem.subarray(at, end);
  };
}

function makeResolvePointer() {
  return async (raw, context) => {
    if (BigInt(raw) === EXTERNAL_RAW && BigInt(context?.address ?? -1) === CLASS_STORAGE) return null;
    return BigInt(raw);
  };
}

async function parseFixture({
  local = false,
  rawClassPointer,
  withProtocol = true,
  sectionOptions = {},
  parserOptions = {},
} = {}) {
  const fixture = buildFixture({ local, rawClassPointer, withProtocol });
  const sections = {
    categoryList: { vmAddr: CATLIST, size: 8n },
    ...sectionOptions,
  };
  return parseObjcExtendedMetadata(makeRead(fixture.mem), sections, {
    classes: local ? [{ addr: CLASS_POINTER, name: 'LocalClass' }] : [],
    resolvePointer: makeResolvePointer(),
    validateImplementation: async () => ({ ok: true }),
    requireImplementationProof: true,
    ...parserOptions,
  });
}

test('issue #6085 restores external category owner for instance/class methods and protocols', async () => {
  const parsed = await parseFixture({
    parserOptions: {
      bindingAt: (address) => BigInt(address) === CLASS_STORAGE
        ? { name: '_OBJC_CLASS_$_NSString', complete: true }
        : null,
    },
  });
  const category = parsed.categories[0];

  assert.equal(category.classAddress, null, 'external bind must remain non-numeric');
  assert.equal(category.className, 'NSString');
  assert.equal(category.targetClass, 'NSString');
  assert.equal(category.target, 'NSString');
  assert.equal(category.methods.length, 1);
  assert.equal(category.methods[0].className, 'NSString');
  assert.equal(category.methods[0].classMethod, false);
  assert.equal(category.classMethods.length, 1);
  assert.equal(category.classMethods[0].className, 'NSString');
  assert.equal(category.classMethods[0].classMethod, true);
  assert.deepEqual(category.protocols.map((protocol) => protocol.name), ['CategoryProtocol']);
});

test('issue #6085 preserves local category address mapping', async () => {
  const parsed = await parseFixture({ local: true });
  const category = parsed.categories[0];
  assert.equal(category.classAddress, CLASS_POINTER);
  assert.equal(category.className, 'LocalClass');
  assert.equal(category.classMethods[0].className, 'LocalClass');
});

test('issue #6085 joins external category methods and protocol adoption in runtime index', async () => {
  const parsed = await parseFixture({
    parserOptions: {
      bindingAt: () => ({ name: '_OBJC_CLASS_$_NSString', complete: true }),
    },
  });
  const index = buildObjcRuntimeIndex({
    classes: [{ name: 'NSString', protocols: [] }],
    protocols: [],
    categories: parsed.categories,
    runtimeCompleteness: {
      classes: { complete: true },
      protocols: { complete: true },
      categories: parsed.completeness.categories,
    },
  });

  const instance = index.methodsBySelector.get('-:hex_isInteresting');
  const classMethod = index.methodsBySelector.get('+:classHexValue');
  assert.equal(instance?.length, 1);
  assert.equal(instance[0].className, 'NSString');
  assert.equal(classMethod?.length, 1);
  assert.equal(classMethod[0].className, 'NSString');
  assert.deepEqual(index.classes.get('NSString').protocols, ['CategoryProtocol']);

  const dispatch = resolveObjcDispatch(index, { receiverType: 'NSString', selector: 'hex_isInteresting' });
  assert.equal(dispatch.resolved?.className, 'NSString');
  assert.equal(dispatch.resolved?.source, 'category');
});

test('issue #6085 uses complete binary-image imports as the automatic bind bridge', async () => {
  const parsed = await parseFixture({
    sectionOptions: {
      binaryImage: {
        imports: [{ name: '_OBJC_CLASS_$_NSString', sites: [{ address: CLASS_STORAGE }] }],
        metadata: { chainedFixups: { complete: true, importsComplete: true, bindingSitesComplete: true } },
      },
    },
  });
  assert.equal(parsed.categories[0].className, 'NSString');
});

test('issue #6085 keeps incomplete, malformed, and conflicting bind evidence unknown', async () => {
  const incomplete = await parseFixture({
    sectionOptions: {
      binaryImage: {
        imports: [{ name: '_OBJC_CLASS_$_NSString', sites: [{ address: CLASS_STORAGE }] }],
        metadata: { chainedFixups: { complete: false, importsComplete: false, bindingSitesComplete: false } },
      },
    },
  });
  assert.equal(incomplete.categories[0].className, null);

  for (const badName of [
    '_some_other_symbol',
    '_OBJC_METACLASS_$_NSString',
    '_OBJC_IVAR_$_NSString._value',
    '_OBJC_CLASS_$_',
    '_OBJC_CLASS_$_NSString.extra',
  ]) {
    const parsed = await parseFixture({
      parserOptions: { bindingAt: () => ({ name: badName, complete: true }) },
    });
    assert.equal(parsed.categories[0].className, null, badName);
  }

  const malformedSite = await parseFixture({
    sectionOptions: {
      binaryImage: {
        imports: [{ name: '_OBJC_CLASS_$_NSString', sites: [{ address: 'not-an-address' }] }],
        metadata: { chainedFixups: { complete: true, importsComplete: true, bindingSitesComplete: true } },
      },
    },
  });
  assert.equal(malformedSite.categories[0].className, null);

  const conflictingSites = await parseFixture({
    sectionOptions: {
      binaryImage: {
        imports: [
          { name: '_OBJC_CLASS_$_NSString', sites: [{ address: CLASS_STORAGE }] },
          { name: '_OBJC_CLASS_$_NSArray', sites: [{ address: CLASS_STORAGE }] },
        ],
        metadata: { chainedFixups: { complete: true, importsComplete: true, bindingSitesComplete: true } },
      },
    },
  });
  assert.equal(conflictingSites.categories[0].className, null);
});

test('issue #6085 requires a nonzero unresolved pointer before symbolic fallback', async () => {
  const zeroPointer = await parseFixture({
    rawClassPointer: 0n,
    parserOptions: { bindingAt: () => ({ name: '_OBJC_CLASS_$_NSString', complete: true }) },
  });
  assert.equal(zeroPointer.categories[0].className, null);

  const ordinaryUnknown = await parseFixture({
    rawClassPointer: CLASS_POINTER,
    parserOptions: { bindingAt: () => ({ name: '_OBJC_CLASS_$_NSString', complete: true }) },
  });
  assert.equal(ordinaryUnknown.categories[0].className, null);
});

test('issue #6085 accepts explicit class-reference fallback and rejects incomplete direct binding', async () => {
  const reference = await parseFixture({
    parserOptions: { resolveClassReference: () => '_OBJC_CLASS_$_NSString' },
  });
  assert.equal(reference.categories[0].className, 'NSString');

  const incomplete = await parseFixture({
    parserOptions: {
      bindingAt: () => ({ name: '_OBJC_CLASS_$_NSString', complete: false }),
    },
  });
  assert.equal(incomplete.categories[0].className, null);
});

console.log('Issue #6085 category external-class regressions PASS!');
