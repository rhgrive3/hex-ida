import assert from 'node:assert/strict';
import test from 'node:test';

import { ABIPlugin } from '../../../js/targets/abi/registry.js';
import { ArchitecturePluginV2 } from '../../../js/targets/architecture/registry.js';

const NON_CALLABLE_VALUES = Object.freeze([true, false, 1, 'callback', {}, []]);

function assertRejectsNonCallable(factory, field) {
  for (const value of NON_CALLABLE_VALUES) {
    assert.throws(
      () => factory({ [field]:value }),
      new RegExp(`^TypeError: ${field} must be a function$`),
      `${field} must reject ${Array.isArray(value) ? 'array' : typeof value}`,
    );
  }

  let coercions = 0;
  const hostile = {
    [Symbol.toPrimitive]() { coercions += 1; return 'callback'; },
    toString() { coercions += 1; return 'callback'; },
    valueOf() { coercions += 1; return 1; },
  };
  assert.throws(
    () => factory({ [field]:hostile }),
    new RegExp(`^TypeError: ${field} must be a function$`),
  );
  assert.equal(coercions, 0, `${field} validation must not coerce provider objects`);
}

test('ArchitecturePluginV2 keeps decodeProvider a provider identity, not a callable hook (#3951 scope)', () => {
  const external = new ArchitecturePluginV2({
    id:'issue-3951-architecture-provider',
    decodeProvider:'capstone/backend',
  });
  assert.equal(external.decodeProvider, 'capstone/backend',
    'decodeProvider is a provider identity string and must stay outside the callable-hook contract');
  assert.equal(external.capabilities.decode, 'external');

  const omitted = new ArchitecturePluginV2({ id:'issue-3951-architecture-omitted' });
  assert.equal(omitted.decodeProvider, null);
  assert.equal(omitted.capabilities.decode, 'unsupported');
});

test('ABIPlugin rejects non-callable executable hooks at the constructor boundary', () => {
  const fields = [
    'platformPredicate',
    'callingConventions',
    'classifyArguments',
    'classifyCallReturn',
    'classifyFunctionReturn',
    'classifyEntryRegister',
    'callerSaved',
    'calleeSaved',
    'stackRules',
    'redZone',
    'unwindRules',
    'defaultUnknownCallEffects',
  ];

  for (const field of fields) {
    assertRejectsNonCallable(
      (extra) => new ABIPlugin({ id:`issue-3951-${field}`, architectureId:'x86_64', ...extra }),
      field,
    );
    const callback = () => field;
    const plugin = new ABIPlugin({
      id:`issue-3951-valid-${field}`,
      architectureId:'x86_64',
      [field]:callback,
    });
    assert.equal(plugin[field], callback, `${field} must retain a valid function unchanged`);
  }
});

test('ABIPlugin rejects class constructors and bound class constructors as executable hooks', () => {
  class NotACallback { static tag = 'issue-3951-class'; }
  const BoundClass = NotACallback.bind(null);

  for (const [label, hook] of [['class constructor', NotACallback], ['bound class constructor', BoundClass]]) {
    assert.throws(
      () => new ABIPlugin({ id:'issue-3951-class-hook', architectureId:'x86_64', platformPredicate:hook }),
      /platformPredicate must be an invocable callback, not a class constructor/,
      `${label} must fail fast at construction instead of TypeError at invocation`,
    );
  }

  const ordinary = function hookCallback() { return true; };
  const arrow = () => true;
  const boundOrdinary = ordinary.bind(null);
  let accepted = 0;
  for (const hook of [ordinary, arrow, boundOrdinary]) {
    const plugin = new ABIPlugin({ id:'issue-3951-invocable-hook', architectureId:'x86_64', platformPredicate:hook });
    assert.equal(plugin.platformPredicate, hook, 'invocable ordinary/arrow/bound functions must retain identity');
    assert.equal(plugin.platformPredicate({ platform:'linux' }), true);
    accepted += 1;
  }
  assert.equal(accepted, 3);
});

test('ABIPlugin preserves documented callback defaults when hooks are omitted', () => {
  const plugin = new ABIPlugin({ id:'issue-3951-abi-defaults', architectureId:'x86_64' });

  assert.equal(plugin.platformPredicate({}), true);
  assert.deepEqual(plugin.callingConventions(), []);
  assert.deepEqual(plugin.classifyArguments(), {
    srcs:[], arguments:[], stackArguments:[], stackArgsUnknown:true,
    stackArgsMayContainPointers:true, evidence:'unsupported-abi', unsupported:true,
  });
  assert.equal(plugin.classifyCallReturn(), null);
  assert.equal(plugin.classifyFunctionReturn(), null);
  assert.deepEqual(plugin.classifyEntryRegister(), { kind:'incoming-register-state' });
  assert.deepEqual(plugin.callerSaved(), []);
  assert.deepEqual(plugin.calleeSaved(), []);
  assert.deepEqual(plugin.stackRules(), { unknown:true });
  assert.equal(plugin.redZone(), null);
  assert.deepEqual(plugin.unwindRules(), { unknown:true });
  assert.deepEqual(plugin.defaultUnknownCallEffects(), {
    registerEffects:'unknown', memoryEffects:'unknown', mayThrow:true,
  });
});
