import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractHexVariants,
  extractFunctionSources,
  assembleRawFunctionText,
  buildTranslationUnitVariant,
  sha256,
} from '../../reports/investigations/codefuse-functionality/harness/hex-source.mjs';
import { SOURCE_VARIANTS } from '../../reports/investigations/codefuse-functionality/harness/constants.mjs';

function fixtureArtifact() {
  return {
    schema: 'hex-public-benchmark-subject/v1',
    inputSha256: 'a'.repeat(64),
    functions: [
      { address: '4096', name: 'alpha', state: 'PASS', completeness: 'complete', pseudocode: 'int alpha(void)\n{\n return 1;\n}' },
      { address: '8192', name: 'beta', state: 'PASS', completeness: 'partial', pseudocode: 'int beta(void)\n{\n return alpha();\n}' },
      { address: '12288', name: 'gamma', state: 'CRASH', reason: 'decompile-crash', pseudocode: null },
    ],
  };
}

test('raw function text and translation unit are distinct, labelled artifacts', () => {
  const variants = extractHexVariants(fixtureArtifact());
  assert.equal(variants.functionCount, 2);
  assert.equal(variants.raw.variant, SOURCE_VARIANTS.rawFunctionText);
  assert.equal(variants.translationUnit.variant, SOURCE_VARIANTS.translationUnit);
  assert.notEqual(SOURCE_VARIANTS.rawFunctionText, SOURCE_VARIANTS.translationUnit);

  // Raw text is byte-exact function-scoped concatenation with metadata headers.
  assert.match(variants.raw.text, /\/\* raw-function-text: address=4096/);
  assert.match(variants.raw.text, /int alpha\(void\)/);
  assert.match(variants.raw.text, /int beta\(void\)/);
  assert.equal(variants.raw.sha256, sha256(variants.raw.text));

  if (variants.translationUnit.available) {
    assert.notEqual(variants.translationUnit.sha256, variants.raw.sha256);
    assert.doesNotMatch(variants.translationUnit.text, /raw-function-text: address=/,
      'the TU variant must not be the raw concatenation');
  } else {
    assert.match(variants.translationUnit.reason, /translation-unit/);
    assert.equal(variants.translationUnit.text, null);
  }
});

test('assembly is sorted by numeric address and stable', () => {
  const artifact = fixtureArtifact();
  artifact.functions.unshift({ address: '2048', name: 'zero', state: 'PASS', completeness: 'complete', pseudocode: 'void zero(void) {}' });
  const { sources } = extractFunctionSources(artifact);
  assert.deepEqual(sources.map((fn) => fn.name), ['zero', 'alpha', 'beta']);
  const text = assembleRawFunctionText(sources);
  assert.match(text, /address=2048[\s\S]*address=4096[\s\S]*address=8192/);
});

test('functions without pseudocode are recorded, never silently dropped', () => {
  const { sources, excluded } = extractFunctionSources(fixtureArtifact());
  assert.equal(sources.length, 2);
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].name, 'gamma');
  assert.equal(excluded[0].state, 'CRASH');
  assert.equal(excluded[0].reason, 'decompile-crash');
});

test('translation unit variant reports unavailability instead of substituting raw text', () => {
  const variant = buildTranslationUnitVariant([]);
  assert.equal(typeof variant.available, 'boolean');
  if (!variant.available) {
    assert.equal(variant.text, null);
    assert.ok(variant.reason);
  }
});

test('repaired source is a separate variant from the raw source', async () => {
  const { applyPatch } = await import('../../reports/investigations/codefuse-functionality/harness/repair.mjs');
  const raw = 'int a(void)\n{\n return 1;\n}\n';
  const patched = applyPatch(raw, { name: 'edit_code_block', arguments: { search_block: 'return 1;', replace_block: 'return 2;' } });
  assert.equal(patched.ok, true);
  assert.notEqual(patched.source, raw);
  assert.equal(raw, 'int a(void)\n{\n return 1;\n}\n', 'the raw source must not be mutated');
  assert.notEqual(SOURCE_VARIANTS.repaired, SOURCE_VARIANTS.rawFunctionText);
});
