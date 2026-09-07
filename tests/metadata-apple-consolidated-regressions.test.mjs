import assert from 'node:assert/strict';
import { buildSelectorIndex, resolveSelectorStub } from '../js/apple/selector-stubs.js';
import { FieldIndex } from '../js/fields.js';
import { buildObjcRuntimeIndex, formatObjcMessage, objcMessage, resolveObjcDispatch } from '../js/apple/objc-runtime.js';
import { demangleCxx, demangleSwift, readableName, shortName, isMangled } from '../js/rtti.js';
import { parseUnifiedLanguageMetadata } from '../js/metadata/index.js';
import { buildObjcRuntimeModel } from '../js/objc.js';
import '../js/objc-stub-recovery.js';

// --- Test 1: #3444 Objective-C selector index rejects non-string selector ---
{
  const index = buildSelectorIndex({
    stubs: [
      { addr: 16, selector: ['doThing:'] },
      { addr: 16, selector: 'other:' },
    ],
  });
  // ['doThing:'] must have been ignored
  const resolved = resolveSelectorStub({ address: 16, selectorIndex: index });
  assert.equal(resolved.selector, 'other:');
  assert.equal(resolved.ambiguous, false);

  const solo = buildSelectorIndex({
    stubs: [{ addr: 16, selector: ['doThing:'] }],
  });
  const soloResolved = resolveSelectorStub({ address: 16, selectorIndex: solo });
  assert.equal(soloResolved.selector, null, 'structured selector must not be returned as resolved selector');
  console.log('✔ #3444 selector index non-string rejection passed');
}

// --- Test 2: #4117 FieldIndex numeric key validation ---
{
  const model = {
    classes: [
      {
        name: 'Player',
        instanceSize: 64,
        ivars: [
          { name: '_hp', offset: 32, size: 4, offsetVar: 4096n },
        ],
        methods: [
          { addr: 4096n, sel: 'takeDamage:', kind: '-' },
        ],
      },
    ],
  };
  const fields = new FieldIndex(model);

  // structured arguments must fail closed
  assert.equal(fields.fieldAt('Player', [32]), null, 'fieldAt([32]) must return null');
  assert.deepEqual(fields.ownersOf(['4096']), [], 'ownersOf(["4096"]) must return []');
  assert.equal(fields.fieldAtOffsetVar(['4096']), null, 'fieldAtOffsetVar(["4096"]) must return null');

  // canonical arguments must succeed
  const field = fields.fieldAt('Player', 32);
  assert.ok(field && field.field.name === '_hp');
  const owners = fields.ownersOf(4096n);
  assert.equal(owners.length, 1);
  assert.equal(owners[0].className, 'Player');
  const offsetVar = fields.fieldAtOffsetVar(4096n);
  assert.ok(offsetVar && offsetVar.className === 'Player' && offsetVar.field.name === '_hp');
  console.log('✔ #4117 FieldIndex numeric key validation passed');
}

// --- Test 3: #4560 formatObjcMessage preserves variadic extra arguments ---
{
  const formatted = formatObjcMessage({
    receiver: 'NSString',
    selector: 'stringWithFormat:',
    args: ['@"%@ %@"', 'left', 'right'],
    style: 'objc',
  });
  assert.equal(formatted, '[NSString stringWithFormat:@"%@ %@", left, right]');

  const normalOneArg = formatObjcMessage({
    receiver: 'NSArray',
    selector: 'arrayWithObject:',
    args: ['obj'],
  });
  assert.equal(normalOneArg, '[NSArray arrayWithObject:obj]');

  const normalTwoArg = formatObjcMessage({
    receiver: 'dict',
    selector: 'setObject:forKey:',
    args: ['val', 'key'],
  });
  assert.equal(normalTwoArg, '[dict setObject:val forKey:key]');

  const placeholderArg = formatObjcMessage({
    receiver: 'dict',
    selector: 'setObject:forKey:',
    args: ['val'],
  });
  assert.equal(placeholderArg, '[dict setObject:val forKey:a2]');

  const dotStyle = formatObjcMessage({
    receiver: 'NSString',
    selector: 'stringWithFormat:',
    args: ['@"%@ %@"', 'left', 'right'],
    style: 'dot',
  });
  assert.equal(dotStyle, 'NSString.stringWithFormat(@"%@ %@", left, right)');

  const msg = objcMessage(null, {
    receiver: 'NSString',
    selector: 'stringWithFormat:',
    args: ['@"%@ %@"', 'left', 'right'],
  });
  assert.equal(msg.text, '[NSString stringWithFormat:@"%@ %@", left, right]');
  assert.deepEqual(msg.args, ['@"%@ %@"', 'left', 'right']);
  console.log('✔ #4560 formatObjcMessage variadic args preservation passed');
}

