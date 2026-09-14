import assert from 'node:assert/strict';
import {
  ArchitecturePluginV2,
  architecturePluginV2,
  registerArchitecturePlugin,
} from '../js/targets/architecture/registry.js';

const defaultedHooks = new Set([
  'modes',
  'registerFile',
  'physicalAddressSpaces',
  'classifyControlFlow',
  'directControlTarget',
]);
const optionalHooks = new Set([
  'decode',
  'liftExact',
  'assemble',
  'validateEncoding',
]);
const hooks = [...defaultedHooks, ...optionalHooks];

for (const hook of hooks) {
  for (const invalid of [false, true, 0, 1, 'hook', [], {}]) {
    assert.throws(
      () => new ArchitecturePluginV2({ id:`issue-3368-${hook}`, [hook]:invalid }),
      (error) => error instanceof TypeError && error.message === `${hook} must be a function`,
      `${hook} must reject an explicit non-function at construction`,
    );
  }

  for (const absent of [null, undefined]) {
    const plugin = new ArchitecturePluginV2({ id:`issue-3368-${hook}-absent`, [hook]:absent });
    if (defaultedHooks.has(hook)) assert.equal(typeof plugin[hook], 'function');
    else assert.equal(plugin[hook], null);
  }
}

const defaults = new ArchitecturePluginV2({ id:'issue-3368-defaults' });
assert.deepEqual(defaults.modes(), []);
assert.deepEqual(defaults.registerFile(), []);
assert.deepEqual(defaults.physicalAddressSpaces(), ['register','memory','code','unique']);
assert.equal(defaults.classifyControlFlow({}), null);
assert.equal(defaults.directControlTarget({}), null);
for (const hook of optionalHooks) assert.equal(defaults[hook], null);

const callback = () => 'ok';
for (const hook of hooks) {
  const plugin = new ArchitecturePluginV2({ id:`issue-3368-valid-${hook}`, [hook]:callback });
  assert.equal(plugin[hook], callback, `${hook} must preserve valid function identity`);
}

const externalDecoder = new ArchitecturePluginV2({
  id:'issue-3368-decode-provider',
  decodeProvider:'capstone/backend',
});
assert.equal(externalDecoder.decodeProvider, 'capstone/backend', 'decodeProvider is a provider identity, not a callable hook');
assert.equal(externalDecoder.capabilities.decode, 'external');

const original = registerArchitecturePlugin({
  id:'issue-3368-replace-safety',
  modes:callback,
}, { replace:true });
assert.throws(
  () => registerArchitecturePlugin({ id:'issue-3368-replace-safety', modes:[] }, { replace:true }),
  /^TypeError: modes must be a function$/,
  'malformed replacement must fail before mutating the registry',
);
assert.equal(architecturePluginV2('issue-3368-replace-safety'), original);

console.log('ArchitecturePluginV2 hook contract regressions passed');
