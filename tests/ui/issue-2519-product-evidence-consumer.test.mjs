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

// #4863: the local render cap is not evidence that the producer is incomplete.
assert.match(
  evidenceUi,
  /finalResult\?\.completeness !== 'complete' \|\| finalResult\?\.page\?\.next != null/,
  'partial-note authority must come from producer completeness or continuation metadata',
);
assert.doesNotMatch(
  evidenceUi,
  /rows\.length\s*>=\s*MAX_RENDERED_EVIDENCE/,
  'exactly filling the local render cap must not manufacture a partial result',
);

const producerSaysPartial = (result) => result?.completeness !== 'complete' || result?.page?.next != null;
assert.equal(producerSaysPartial({ completeness:'complete', page:{ next:null }, rows:4999 }), false);
assert.equal(producerSaysPartial({ completeness:'complete', page:{ next:null }, rows:5000 }), false);
assert.equal(producerSaysPartial({ completeness:'complete', page:{ next:5000 }, rows:5000 }), true);
assert.equal(producerSaysPartial({ completeness:'partial', page:{ next:null }, rows:100 }), true);
assert.equal(producerSaysPartial({ completeness:'truncated', page:{ next:null }, rows:100 }), true);

console.log('issue-2519-product-evidence-consumer: ok');
