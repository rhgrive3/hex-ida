import assert from 'node:assert/strict';
import {
  ArchitecturePluginV2,
  architecturePluginV2,
  registerArchitecturePlugin,
} from '../js/targets/architecture/registry.js';

for (const semanticVersion of [undefined, null]) {
  const plugin = new ArchitecturePluginV2({
    id:`issue-4936-default-${semanticVersion === null ? 'null' : 'undefined'}`,
    semanticVersion,
  });
  assert.equal(plugin.semanticVersion, '1', 'nullish semanticVersion must retain the established default');
}

for (const semanticVersion of ['1', '7', ' v7 ']) {
  const plugin = new ArchitecturePluginV2({
    id:`issue-4936-valid-${semanticVersion.trim()}`,
    semanticVersion,
  });
  assert.equal(plugin.semanticVersion, semanticVersion, 'valid primitive string identity must be preserved');
  assert.equal(Object.isFrozen(plugin), true);
}

let coercionCalled = false;
const coercible = {
  toString() {
    coercionCalled = true;
    return '7';
  },
};

for (const semanticVersion of [
  ['7'],
  coercible,
  7,
  0,
  true,
  false,
  '',
  '   ',
]) {
  assert.throws(
    () => new ArchitecturePluginV2({ id:'issue-4936-invalid', semanticVersion }),
    (error) => error instanceof TypeError
      && error.message === 'architecture semanticVersion must be a non-empty string',
    'explicit noncanonical semanticVersion must fail at construction',
  );
}
assert.equal(coercionCalled, false, 'semanticVersion validation must not invoke object coercion');

const original = registerArchitecturePlugin({
  id:'issue-4936-replace-safety',
  semanticVersion:'7',
}, { replace:true });
assert.throws(
  () => registerArchitecturePlugin({
    id:'issue-4936-replace-safety',
    semanticVersion:['8'],
  }, { replace:true }),
  /^TypeError: architecture semanticVersion must be a non-empty string$/,
  'malformed replacement must fail before mutating the registry',
);
assert.equal(architecturePluginV2('issue-4936-replace-safety'), original);
assert.equal(original.semanticVersion, '7');

console.log('ArchitecturePluginV2 semanticVersion authority regressions passed');