// --- Test 4: #6105 RTTI demangler non-string symbol name validation ---
{
  assert.equal(demangleCxx(['_Z3foov']), null, 'demangleCxx with array must return null');
  assert.equal(demangleSwift(['$s1A']), null, 'demangleSwift with array must return null without throwing');
  assert.deepEqual(readableName(['_Z3foov']), ['_Z3foov'], 'readableName with non-string must return input');
  assert.deepEqual(shortName(['_Z3foov']), ['_Z3foov'], 'shortName with non-string must return input');
  assert.equal(isMangled(['_Z3foov']), false, 'isMangled with non-string must return false');

  // canonical strings continue to work
  assert.equal(demangleCxx('__ZN3Foo3barEi'), 'Foo::bar(int)');
  assert.equal(isMangled('__ZN3Foo3barEi'), true);
  console.log('✔ #6105 RTTI demangler non-string validation passed');
}

// --- Test 5: #3608 Swift 4 legacy prefix survives Darwin normalization ---
{
  assert.equal(demangleSwift('_T04Test3Foo'), 'Test.Foo');
  assert.equal(demangleSwift('_T4Test3Foo'), 'Test.Foo');
  assert.equal(readableName('_T04Test3Foo'), 'Test.Foo');

  // Existing modern Swift spellings keep their accepted normalization.
  assert.equal(demangleSwift('_$s4Test3Foo'), 'Test.Foo');
  assert.equal(demangleSwift('$s4Test3Foo'), 'Test.Foo');
  assert.equal(demangleSwift('_$S4Test3Foo'), 'Test.Foo');
  assert.equal(demangleSwift('$S4Test3Foo'), 'Test.Foo');
  assert.equal(demangleSwift('_foo'), null);
  console.log('✔ #3608 Swift legacy prefix normalization passed');
}

// --- Test 6: #6062 unified metadata dispatcher provider discovery parity ---
{
  // Rust discovery via __R and ZN
  const rustV0 = await parseUnifiedLanguageMetadata({
    symbols: [{ name: '__RNvNtCs1234_4core3fmt' }],
  });
  assert.ok(rustV0.ecosystems.includes('rust'), 'Rust provider must be discovered for __R symbol');

  const rustZN = await parseUnifiedLanguageMetadata({
    symbols: [{ name: 'ZN4core3fmtE' }],
  });
  assert.ok(rustZN.ecosystems.includes('rust'), 'Rust provider must be discovered for ZN symbol');

  // Swift discovery via sectname
  const swiftSect = await parseUnifiedLanguageMetadata({
    sections: [{ sectname: '__swift5_types', addr: 0x1000n, size: 4 }],
    readAt: async () => new Uint8Array(),
  });
  assert.ok(swiftSect.ecosystems.includes('swift'), 'Swift provider must be discovered for sectname');

  // ObjC discovery via sectname
  const objcSect = await parseUnifiedLanguageMetadata({
    sections: [{ sectname: '__objc_classlist', addr: 0x1000n, size: 8 }],
    readAt: async () => new Uint8Array(),
  });
  assert.ok(objcSect.ecosystems.includes('objc'), 'ObjC provider must be discovered for sectname');

  console.log('✔ #6062 unified dispatcher provider discovery parity passed');
}

