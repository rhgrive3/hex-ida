import assert from 'node:assert/strict';
import test from 'node:test';

import { InvestigationService } from '../../js/analysis/investigation-service.js';

// #5801: with no string-hinted sections, collectStrings() fell back to
// scanning only currentRegion. A single-region complete backend result was
// then published as a global complete string index (and cached in
// app.stringIndex), hiding every other region's strings for the epoch.

function stringApp(regions, currentRegion) {
  const state = new Map([
    ['regions', regions],
    ['currentRegion', currentRegion ?? regions[0]],
  ]);
  const scanned = [];
  return {
    app:{
      backend:{
        gen:1,
        strings({ regionId }) {
          scanned.push(regionId);
          return Promise.resolve({ complete:true, capped:false, scannedBytes:16, results:[] });
        },
      },
      store:{ get:(key) => state.get(key) },
      stringIndex:null,
    },
    scanned,
  };
}

const r1 = { id:'r1', section:'__text', vmAddr:0x1000n, size:16n, exec:true };
const r2 = { id:'r2', section:'__data', vmAddr:0x2000n, size:16n, exec:false };

test('a currentRegion-only fallback scan must not publish global completeness (#5801)', async () => {
  const { app, scanned } = stringApp([r1, r2], r1);
  const service = new InvestigationService(app);
  const rows = await service.collectStrings();
  assert.deepEqual(scanned.sort(), ['r1', 'r2'], 'all scannable regions must be scanned when no string-hinted target exists');
  assert.equal(rows.complete, true, 'scanning every region honestly is complete');
  assert.deepEqual([...rows.unscannedRegions], []);
  assert.equal(app.stringIndex, rows, 'a genuinely complete scan is cacheable');
});

test('a region the budget cannot cover stays honestly partial (#5801)', async () => {
  const big = { id:'big', section:'__data', vmAddr:0x3000n, size:BigInt(200 * 1024 * 1024), exec:false };
  const { app, scanned } = stringApp([r1, big], r1);
  const service = new InvestigationService(app);
  const rows = await service.collectStrings();
  assert.ok(scanned.includes('r1'), 'the current region is scanned first');
  assert.equal(rows.complete, false, 'an unscanned region must keep the result partial');
  assert.ok(rows.unscannedRegions.includes('big'), 'the uncovered region is reported');
  assert.equal(app.stringIndex, null, 'a partial scan is never cached as the global complete index');
});

test('string-hinted targets are prioritized but do not exclude other regions (#5801)', async () => {
  const hinted = { id:'cstring', section:'__cstring', vmAddr:0x4000n, size:16n, exec:true };
  const plain = { id:'plain', section:'__text', vmAddr:0x5000n, size:16n, exec:true };
  const { app, scanned } = stringApp([hinted, plain], hinted);
  const service = new InvestigationService(app);
  const rows = await service.collectStrings();
  assert.deepEqual(scanned, ['cstring', 'plain'], 'section hints only prioritize; every scannable region remains in the complete denominator');
  assert.equal(rows.complete, true);
});

test('changing currentRegion cannot change complete global coverage (#5801)', async () => {
  const first = stringApp([r1, r2], r1);
  const second = stringApp([r1, r2], r2);
  const firstRows = await new InvestigationService(first.app).collectStrings();
  const secondRows = await new InvestigationService(second.app).collectStrings();
  assert.deepEqual(first.scanned, ['r1', 'r2']);
  assert.deepEqual(second.scanned, ['r1', 'r2']);
  assert.equal(firstRows.complete, secondRows.complete);
  assert.deepEqual([...firstRows], [...secondRows]);
  assert.deepEqual(firstRows.unscannedRegions, secondRows.unscannedRegions);
});
;
