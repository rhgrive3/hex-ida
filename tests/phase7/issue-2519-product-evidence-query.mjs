import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const evidenceUi = await readFile(new URL('../../js/ui/product-evidence-hardened.js', import.meta.url), 'utf8');
const evidenceAdapter = await readFile(new URL('../../js/analysis/query/product-evidence-adapter.js', import.meta.url), 'utf8');
const queryIndex = await readFile(new URL('../../js/analysis/query/index.js', import.meta.url), 'utf8');
const ux = await readFile(new URL('../../js/ux.js', import.meta.url), 'utf8');

assert.match(evidenceUi, /analysisQueries\.snapshot\(/, 'Evidence UI must bind one AnalysisSnapshot');
assert.match(evidenceUi, /analysisQueries\.evidence\(/, 'Evidence UI must consume the canonical evidence query');
assert.match(evidenceUi, /result\.page\?\.next/, 'Evidence UI must page at the producer boundary');
assert.doesNotMatch(evidenceUi, /app\?*\.symbols|runtimeEvidenceForApp|analyzeFunctionAt|rewriteProof|genericEvidenceStatus|provenanceStatus/, 'Evidence UI must not read source-specific live authorities');
assert.doesNotMatch(evidenceUi, /confidence\s*[><=]|proof.*confirmed|rewrite.*confirmed/i, 'Evidence UI must not manufacture verdicts from confidence or proof');

assert.match(evidenceAdapter, /createProductAdapter\(app\)/, 'Product evidence adapter must preserve the existing public adapter');
assert.match(evidenceAdapter, /functionEvidence\?\.\(address\)/, 'Symbol boundary evidence belongs in the query adapter');
assert.match(evidenceAdapter, /nameEvidence\?\.\(address\)/, 'Symbol name evidence belongs in the query adapter');
assert.match(evidenceAdapter, /runtimeEvidenceForApp\(app, address\)/, 'Runtime observations belong in the query adapter');
assert.match(evidenceAdapter, /value\?\.rewriteProof/, 'Rewrite proof belongs in the query adapter');
assert.match(evidenceAdapter, /canonicalVerdict\(/, 'Verdict projection must be producer-owned');
assert.match(evidenceAdapter, /page:\s*\{[\s\S]*next,/m, 'Evidence adapter must expose producer-aware pagination');

assert.match(queryIndex, /product-evidence-adapter\.js/, 'The public AnalysisQuery adapter must include the Product evidence boundary');
assert.match(ux, /installCanonicalProductEvidence\(window\.__app, installProductUI\(window\.__app\)\)/, 'Production bootstrap must install the canonical Evidence route after the hardened Product UI');

console.log('issue-2519-product-evidence-query: ok');
