import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const url = new URL('../../../js/names.js', import.meta.url);

// Keep this focused regression on the human-authored exact head after clean restacks.
test('weak legacy notes are candidates, not automatic strong-identity data', async () => {
  const source = await readFile(url, 'utf8');
  const loadAndImport = source.slice(source.indexOf('  load() {'), source.indexOf('  _saveFailure('));
  assert.match(loadAndImport, /this\.legacyCandidate = \{ sourceId: old, payload \}/);
  assert.doesNotMatch(loadAndImport, /if \(this\.save\(\)\) this\.migratedFrom/);
  assert.match(loadAndImport, /importLegacyCandidate/);
  assert.match(loadAndImport, /this\._applyPayload\(candidate\.payload\)/);
});
