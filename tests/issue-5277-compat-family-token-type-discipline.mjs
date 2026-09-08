// Regression for #5277: familyFor() built its classification token with
// template interpolation, so Array/Object/boolean/number provenance values
// were String-coerced (`${['runtime']}` === 'runtime') and laundered into
// canonical Evidence families. Family authority now reads only primitive
// strings; malformed provenance falls back to the default family.
import assert from 'node:assert/strict';
import { legacyAiEvidenceToCanonical } from '../js/core/evidence/compat.js';

function familyOf(sourceTool, source, kind = 'observation') {
  return legacyAiEvidenceToCanonical({ id: 'ev-x', kind, sourceTool, source, status: 'supported' }).family;
}

// 1. The issue's scenario: structured sourceTool must NOT pick a family.
assert.equal(familyOf(['runtime'], null), 'SemanticEvidence', 'array sourceTool must not become RuntimeEvidence');
assert.equal(familyOf(['symbolic'], null), 'SemanticEvidence', 'array sourceTool must not become SymbolicEvidence');
assert.equal(familyOf(['signature'], null), 'SemanticEvidence', 'array sourceTool must not become SignatureEvidence');
assert.equal(familyOf(null, ['binary']), 'SemanticEvidence', 'array source must not become BinaryEvidence');
assert.equal(familyOf({ toString: () => 'symbolic' }, null), 'SemanticEvidence', 'object with toString must not become SymbolicEvidence');
assert.equal(familyOf(true, null), 'SemanticEvidence', 'boolean sourceTool must not classify');
assert.equal(familyOf(42, null), 'SemanticEvidence', 'number sourceTool must not classify');

// 2. Primitive-string classification is preserved for every family alias.
assert.equal(familyOf('runtime', null), 'RuntimeEvidence');
assert.equal(familyOf(null, 'runtime'), 'RuntimeEvidence');
assert.equal(familyOf('my-symbolic-tool', null), 'SymbolicEvidence');
assert.equal(familyOf(null, 'solver-service'), 'SymbolicEvidence');
assert.equal(familyOf('signature-scan', null), 'SignatureEvidence');
assert.equal(familyOf(null, 'fingerprint'), 'SignatureEvidence');
assert.equal(familyOf('type-deriver', null), 'TypeEvidence');
assert.equal(familyOf('cfg-builder', null), 'ControlFlowEvidence');
assert.equal(familyOf(null, 'branch-view'), 'ControlFlowEvidence');
assert.equal(familyOf('dataflow-pass', null), 'DataflowEvidence');
assert.equal(familyOf('decode-stage', null), 'DecodeEvidence');
assert.equal(familyOf(null, 'knowledge-pack'), 'KnowledgeEvidence');
assert.equal(familyOf(null, 'binary-loader'), 'BinaryEvidence');
assert.equal(familyOf('unrelated-tool', null), 'SemanticEvidence', 'unclassified strings keep the default family');

// 3. Mixed: primitive string kind still participates; structured kind is
//    rejected outright by the canonical node boundary (semanticKind contract).
assert.equal(familyOf(null, null, 'runtime-check'), 'RuntimeEvidence');
assert.throws(() => familyOf(null, null, ['runtime']), TypeError,
  'structured kind cannot reach family classification at all');

// 4. The record payload keeps the original (structured) value verbatim —
//    only classification is gated, provenance is preserved for audit.
{
  const node = legacyAiEvidenceToCanonical({ id: 'ev-p', kind: 'observation', sourceTool: ['runtime'], status: 'supported' });
  assert.deepEqual(node.payload.sourceTool, ['runtime']);
}

console.log('issue-5277 evidence compat family token type discipline: ok');
