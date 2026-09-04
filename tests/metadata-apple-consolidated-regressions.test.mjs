import assert from 'node:assert/strict';
import { buildSelectorIndex, resolveSelectorStub } from '../js/apple/selector-stubs.js';
import { FieldIndex } from '../js/fields.js';
import { formatObjcMessage, objcMessage } from '../js/apple/objc-runtime.js';
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

console.log('\nAll metadata-apple consolidated regression tests PASSED!');
