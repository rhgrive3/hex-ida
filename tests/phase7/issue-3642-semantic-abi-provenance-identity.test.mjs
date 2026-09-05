import test from 'node:test';
import assert from 'node:assert/strict';

import { semanticAbiAdapter } from '../../js/analysis/semantic-function-base.js';
import { resolveABIPlugin } from '../../js/targets/abi/index.js';

const plugin = resolveABIPlugin({ architecture:'arm64', platform:'ios' });
assert.ok(plugin, 'canonical arm64/iOS ABI plugin must exist');

const canonicalOptions = Object.freeze({
  architectureId:'arm64',
  platformId:'ios',
  snapshotId:'snap-A',
  analyzerId:'analysis-core',
  analyzerVersion:'1',
  binaryId:'binary-A',
  sliceId:'slice-A',
  functionId:'fn-A',
});

function adapter(overrides = {}) {
  return semanticAbiAdapter(plugin, { ...canonicalOptions, ...overrides });
}

const identityFields = Object.freeze([
  ['snapshotId', 'snapshot-id'],
  ['analyzerId', 'analyzer-id'],
  ['analyzerVersion', 'analyzer-version'],
  ['binaryId', 'binary-id'],
  ['sliceId', 'slice-id'],
  ['functionId', 'function-id'],
]);

test('canonical primitive identities are preserved across all ABI audit projections', () => {
  const value = adapter();
  for (const [field] of identityFields) {
    assert.equal(value[field], canonicalOptions[field]);
    assert.equal(value.identity[field], canonicalOptions[field]);
    assert.equal(value.provenance[field], canonicalOptions[field]);
    assert.equal(value.invalidation[field], canonicalOptions[field]);
  }
});

test('structured and scalar non-string identities cannot alias canonical provenance', () => {
  for (const [field, label] of identityFields) {
    const canonical = canonicalOptions[field];
    const malformed = [
      [canonical],
      { value:canonical },
      new String(canonical),
      1,
      true,
      false,
      1n,
      '',
    ];
    for (const raw of malformed) {
      assert.throws(
        () => adapter({ [field]:raw }),
        new RegExp(`semantic-function-abi-${label}-invalid`),
        `${field} must reject ${Object.prototype.toString.call(raw)}`,
      );
    }
  }
});

test('identity validation never invokes caller-controlled coercion hooks', () => {
  for (const [field, label] of identityFields) {
    let calls = 0;
    const hostile = {
      toString() { calls += 1; return canonicalOptions[field]; },
      valueOf() { calls += 1; return canonicalOptions[field]; },
      [Symbol.toPrimitive]() { calls += 1; return canonicalOptions[field]; },
    };
    assert.throws(
      () => adapter({ [field]:hostile }),
      new RegExp(`semantic-function-abi-${label}-invalid`),
    );
    assert.equal(calls, 0, `${field} coercion hook must not run`);
  }
});

test('nullish optional identities remain absent and aliases use the same typed contract', () => {
  const nullish = semanticAbiAdapter(plugin, {
    architectureId:'arm64',
    platformId:'ios',
    snapshotId:null,
    analyzerId:undefined,
    analyzerVersion:null,
    binaryId:null,
    sliceId:undefined,
    functionId:null,
  });
  for (const [field] of identityFields) {
    assert.equal(nullish.identity[field], null);
    assert.equal(nullish.provenance[field], null);
    assert.equal(nullish.invalidation[field], null);
  }

  const viaAliases = semanticAbiAdapter(plugin, {
    architectureId:'arm64',
    platformId:'ios',
    analysisSnapshotId:'snap-alias',
    analysisAnalyzerId:'analyzer-alias',
    analysisAnalyzerVersion:'2',
  });
  assert.equal(viaAliases.identity.snapshotId, 'snap-alias');
  assert.equal(viaAliases.identity.analyzerId, 'analyzer-alias');
  assert.equal(viaAliases.identity.analyzerVersion, '2');

  assert.throws(
    () => semanticAbiAdapter(plugin, {
      architectureId:'arm64',
      platformId:'ios',
      analysisSnapshotId:['snap-alias'],
    }),
    /semantic-function-abi-snapshot-id-invalid/,
  );
});
