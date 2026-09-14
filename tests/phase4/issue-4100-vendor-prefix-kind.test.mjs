import assert from 'node:assert/strict';
import { learnVendors, vendorOf } from '../../js/vendors.js';
import { buildAppMap } from '../../js/appmap.js';

function learnedHit(names, sample) {
  const learned = learnVendors(names);
  const hit = vendorOf(sample, learned);
  assert.ok(hit, `expected vendor hit for ${sample}`);
  return hit;
}

function fieldsFor(names) {
  return {
    classCount: names.length,
    classes: new Map(names.map((name) => [name, {
      name,
      superName: null,
      methods: [],
      classMethods: [],
      ivars: [],
      instanceSize: 0,
    }])),
  };
}

// Minimal #4100 regression: a known advertising prefix must preserve its
// semantic vendor kind instead of being flattened to the generic "sdk" kind.
{
  const names = ['GADBannerView', 'GADRequest', 'GADAdLoader'];
  const hit = learnedHit(names, 'GADBannerView');
  assert.equal(hit.vendor, 'Google Mobile Ads');
  assert.equal(hit.kind, 'ads');

  const map = buildAppMap({ fields: fieldsFor(names), strings: [] });
  for (const cls of map.classes) {
    assert.equal(cls.category, 'ads', `${cls.name} must remain in the ads subsystem`);
  }
  assert.equal(map.subsystems.find((entry) => entry.id === 'ads')?.classCount, 3);
}

// Other known ad namespaces follow the same semantic-kind contract.
for (const [names, sample, vendor] of [
  [['ISBannerAdapter', 'ISBaseAdUnit', 'ISConfig'], 'ISBannerAdapter', 'IronSource'],
  [['LPMReward', 'LPMBanner', 'LPMConfig'], 'LPMReward', 'IronSource LevelPlay'],
  [['MABanner', 'MARewarded', 'MAInterstitial'], 'MABanner', 'AppLovin MAX'],
]) {
  const hit = learnedHit(names, sample);
  assert.equal(hit.vendor, vendor);
  assert.equal(hit.kind, 'ads');
}

// Prefix seeds must retain the non-ad semantic kinds as well. They still map
// to AppMap's system bucket, while the exported vendor record retains the
// precise semantic kind for downstream policy and diagnostics.
for (const [names, sample, vendor, kind] of [
  [['FIRApp', 'FIRAnalytics', 'FIRConfig'], 'FIRApp', 'Firebase', 'analytics'],
  [['ABKUser', 'ABKCard', 'ABKSession'], 'ABKUser', 'Braze', 'marketing'],
  [['HSChat', 'HSSDK', 'HSSession'], 'HSChat', 'Helpshift', 'support'],
  [['RLMObject', 'RLMResults', 'RLMRealm'], 'RLMObject', 'Realm', 'library'],
]) {
  const hit = learnedHit(names, sample);
  assert.equal(hit.vendor, vendor);
  assert.equal(hit.kind, kind);
}

// Direct pattern classification and unknown clustered libraries are separate
// paths and must retain their existing semantics.
{
  assert.equal(vendorOf('IronSourceNetwork')?.kind, 'ads');
  const unknown = Array.from({ length: 12 }, (_, i) => `ZQXThing${i}`);
  assert.equal(learnedHit(unknown, 'ZQXThing3').kind, 'library');
}

console.log('issue-4100 vendor prefix kind: PASS');
