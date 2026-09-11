import assert from 'node:assert/strict';
import vm from 'node:vm';
import { PlatformPluginRegistry } from '../../js/platform/plugin-api.js';
import { validatePluginManifest } from '../../js/platform/plugin-manifest.js';

function validManifest(overrides = {}) {
  return {
    id: 'vendor.plugin',
    name: 'Plugin',
    version: '1.0.0',
    apiVersion: '2.0.0',
    permissions: { binaryRead: false },
    supportedTargets: ['*'],
    contributions: [{
      type: 'analyzer',
      id: 'vendor.plugin.analyzer',
      contractVersion: '1.0.0',
      capabilities: ['cancel', 'progress'],
    }],
    ...overrides,
  };
}

function assertRejected(mutator, pattern) {
  let coercions = 0;
  const hostile = Object.freeze({
    toString() { coercions += 1; return mutator.value; },
    valueOf() { coercions += 1; return mutator.value; },
    [Symbol.toPrimitive]() { coercions += 1; return mutator.value; },
  });
  assert.throws(() => validatePluginManifest(mutator.apply(validManifest(), hostile)), pattern);
  assert.equal(coercions, 0, `${mutator.label}: validation must not coerce structured values`);
}

{
  const normalized = validatePluginManifest(validManifest({
    name: '  Plugin Name  ',
    supportedTargets: ['  arm64  ', '*'],
    contributions: [{
      type: 'analyzer',
      id: 'vendor.plugin.analyzer',
      contractVersion: '1.0.0',
      capabilities: [' progress ', 'cancel'],
    }],
  }));
  assert.equal(normalized.id, 'vendor.plugin');
  assert.equal(normalized.name, 'Plugin Name');
  assert.deepEqual(normalized.supportedTargets, ['arm64', '*']);
  assert.deepEqual(normalized.contributions[0].capabilities, ['progress', 'cancel']);
}

for (const [label, value, apply, pattern] of [
  ['plugin id array', ['vendor.plugin'], (m, v) => ({ ...m, id: v }), /plugin-manifest-id-invalid/],
  ['plugin name array', ['Plugin'], (m, v) => ({ ...m, name: v }), /plugin-manifest-name-invalid/],
  ['target array', ['*'], (m, v) => ({ ...m, supportedTargets: [v] }), /plugin-manifest-supported-targets-invalid/],
  ['contribution id array', ['vendor.plugin.analyzer'], (m, v) => ({ ...m, contributions: [{ ...m.contributions[0], id: v }] }), /plugin-manifest-contribution-id-invalid/],
  ['capability array', ['cancel'], (m, v) => ({ ...m, contributions: [{ ...m.contributions[0], capabilities: [v] }] }), /plugin-manifest-capabilities-invalid/],
]) {
  assert.throws(() => validatePluginManifest(apply(validManifest(), value)), pattern, label);
}

for (const mutator of [
  { label: 'plugin id object', value: 'vendor.plugin', apply: (m, v) => ({ ...m, id: v }) },
  { label: 'plugin name object', value: 'Plugin', apply: (m, v) => ({ ...m, name: v }) },
  { label: 'target object', value: '*', apply: (m, v) => ({ ...m, supportedTargets: [v] }) },
  { label: 'contribution id object', value: 'vendor.plugin.analyzer', apply: (m, v) => ({ ...m, contributions: [{ ...m.contributions[0], id: v }] }) },
  { label: 'capability object', value: 'cancel', apply: (m, v) => ({ ...m, contributions: [{ ...m.contributions[0], capabilities: [v] }] }) },
]) {
  assertRejected(mutator, /plugin-manifest-(?:id|name|supported-targets|contribution-id|capabilities|unknown-capability)/);
}

{
  const crossRealm = vm.runInNewContext(`({
    id: 'vendor.crossrealm',
    name: 'Cross Realm Plugin',
    target: 'arm64',
    contributionId: 'vendor.crossrealm.analyzer',
    capability: 'cancel',
  })`);
  const normalized = validatePluginManifest({
    ...validManifest(),
    id: crossRealm.id,
    name: crossRealm.name,
    supportedTargets: [crossRealm.target],
    contributions: [{
      type: 'analyzer',
      id: crossRealm.contributionId,
      contractVersion: '1.0.0',
      capabilities: [crossRealm.capability],
    }],
  });
  assert.equal(typeof crossRealm.id, 'string');
  assert.equal(normalized.id, 'vendor.crossrealm');
  assert.equal(normalized.name, 'Cross Realm Plugin');
  assert.deepEqual(normalized.supportedTargets, ['arm64']);
  assert.deepEqual(normalized.contributions[0].capabilities, ['cancel']);
}

for (const [label, value, apply, pattern] of [
  ['boxed plugin id', new String('vendor.plugin'), (m, v) => ({ ...m, id: v }), /plugin-manifest-id-invalid/],
  ['boxed plugin name', new String('Plugin'), (m, v) => ({ ...m, name: v }), /plugin-manifest-name-invalid/],
  ['boxed target', new String('*'), (m, v) => ({ ...m, supportedTargets: [v] }), /plugin-manifest-supported-targets-invalid/],
  ['boxed contribution id', new String('vendor.plugin.analyzer'), (m, v) => ({ ...m, contributions: [{ ...m.contributions[0], id: v }] }), /plugin-manifest-contribution-id-invalid/],
  ['boxed capability', new String('cancel'), (m, v) => ({ ...m, contributions: [{ ...m.contributions[0], capabilities: [v] }] }), /plugin-manifest-capabilities-invalid/],
]) {
  assert.throws(() => validatePluginManifest(apply(validManifest(), value)), pattern, label);
}

for (const [label, value, apply, pattern] of [
  ['symbol plugin id', Symbol('vendor.plugin'), (m, v) => ({ ...m, id: v }), /plugin-manifest-id-invalid/],
  ['symbol target', Symbol('*'), (m, v) => ({ ...m, supportedTargets: [v] }), /plugin-manifest-supported-targets-invalid/],
  ['symbol capability', Symbol('cancel'), (m, v) => ({ ...m, contributions: [{ ...m.contributions[0], capabilities: [v] }] }), /plugin-manifest-capabilities-invalid/],
]) {
  assert.throws(() => validatePluginManifest(apply(validManifest(), value)), pattern, label);
}

{
  const registry = new PlatformPluginRegistry();
  assert.throws(() => registry.registerPlugin(
    validManifest({ id: ['vendor.plugin'] }),
    { 'vendor.plugin.analyzer': { analyze: async () => ({ ok: true }) } },
  ), /plugin-manifest-id-invalid/);
  assert.equal(registry.listPlugins().length, 0);
  assert.equal(registry.list('analyzer').length, 0);
}

console.log('issue-4874-plugin-manifest-string-boundary: PASS');
