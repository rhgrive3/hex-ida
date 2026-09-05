import assert from 'node:assert/strict';
import { buildSelectorIndex, resolveSelectorStub } from '../js/apple/selector-stubs.js';
import { FieldIndex } from '../js/fields.js';
import { buildObjcRuntimeIndex, formatObjcMessage, objcMessage, resolveObjcDispatch } from '../js/apple/objc-runtime.js';
import { demangleCxx, demangleSwift, readableName, shortName, isMangled } from '../js/rtti.js';
import { parseUnifiedLanguageMetadata } from '../js/metadata/index.js';

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

// --- Test 5: #6062 unified metadata dispatcher provider discovery parity ---
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

// --- Test 6: #4253 known-empty ObjC protocol context must not mean unrestricted ---
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

  console.log('✔ #4253 known-empty ObjC protocol context passed');
}

console.log('\nAll metadata-apple consolidated regression tests PASSED!');