// --- Test 6: #3629 ObjC stub selector C strings must be proven NUL-terminated ---
{
  const Words = {
    KIND: { BRANCH: 1, RET: 2 },
    pcRelTarget(word) {
      return word === 1 ? { reg: 0, value: 0x2000n } : null;
    },
    pairedOffset(word) {
      return word === 2 ? { load: true, rn: 0, rd: 1, imm: 0n } : null;
    },
    classifyWord(word) {
      return word === 3 ? this.KIND.BRANCH : 0;
    },
  };

  const makeBudget = () => ({
    takeRegion: () => true,
    takeRead: () => true,
    takeResident: () => true,
    releaseResident: () => {},
    takeOperation: () => true,
    takeString: () => true,
    takeName: () => true,
    expired: () => false,
  });

  async function recoverSelector(selectorBytes, maxSelector = 3) {
    const file = new Uint8Array(0x300);
    const view = new DataView(file.buffer);
    view.setUint32(0, 1, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, 3, true);
    let selectorPointer = 0x3000n;
    for (let i = 0; i < 8; i++) {
      file[0x100 + i] = Number(selectorPointer & 0xffn);
      selectorPointer >>= 8n;
    }
    file.set(selectorBytes, 0x200);

    const regions = [
      { section: '__objc_stubs', fileOffset: 0n, size: 12n, vmAddr: 0x1000n },
      { section: '__objc_selrefs', fileOffset: 0x100n, size: 8n, vmAddr: 0x2000n },
      { section: '__objc_methname', fileOffset: 0x200n, size: BigInt(selectorBytes.length), vmAddr: 0x3000n },
    ];

    return globalThis.HexObjCStubRecovery.recover({
      slice: { offset: 0n, size: BigInt(file.length), regions, info: { textVM: 0x1000n } },
      known: [],
      readRange: async (offset, length) => file.slice(Number(offset), Number(offset) + length),
      cancelled: () => false,
      requestId: 1,
      fileSize: BigInt(file.length),
      Words,
      budget: makeBudget(),
      sanitizePointer: (value) => value,
      maxSelector,
    });
  }

  const exact = await recoverSelector(Uint8Array.from([0x61, 0x62, 0x63, 0x00]));
  assert.deepEqual(exact.map((entry) => entry.name), ['_objc_msgSend$abc'],
    'selector exactly maxSelector chars long must remain valid when the following byte is NUL');

  const overlong = await recoverSelector(Uint8Array.from([0x61, 0x62, 0x63, 0x64, 0x00]));
  assert.deepEqual(overlong, [], 'overlong selector prefix must not be promoted to a canonical stub name');

  const unterminated = await recoverSelector(Uint8Array.from([0x61, 0x62, 0x63]));
  assert.deepEqual(unterminated, [], 'region-end without a NUL terminator must fail closed');

  console.log('✔ #3629 ObjC stub selector termination proof passed');
}

