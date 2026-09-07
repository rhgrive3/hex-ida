// Regression for #5949: coverage constrains matched-partial authority, so two
// language metadata identities with different authoritative coverage sets must
// not share a digest.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createLanguageMetadataIdentity,
  createLanguageMetadataRecord,
  createLanguageMetadataResult,
  isLanguageRecordAuthoritative,
} from '../js/metadata/provider.js';

const base = {
  verdict: 'matched-partial',
  providerId: 'swift',
  providerVersion: '1',
  ecosystem: 'swift',
  binaryIdentity: 'binary-digest-5949',
};

test('#5949 different coverage sets produce different identity digests', () => {
  const identityA = createLanguageMetadataIdentity({ ...base, coverage: { entityIds: ['class_A'] } });
  const identityB = createLanguageMetadataIdentity({ ...base, coverage: { entityIds: ['class_B'] } });
  assert.equal(identityA.verdict, 'matched-partial');
  assert.notEqual(identityA.digest, identityB.digest);
});

test('#5949 set-equivalent coverage selectors canonicalize before digesting', () => {
  const listCases = [
    ['entityIds', ['A', 'B']],
    ['recordKinds', ['method', 'type']],
    ['addresses', ['0x1000', '0x2000']],
    ['buildIdentities', ['build-A', 'build-B']],
    ['modules', ['ModuleA', 'ModuleB']],
  ];
  for (const [selector, values] of listCases) {
    const [firstValue, secondValue] = values;
    const first = createLanguageMetadataIdentity({
      ...base,
      coverage: { [selector]: [` ${secondValue} `, firstValue, secondValue] },
    });
    const second = createLanguageMetadataIdentity({
      ...base,
      coverage: { [selector]: [firstValue, ` ${secondValue} `] },
    });
    assert.equal(first.digest, second.digest, `${selector} order/trim/duplicates are set-equivalent`);
    assert.deepEqual(first.coverage[selector], [...values].sort(), `${selector} is stored canonically`);
  }

  const scalarA = createLanguageMetadataIdentity({
    ...base,
    coverage: { module: ' ModuleA ', ecosystem: ' swift ' },
  });
  const scalarB = createLanguageMetadataIdentity({
    ...base,
    coverage: { module: 'ModuleA', ecosystem: 'swift' },
  });
  assert.equal(scalarA.digest, scalarB.digest, 'trim-equivalent scalar selectors share identity');
  assert.deepEqual(scalarA.coverage, { module: 'ModuleA', ecosystem: 'swift' });
});

test('#5949 identical inputs keep identical digests', () => {
  const first = createLanguageMetadataIdentity({ ...base, coverage: { entityIds: ['class_A'], recordKinds: ['type'] } });
  const second = createLanguageMetadataIdentity({ ...base, coverage: { entityIds: ['class_A'], recordKinds: ['type'] } });
  assert.equal(first.digest, second.digest);
});

test('#5949 coverage still gates matched-partial authority per record', () => {
  const identity = createLanguageMetadataIdentity({ ...base, coverage: { entityIds: ['swift:type:ClassA'] } });
  const result = createLanguageMetadataResult({
    identity,
    completeness: { complete: true },
  });
  const matching = createLanguageMetadataRecord({
    kind: 'type',
    entityId: 'swift:type:ClassA',
    providerId: 'swift',
    providerVersion: '1',
    ecosystem: 'swift',
    descriptor: { layer: 'nominal', claim: { name: 'ClassA' } },
  });
  const foreign = createLanguageMetadataRecord({
    kind: 'type',
    entityId: 'swift:type:ClassB',
    providerId: 'swift',
    providerVersion: '1',
    ecosystem: 'swift',
    descriptor: { layer: 'nominal', claim: { name: 'ClassB' } },
  });
  assert.equal(isLanguageRecordAuthoritative(result, matching), true);
  assert.equal(isLanguageRecordAuthoritative(result, foreign), false);
});
