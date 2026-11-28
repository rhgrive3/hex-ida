import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  libraryIndexFor, libraryInfoAt, isFoldable, classifyClassName, recognitionVendorContext,
} from '../js/analysis/library-code.js';
import { queryFunctionsFast } from '../js/ui/explorer-index.js';
import { vendorOf } from '../js/vendors.js';

function fakeApp({ names = {}, owners = {}, classes = [], renames = {} } = {}) {
  const funcs = Object.keys({ ...names, ...owners }).map((k) => BigInt(k)).sort((a, b) => (a < b ? -1 : 1));
  const renameMap = new Map(Object.entries(renames).map(([k, v]) => [BigInt(k).toString(), v]));
  const sortedNames = funcs.filter((a) => names[`0x${a.toString(16)}`] != null);
  const symbols = {
    gen: 1,
    funcs,
    renames: renameMap,
    addrs: sortedNames,
    names: sortedNames.map((a) => names[`0x${a.toString(16)}`]),
    nameAt(addr) { return renameMap.get(addr.toString()) || names[`0x${addr.toString(16)}`] || null; },
  };
  const ownerMap = new Map(Object.entries(owners).map(([k, v]) => [BigInt(k).toString(), v.map((className) => ({ className }))]));
  const fields = {
    classes: new Map(classes.map((n) => [n, { name: n }])),
    ownersOf(addr) { return (ownerMap.get(BigInt(addr).toString()) || []).slice(); },
  };
  return { symbols, fields };
}

test('SDK Objective-C methods, C++ std and C libraries are folded; app code is not', async () => {
  const app = fakeApp({
    names: {
      '0x1000': '-[GADBannerView loadRequest:]',
      '0x1010': '-[PlayerWallet addCoins:]',
      '0x1020': 'std::__1::basic_string<char>::append(char const*)',
      '0x1030': 'sqlite3_open',
      '0x1040': 'sub_1040',
      '0x1050': '-[CDSoundEngine masterGain]',
    },
    owners: { '0x1000': ['GADBannerView'], '0x1010': ['PlayerWallet'], '0x1050': ['CDSoundEngine'] },
    classes: ['GADBannerView', 'GADRequest', 'GADAdLoader', 'PlayerWallet', 'CDSoundEngine'],
  });
  assert.equal(libraryInfoAt(app, 0x1000n)?.vendor, 'Google Mobile Ads');
  assert.equal(libraryInfoAt(app, 0x1010n), null);
  assert.equal(libraryInfoAt(app, 0x1020n)?.kind, 'stdlib');
  assert.equal(libraryInfoAt(app, 0x1030n)?.vendor, 'SQLite');
  assert.equal(libraryInfoAt(app, 0x1040n), null, 'unnamed functions are never guessed');
  assert.equal(libraryInfoAt(app, 0x1050n)?.vendor, 'CocosDenshion');

  const index = await libraryIndexFor(app);
  assert.deepEqual([...index.folded].sort(), ['4096', '4128', '4144', '4176']);
  assert.equal(index.foldedCount, 4);
  assert.equal(await libraryIndexFor(app), index, 'cached per symbols generation');
});

test('user-renamed functions and IMPs shared with app classes stay visible', () => {
  const app = fakeApp({
    names: { '0x2000': '-[GADBannerView foo]', '0x2010': '-[GADBannerView bar]' },
    owners: { '0x2000': ['GADBannerView'], '0x2010': ['GADBannerView', 'PlayerWallet'] },
    renames: { '0x2000': 'myRenamed' },
  });
  assert.equal(libraryInfoAt(app, 0x2000n), null);
  assert.equal(libraryInfoAt(app, 0x2010n), null);
});

test('low-confidence cluster prefixes are labelled but not folded', () => {
  const classes = Array.from({ length: 12 }, (_, i) => `ZQX${'Abcdefghijkl'[i]}Thing`);
  const app = fakeApp({ names: { '0x3000': `-[${classes[0]} run]` }, owners: { '0x3000': [classes[0]] }, classes });
  const info = libraryInfoAt(app, 0x3000n);
  assert.equal(info?.confidence, 'low');
  assert.equal(isFoldable(info), false);
  assert.equal(classifyClassName(app, 'PlayerWallet'), null);
});

test('recognition context reports a vendor only for folded code', () => {
  const app = fakeApp({ names: { '0x4000': '-[GADBannerView x]', '0x4010': '-[Hero hp]' }, owners: { '0x4000': ['GADBannerView'], '0x4010': ['Hero'] }, classes: ['GADBannerView', 'GADRequest', 'GADAdLoader', 'Hero'] });
  assert.equal(recognitionVendorContext(app, 0x4000n).vendor.classification, 'SDK');
  assert.deepEqual(recognitionVendorContext(app, 0x4010n), { notKnownVendor: true });
});

test('explorer fast query honours excludeSet', async () => {
  const app = fakeApp({ names: { '0x5000': 'a_fn', '0x5010': 'b_fn', '0x5020': 'c_fn' } });
  const all = await queryFunctionsFast(app, 'fn', { limit: 10 });
  const some = await queryFunctionsFast(app, 'fn', { limit: 10, excludeSet: new Set(['20496']) });
  assert.equal(all.total, 3);
  assert.equal(some.total, 2);
  assert.ok(!some.items.some((x) => x.addr === 0x5010n));
});

test('Meta FB-prefixed ad classes are not labelled Google Mobile Ads', () => {
  assert.equal(vendorOf('FBInterstitialAd')?.vendor, 'Meta Audience Network');
  assert.equal(vendorOf('FBAdView')?.vendor, 'Meta Audience Network');
  assert.equal(vendorOf('GADInterstitialAd')?.vendor, 'Google Mobile Ads');
});

test('renderExplorer hides and disables libraryChip when filterMode is saved or edited', () => {
  const productBase = fs.readFileSync(new URL('../js/ui/product-base.js', import.meta.url), 'utf8');
  assert.match(
    productBase,
    /const libraryFilterApplicable = filterMode === 'all';[\s\S]*?libraryChip\.hidden = !libraryFilterApplicable;[\s\S]*?libraryChip\.disabled = !libraryFilterApplicable;/
  );
  assert.match(productBase, /const setHideLibrary = \(next\) => \{\s*\n\s*if \(filterMode !== 'all'\) return;/);
});
