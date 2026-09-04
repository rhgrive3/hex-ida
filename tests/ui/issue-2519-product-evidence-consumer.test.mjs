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

// #4863: reaching the local render cap is not by itself evidence of incompleteness.
assert.match(
  evidenceUi,
  /finalResult\?\.completeness !== 'complete' \|\| finalResult\?\.page\?\.next != null \|\| rows\.length > MAX_RENDERED_EVIDENCE/,
  'partial-note authority must come from producer incompleteness/continuation or proven local truncation',
);
assert.doesNotMatch(
  evidenceUi,
  /rows\.length\s*>=\s*MAX_RENDERED_EVIDENCE/,
  'exactly filling the local render cap must not manufacture a partial result',
);

const shouldShowPartial = (rowCount, result) =>
  result?.completeness !== 'complete' || result?.page?.next != null || rowCount > 5_000;
assert.equal(shouldShowPartial(4_999, { completeness:'complete', page:{ next:null } }), false);
assert.equal(shouldShowPartial(5_000, { completeness:'complete', page:{ next:null } }), false);
assert.equal(shouldShowPartial(5_000, { completeness:'complete', page:{ next:5_000 } }), true);
assert.equal(shouldShowPartial(5_001, { completeness:'complete', page:{ next:null } }), true);
assert.equal(shouldShowPartial(100, { completeness:'partial', page:{ next:null } }), true);
assert.equal(shouldShowPartial(100, { completeness:'truncated', page:{ next:null } }), true);

console.log('issue-2519-product-evidence-consumer: ok');
