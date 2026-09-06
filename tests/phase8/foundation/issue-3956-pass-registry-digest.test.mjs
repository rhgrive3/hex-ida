import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROVIDER_PASS,
  passRegistryDigest,
  phase8Passes,
} from '../../../js/decompiler/phase8/index.js';

function provider(id, { version = '1.0.0', interfaceVersion = 1, kinds = ['idiom'] } = {}) {
  return Object.freeze({ id, version, interfaceVersion, kinds: Object.freeze([...kinds]) });
}

const providerPass = Object.freeze({ descriptor: PROVIDER_PASS });

test('pass registry identity includes the declared production contract', () => {
  const changedProduces = Object.freeze({
    descriptor: Object.freeze({ ...PROVIDER_PASS, produces: Object.freeze(['providerHints', 'ranges']) }),
  });

  assert.notEqual(
    passRegistryDigest([providerPass], []),
    passRegistryDigest([changedProduces], []),
    'changing descriptor.produces must invalidate the registry identity',
  );
});

test('provider registry identity covers version, interface and kinds independent of order', () => {
  const baseline = [
    provider('phase8.provider.beta', { kinds: ['render', 'idiom'] }),
    provider('phase8.provider.alpha'),
  ];
  const reordered = [...baseline].reverse().map((entry) => provider(entry.id, {
    version: entry.version,
    interfaceVersion: entry.interfaceVersion,
    kinds: [...entry.kinds].reverse(),
  }));
  const baselineDigest = passRegistryDigest([providerPass], baseline);

  assert.equal(passRegistryDigest([providerPass], reordered), baselineDigest,
    'registry and kind ordering must not change identity');
  assert.notEqual(passRegistryDigest([providerPass], baseline.map((entry) => (
    entry.id === 'phase8.provider.alpha' ? provider(entry.id, { version: '1.0.1' }) : entry
  ))), baselineDigest, 'provider version must change identity');
  assert.notEqual(passRegistryDigest([providerPass], baseline.map((entry) => (
    entry.id === 'phase8.provider.alpha' ? provider(entry.id, { interfaceVersion: 2 }) : entry
  ))), baselineDigest, 'provider interface version must change identity');
  assert.notEqual(passRegistryDigest([providerPass], baseline.map((entry) => (
    entry.id === 'phase8.provider.alpha' ? provider(entry.id, { kinds: ['render'] }) : entry
  ))), baselineDigest, 'declared provider kinds must change identity');
});

test('provider registry changes do not invalidate stage sets without the provider pass', () => {
  const passes = phase8Passes({ stages: ['canonical-facts'] });
  const before = [provider('phase8.provider.alpha')];
  const after = [provider('phase8.provider.alpha', { version: '2.0.0' })];

  assert.equal(passRegistryDigest(passes, before), passRegistryDigest(passes, after));
});
