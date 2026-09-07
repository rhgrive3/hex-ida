import assert from 'node:assert/strict';
import { createDebugIdentity, isAuthoritative } from '../../js/analysis/debug/provider.js';
import { createProductSurfaceQueries } from '../../js/analysis/query/product-surface.js';

const valid=createDebugIdentity({verdict:'matched-authoritative',providerId:'pdb',providerVersion:'1',expected:'build-A',observed:'build-A',method:'guid-age'});
assert.equal(isAuthoritative(valid),true);
for (const field of ['verdict','providerId','providerVersion','expected','observed','method']) {
  const input={verdict:'matched-authoritative',providerId:'pdb',providerVersion:'1',expected:'build-A',observed:'build-A',method:'guid-age'};
  input[field]=[input[field]];
  assert.throws(()=>createDebugIdentity(input),TypeError,`debug ${field} must reject array coercion`);
}

let analyzed=null;
const snapshot={snapshotId:'s',analysisEpoch:1};
const app={
  analysisQueries:{snapshot:async()=>snapshot},
  store:{get(key){if(key==='regions')return []; if(key==='sliceIndex')return 0; return null;}},
  backend:{gen:1},
  autoReport:{report:{findings:[{claimId:'claim-1',verdict:'confirmed'}]}},
  recognition:{records:[]},
  ensureRecognition:async()=>null,
  analyzeFunctionAt:async(address)=>{analyzed=address; return {model:null};},
};
const q=createProductSurfaceQueries(app);
await assert.rejects(()=>q.claims(snapshot,{claimId:['claim-1']}),/analysis-product-claim-id-invalid/);
await assert.rejects(()=>q.claims(snapshot,{verdict:[['confirmed']]}),/analysis-product-verdict-invalid/);
for (const bad of [['0x1000'],{toString(){return '0x1000';}},true]) await assert.rejects(()=>q.classification(snapshot,bad),/analysis-product-function-id-invalid/);
await q.classification(snapshot,'0x1000');
assert.equal(analyzed,0x1000n);
const strings=await q.strings(snapshot,{text:['needle']},{offset:0,limit:10});
assert.equal(strings.value.length,0,'non-string string filter must not be coerced into a search term');
console.log('issues-2875-2877-strict-inputs: PASS');
