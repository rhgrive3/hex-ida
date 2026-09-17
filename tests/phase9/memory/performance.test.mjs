import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stableDigest } from '../../../js/core/identity/index.js';
import { measureMemoryCase } from './fixtures.mjs';
const locks=JSON.parse(fs.readFileSync(new URL('../fixtures/memory-taint-performance-locks.json',import.meta.url),'utf8'));
test('P-SYMMEM: locked nine cases measured through the production executor (Node only)',()=>{
  const lock=locks.profiles['P-SYMMEM'];
  assert.equal(stableDigest(lock.fixtureSet.descriptor),lock.fixtureSet.stableDigest);
  assert.equal(lock.fixtureSet.descriptor.caseCount,9);
  const cases=lock.fixtureSet.descriptor.cases.map(measureMemoryCase);
  assert.equal(cases.length,9);
  for(const row of cases) for(const threshold of lock.blockingThresholds) {
    assert.equal(threshold.operator,'<=');
    assert.ok(Number.isFinite(row.metrics[threshold.metric]),`${row.caseId}: missing ${threshold.metric}`);
    assert.ok(row.metrics[threshold.metric]<=threshold.threshold,`${row.caseId}: ${threshold.metric}=${row.metrics[threshold.metric]}`);
  }
  const record={profile:'P-SYMMEM',fixtureSet:lock.fixtureSet,thresholds:lock.blockingThresholds,environment:{runtime:process.version,platform:process.platform,architecture:process.arch},
    metricAggregation:'maximum count per constituent query; wallClock is measured case elapsed time including checks/replay',
    officialCollector:'NOT RUN',iPadWebKit:'NOT RUN',cases};
  if(process.env.HEX_002_METRICS_DIR) {
    fs.mkdirSync(process.env.HEX_002_METRICS_DIR,{recursive:true});
    fs.writeFileSync(path.join(process.env.HEX_002_METRICS_DIR,'P-SYMMEM.node.json'),JSON.stringify(record,null,2)+'\n');
  }
  console.log(`P-SYMMEM_NODE ${JSON.stringify(cases.map(row=>({caseId:row.caseId,metrics:row.metrics})))}`);
});