// --- Test 7: #4253 known-empty ObjC protocol context must not mean unrestricted ---
{
  const requirements = [
    { name: 'P', methods: [{ sel: 'work', types: 'v@:' }] },
    { name: 'Q', methods: [{ sel: 'work', types: 'v@:' }] },
  ];

  const knownEmpty = buildObjcRuntimeIndex({
    classes: [{ name: 'PlainClass', superName: null, protocols: [], methods: [], classMethods: [] }],
    protocols: requirements,
    categories: [],
  });
  const emptyResult = resolveObjcDispatch(knownEmpty, { receiverType: 'PlainClass', selector: 'work' });
  assert.deepEqual(emptyResult.requirements, [], 'known protocols:[] must filter unrelated requirements to empty');
  assert.equal(emptyResult.confidence, 0.1);
  assert.equal(emptyResult.reason, 'selector implementation not present in parsed metadata');

  const adopted = buildObjcRuntimeIndex({
    classes: [{ name: 'ConformingClass', superName: null, protocols: ['P'], methods: [], classMethods: [] }],
    protocols: requirements,
    categories: [],
  });
  const adoptedResult = resolveObjcDispatch(adopted, { receiverType: 'ConformingClass', selector: 'work' });
  assert.deepEqual(adoptedResult.requirements.map((x) => x.className), ['P'], 'known non-empty conformance must keep only adopted protocol requirements');

  const explicitResult = resolveObjcDispatch(adopted, { receiverType: null, selector: 'work', protocols: ['Q'] });
  assert.deepEqual(explicitResult.requirements.map((x) => x.className), ['Q'], 'explicit protocol context must remain authoritative');

  const unknownReceiver = buildObjcRuntimeIndex({ classes: [], protocols: requirements, categories: [] });
  assert.equal(resolveObjcDispatch(unknownReceiver, { selector: 'work' }).requirements.length, 2, 'truly unknown receiver/protocol context must preserve all requirements');

  const legacyMissingConformance = buildObjcRuntimeIndex({
    classes: [{ name: 'LegacyClass', superName: null, methods: [], classMethods: [] }],
    protocols: requirements,
    categories: [],
  });
  assert.equal(resolveObjcDispatch(legacyMissingConformance, { receiverType: 'LegacyClass', selector: 'work' }).requirements.length, 2, 'missing protocols property must remain conservative for #3983 compatibility');

  const partial = buildObjcRuntimeIndex({
    classes: [{ name: 'PartialClass', superName: null, protocols: [], methods: [], classMethods: [] }],
    protocols: requirements,
    categories: [],
    runtimeCompleteness: { classes: { complete: false }, categories: { complete: true } },
  });
  assert.equal(resolveObjcDispatch(partial, { receiverType: 'PartialClass', selector: 'work' }).requirements.length, 2, 'explicitly partial class metadata must not become negative protocol proof');

  const partialProtocols = buildObjcRuntimeIndex({
    classes: [{ name: 'PartialRegistryClass', superName: null, protocols: [], methods: [], classMethods: [] }],
    protocols: requirements,
    categories: [],
    runtimeCompleteness: { classes: { complete: true }, protocols: { complete: false }, categories: { complete: true } },
  });
  assert.equal(resolveObjcDispatch(partialProtocols, { receiverType: 'PartialRegistryClass', selector: 'work' }).requirements.length, 2, 'incomplete protocol registry must not enable negative protocol filtering');

  console.log('✔ #4253 known-empty ObjC protocol context passed');
}


// --- Regression: #3605 Objective-C facade proof options cannot be overridden ---
{
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
    return { read, classList: { vmAddr: CLASS_LIST, size: 8n }, sections };
  }

  const maliciousOptions = {
    requireImplementationProof: false,
    validateImplementation: () => ({ ok: true }),
  };

  const legacy = fixture({ classMethod: true });
  const legacyModel = await buildObjcRuntimeModel(
    legacy.read, legacy.classList, legacy.sections, null, 0n, null, maliciousOptions,
  );
  assert.equal(legacyModel.implementationProofRequired, true);
  assert.equal(legacyModel.classes[0].methods[0].implementationProven, false);
  assert.equal(legacyModel.classes[0].methods[0].implementationValidationReason, 'method-imp-not-executable');
  assert.deepEqual(legacyModel.names, []);

  const extended = fixture({ categoryMethod: true });
  const extendedModel = await buildObjcRuntimeModel(
    extended.read, extended.classList, extended.sections, null, 0n, null, maliciousOptions,
  );
  assert.equal(extendedModel.categories[0].instanceMethods[0].implementationProven, false);
  assert.equal(extendedModel.categories[0].instanceMethods[0].implementationValidationReason, 'method-imp-not-executable');
  assert.deepEqual(extendedModel.names, []);

  const valid = fixture({ classMethod: true, categoryMethod: true });
  valid.sections.executableRanges = [{ vmAddr: CLASS_IMP, size: 0x200n }];
  const validModel = await buildObjcRuntimeModel(
    valid.read, valid.classList, valid.sections, null, 0n, null, maliciousOptions,
  );
  assert.equal(validModel.classes[0].methods[0].implementationProven, true);
  assert.equal(validModel.categories[0].instanceMethods[0].implementationProven, true);
  assert.deepEqual(validModel.names.map((entry) => entry.addr), [CLASS_IMP, CATEGORY_IMP]);

  console.log('✔ #3605 ObjC implementation proof option authority passed');
}

console.log('\nAll metadata-apple consolidated regression tests PASSED!');
