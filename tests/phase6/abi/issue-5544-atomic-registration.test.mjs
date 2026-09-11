import assert from 'node:assert/strict';

import {
  ABIPlugin,
  abiPlugin,
  abiPlugins,
  abiPluginRegistryGeneration,
  isRegisteredABIPlugin,
  registerABIPlugin,
} from '../../../js/targets/abi/registry.js';

function pluginWhoseDigestWillThrow(id) {
  function platformPredicate() { return true; }
  const plugin = new ABIPlugin({
    id,
    architectureId:'x86_64',
    platformPredicate,
  });
  Object.defineProperty(platformPredicate, Symbol.toPrimitive, {
    configurable:true,
    value() { throw new Error('issue-5544-digest-boom'); },
  });
  return plugin;
}

const generationAnchor = registerABIPlugin({
  id:'issue-5544-generation-before',
  architectureId:'x86_64',
});
const generationBefore = abiPluginRegistryGeneration(generationAnchor);

const poisonedNew = pluginWhoseDigestWillThrow('issue-5544-new-id');
assert.throws(
  () => registerABIPlugin(poisonedNew),
  /issue-5544-digest-boom/,
  'digest preparation failure must still surface to the caller',
);
assert.equal(abiPlugins().includes(poisonedNew), false,
  'failed registration must not publish a binding-less plugin');
assert.equal(isRegisteredABIPlugin(poisonedNew), false);

const recoveredNew = registerABIPlugin({
  id:'issue-5544-new-id',
  architectureId:'x86_64',
});
assert.equal(abiPlugin('issue-5544-new-id'), recoveredNew,
  'a failed first attempt must not reserve the id');
assert.equal(isRegisteredABIPlugin(recoveredNew), true);
assert.equal(abiPluginRegistryGeneration(recoveredNew), generationBefore + 1,
  'a failed registration must not consume a registry generation');

const original = registerABIPlugin({
  id:'issue-5544-replacement',
  architectureId:'x86_64',
});
const originalGeneration = abiPluginRegistryGeneration(original);
const poisonedReplacement = pluginWhoseDigestWillThrow('issue-5544-replacement');
assert.throws(
  () => registerABIPlugin(poisonedReplacement, { replace:true }),
  /issue-5544-digest-boom/,
);
assert.equal(abiPlugin('issue-5544-replacement'), original,
  'failed replacement must preserve the previous canonical plugin');
assert.equal(isRegisteredABIPlugin(original), true,
  'failed replacement must preserve the previous canonical binding');
assert.equal(isRegisteredABIPlugin(poisonedReplacement), false);

const replacement = registerABIPlugin({
  id:'issue-5544-replacement',
  architectureId:'x86_64',
  semanticVersion:'2',
}, { replace:true });
assert.equal(abiPlugin('issue-5544-replacement'), replacement);
assert.equal(isRegisteredABIPlugin(replacement), true);
assert.equal(abiPluginRegistryGeneration(replacement), originalGeneration + 1,
  'failed replacement must not create a generation gap');

const generationBeforeReentry = abiPluginRegistryGeneration(replacement);
let nested = null;
function reentrantPredicate() { return true; }
const reentrant = new ABIPlugin({
  id:'issue-5544-reentrant-outer',
  architectureId:'x86_64',
  platformPredicate:reentrantPredicate,
});
Object.defineProperty(reentrantPredicate, Symbol.toPrimitive, {
  configurable:true,
  value() {
    if (!nested) {
      nested = registerABIPlugin({
        id:'issue-5544-reentrant-inner',
        architectureId:'x86_64',
      });
    }
    return Function.prototype.toString.call(reentrantPredicate);
  },
});
registerABIPlugin(reentrant);
assert.equal(abiPluginRegistryGeneration(nested), generationBeforeReentry + 1,
  'provider re-entry must consume the next generation first');
assert.equal(abiPluginRegistryGeneration(reentrant), generationBeforeReentry + 2,
  'outer registration must choose its generation after provider re-entry completes');
assert.equal(isRegisteredABIPlugin(nested), true);
assert.equal(isRegisteredABIPlugin(reentrant), true);

console.log('issue-5544 ABI registry atomic registration regression: ok');
