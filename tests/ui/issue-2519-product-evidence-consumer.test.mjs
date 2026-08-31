import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const evidenceUi = await readFile(new URL('../../js/ui/product-evidence-hardened.js', import.meta.url), 'utf8');
const ux = await readFile(new URL('../../js/ux.js', import.meta.url), 'utf8');

assert.match(evidenceUi, /analysisQueries\.snapshot\(/, 'Evidence UI must bind one AnalysisSnapshot');
assert.match(evidenceUi, /analysisQueries\.evidence\(/, 'Evidence UI must consume the canonical evidence query');
assert.match(evidenceUi, /result\.page\?\.next/, 'Evidence UI must page at the producer boundary');
assert.doesNotMatch(evidenceUi, /app\?*\.symbols|app\?*\.autoReport|runtimeEvidenceForApp|analyzeFunctionAt|rewriteProof|genericEvidenceStatus|provenanceStatus/, 'Evidence UI must not read source-specific live authorities');
assert.doesNotMatch(evidenceUi, /confidence\s*[><=]|proof.*confirmed|rewrite.*confirmed/i, 'Evidence UI must not manufacture verdicts from confidence or proof');
assert.match(ux, /installCanonicalProductEvidence\(window\.__app, installProductUI\(window\.__app\)\)/, 'Production bootstrap must install the canonical Evidence route after the hardened Product UI');

console.log('issue-2519-product-evidence-consumer: ok');
