import assert from 'node:assert/strict';
import test from 'node:test';

import { judgeHint, providerAuthorityFailures, providerView } from '../../js/decompiler/phase8/providers.js';

function canonicalView(count = 300) {
  const regions = Array.from({ length:count }, (_, index) => ({
    regionKey:`region_${String(index).padStart(5, '0')}`,
    rootKind:'memory-root',
    nominal:null,
    accessCount:1,
    inductionStride:null,
    fields:[],
    padding:[],
    candidates:[{ kind:'struct', certainty:'supported', strideBytes:null, elementWidthBits:null }],
    conflicts:[],
  }));
  return providerView({
    get(name) {
      if (name === 'aggregates') return { regions };
      return null;
    },
  });
}

test('canonical provider views index region keys once across hint judging and authority checks', () => {
  const view = canonicalView();
  const hints = view.regions.map((region) => ({
    providerId:'perf.provider',
    status:'accepted',
    kind:'idiom',
    name:'fixture',
    regionKey:region.regionKey,
    certainty:'supported',
    evidence:['fixture'],
  }));
  const originalFind = Array.prototype.find;
  let regionFinds = 0;
  Array.prototype.find = function (...args) {
    if (this === view.regions) regionFinds += 1;
    return Reflect.apply(originalFind, this, args);
  };
  try {
    for (const hint of hints) assert.equal(judgeHint(hint, view).status, 'accepted');
    assert.deepEqual(providerAuthorityFailures({ hints }, view), []);
  } finally {
    Array.prototype.find = originalFind;
  }
  // The legacy implementation scans view.regions once in judgeHint and once
  // again in providerAuthorityFailures for every hint (600 full scans here).
  assert.ok(regionFinds <= 1, `canonical provider view performed ${regionFinds} region scans`);
});

test('foreign provider views retain live Array.find observation semantics', () => {
  const region = { regionKey:'before', conflicts:[], highestCertainty:'supported' };
  const view = { regions:[region] };
  assert.equal(judgeHint({ regionKey:'before', certainty:'supported' }, view).status, 'accepted');
  region.regionKey = 'after';
  assert.equal(judgeHint({ regionKey:'before', certainty:'supported' }, view).status, 'rejected');
  assert.equal(judgeHint({ regionKey:'after', certainty:'supported' }, view).status, 'accepted');
});
