import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalClaimVerdict, createProductSurfaceQueries } from '../js/analysis/query/product-surface.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

assert.equal(canonicalClaimVerdict({ confidence:0.99 }), 'unverified');
assert.equal(canonicalClaimVerdict({ confirmed:true, confidence:1 }), 'unverified');
assert.equal(canonicalClaimVerdict({ verdict:'confirmed', confidence:0.01 }), 'confirmed');
assert.equal(canonicalClaimVerdict({ evidenceVerdict:'contradicted', confidence:1 }), 'contradicted');

const snapshot = Object.freeze({ snapshotId:'snap-2528', analysisEpoch:7 });
const app = {
  autoReport:{ report:{ findings:[
    { id:'legacy-high-confidence', title:'High confidence only', confidence:0.99 },
    { claimId:'canonical-confirmed', title:'Canonical', verdict:'confirmed', confidence:0.1, evidenceIds:['ev-1'] },
    { claimId:'canonical-contradicted', title:'Contradicted', verdict:'contradicted', contradictions:['ev-2'] },
  ] } },
  analysisQueries:{ snapshot:async () => snapshot },
};
const queries = createProductSurfaceQueries(app);
const page1 = await queries.claims(snapshot, {}, { offset:0, limit:2 });
assert.equal(page1.value.length, 2);
assert.equal(page1.value[0].verdict, 'unverified', 'confidence-only legacy finding must stay unverified');
assert.equal(page1.value[1].verdict, 'confirmed');
assert.equal(page1.page.next, 2, 'claim pagination must be producer/query-owned');
const page2 = await queries.claims(snapshot, {}, { offset:2, limit:2 });
assert.equal(page2.value.length, 1);
assert.equal(page2.value[0].verdict, 'contradicted');
assert.deepEqual(page2.value[0].contradictions, ['ev-2']);

const hardened = fs.readFileSync(path.join(root, 'js/ui/product-hardened.js'), 'utf8');
const ux = fs.readFileSync(path.join(root, 'js/ux.js'), 'utf8');
const surface = fs.readFileSync(path.join(root, 'js/analysis/query/product-surface.js'), 'utf8');
assert.match(ux, /from '\.\/ui\/product-hardened\.js'/);
assert.match(hardened, /const targetClaims =/);
assert.match(hardened, /renderCanonicalClaims\(app, router, route, meta, queries\)/);
assert.match(hardened, /queries\.claims\(snapshot,/);
const claimsRenderer = hardened.slice(hardened.indexOf('function renderCanonicalClaims'), hardened.indexOf('function linkedController'));
assert.doesNotMatch(claimsRenderer, /autoReport|report\.findings|report\.results|report\.goals/);
assert.doesNotMatch(claimsRenderer, /confidence\s*>|confirmed\s*\?/);
assert.match(surface, /const source = report\?\.findings \|\| report\?\.results \|\| report\?\.goals \|\| \[\]/);
assert.match(surface, /verdict:canonicalClaimVerdict\(item\)/);
assert.match(surface, /async claims\(snapshot, query = \{\}, page = \{\}, options = \{\}\)/);
assert.match(surface, /await assertCurrentSnapshot\(app, snapshot, options\)/);
console.log('issue #2528 canonical claims authority regression passed');
