import assert from 'node:assert/strict';

import {
  ABIPlugin,
  abiPlugin,
  abiPluginRegistryDigest,
  abiPluginRegistryGeneration,
  isRegisteredABIPlugin,
  registerABIPlugin,
} from '../../../js/targets/abi/registry.js';
import {
  PlatformProfile,
  platformProfile,
  registerPlatformProfile,
} from '../../../js/targets/platform/index.js';

const coercible = { toString() { return 'coerced'; } };
const invalidStructured = [
  ['array', ['coerced']],
  ['object', coercible],
  ['boolean', true],
  ['number', 7],
  ['boxed-string', new String('coerced')],
];

for (const [label, value] of invalidStructured) {
  assert.throws(
    () => new ABIPlugin({ id:value, architectureId:'x86_64' }),
    TypeError,
    `ABI id must reject ${label}`,
  );
  assert.throws(
    () => new ABIPlugin({ id:'issue-3942-abi', architectureId:value }),
    TypeError,
    `ABI architectureId must reject ${label}`,
  );
  assert.throws(
    () => new ABIPlugin({ id:'issue-3942-abi', architectureId:'x86_64', semanticVersion:value }),
    TypeError,
    `ABI semanticVersion must reject ${label}`,
  );
  assert.throws(
    () => new ABIPlugin({ id:'issue-3942-abi', architectureId:'x86_64', semanticIdentity:value }),
    TypeError,
    `ABI semanticIdentity must reject ${label}`,
  );
  assert.throws(
    () => new PlatformProfile({ id:value }),
    TypeError,
    `platform id must reject ${label}`,
  );
  assert.throws(
    () => new PlatformProfile({ id:'issue-3942-platform', semanticVersion:value }),
    TypeError,
    `platform semanticVersion must reject ${label}`,
  );
}

assert.throws(
  () => new ABIPlugin({ id:'issue-3942-empty-version', architectureId:'x86_64', semanticVersion:'   ' }),
  TypeError,
  'explicit blank ABI semanticVersion must fail closed',
);
assert.throws(
  () => new ABIPlugin({ id:'issue-3942-empty-identity', architectureId:'x86_64', semanticIdentity:'' }),
  TypeError,
  'explicit empty ABI semanticIdentity must fail closed',
);
assert.throws(
  () => new PlatformProfile({ id:'issue-3942-empty-version', semanticVersion:'' }),
  TypeError,
  'explicit empty platform semanticVersion must fail closed',
);

const canonical = new ABIPlugin({
  id:'  ISSUE-3942-CANONICAL  ',
  architectureId:'  X86_64  ',
});
assert.equal(canonical.id, 'issue-3942-canonical');
assert.equal(canonical.architectureId, 'x86_64');
assert.equal(canonical.semanticVersion, '1');
assert.equal(canonical.semanticIdentity, 'issue-3942-canonical@1');

const first = registerABIPlugin({
  id:'issue-3942-registered',
  architectureId:'x86_64',
  semanticVersion:'7',
  semanticIdentity:'issue-3942-registered@7',
});
const firstGeneration = abiPluginRegistryGeneration(first);
assert.equal(isRegisteredABIPlugin(first), true);
assert.equal(typeof abiPluginRegistryDigest(first), 'string');
assert.equal(abiPlugin(' ISSUE-3942-REGISTERED '), first,
  'primitive lookup canonicalization must remain compatible');
assert.equal(abiPlugin(['issue-3942-registered']), first,
  'lookup coercion policy remains separate from provider definition authority');
assert.throws(
  () => registerABIPlugin({ id:'issue-3942-registered', architectureId:'x86_64' }),
  /ABI already registered/,
  'duplicate rejection must remain intact',
);

const replacement = registerABIPlugin({
  id:'issue-3942-registered',
  architectureId:'x86_64',
  semanticVersion:'8',
  semanticIdentity:'issue-3942-registered@8',
}, { replace:true });
assert.equal(abiPlugin('issue-3942-registered'), replacement);
assert.equal(isRegisteredABIPlugin(first), false,
  'replacement must revoke prior canonical object identity');
assert.equal(isRegisteredABIPlugin(replacement), true);
assert.ok(abiPluginRegistryGeneration(replacement) > firstGeneration,
  'replacement must advance registry generation');

const platform = registerPlatformProfile({
  id:'  ISSUE-3942-PLATFORM  ',
  semanticVersion:'7',
});
assert.equal(platform.id, 'issue-3942-platform');
assert.equal(platform.semanticVersion, '7');
assert.equal(platformProfile(' ISSUE-3942-PLATFORM '), platform);
assert.equal(platformProfile(['issue-3942-platform']), platform,
  'platform lookup coercion policy remains separate from provider definition authority');
assert.throws(
  () => registerPlatformProfile({ id:'issue-3942-platform', semanticVersion:'8' }),
  /platform already registered/,
  'platform duplicate rejection must remain intact',
);
const platformReplacement = registerPlatformProfile({
  id:'issue-3942-platform',
  semanticVersion:'8',
}, { replace:true });
assert.equal(platformProfile('issue-3942-platform'), platformReplacement);

console.log('issue-3942 provider identity authority regression: ok');
