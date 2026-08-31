import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const evidenceAdapter = await readFile(new URL('../../js/analysis/query/product-evidence-adapter.js', import.meta.url), 'utf8');
const queryIndex = await readFile(new URL('../../js/analysis/query/index.js', import.meta.url), 'utf8');

assert.match(evidenceAdapter, /createProductAdapter\(app\)/, 'Product evidence adapter must preserve the existing public adapter');
assert.match(evidenceAdapter, /functionEvidence\?\.\(address\)/, 'Symbol boundary evidence belongs in the query adapter');
assert.match(evidenceAdapter, /nameEvidence\?\.\(address\)/, 'Symbol name evidence belongs in the query adapter');
assert.match(evidenceAdapter, /runtimeEvidenceForApp\(app, address\)/, 'Runtime observations belong in the query adapter');
assert.match(evidenceAdapter, /value\?\.rewriteProof/, 'Rewrite proof belongs in the query adapter');
assert.match(evidenceAdapter, /canonicalVerdict\(/, 'Verdict projection must be producer-owned');
assert.match(evidenceAdapter, /base\.evidence\(/, 'Legacy evidence sources must remain behind AnalysisQueryAPI.evidence');
assert.match(evidenceAdapter, /page:\s*\{[\s\S]*next,/m, 'Evidence adapter must expose producer-aware pagination');
assert.doesNotMatch(evidenceAdapter, /proof.*['"]confirmed['"]/i, 'Rewrite proof must not be promoted to confirmed by adapter policy');

assert.match(queryIndex, /product-evidence-adapter\.js/, 'The public AnalysisQuery adapter must include the Product evidence boundary');

console.log('issue-2519-product-evidence-query: ok');
