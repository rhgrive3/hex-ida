// Synthetic bookkeeping packets exercise admission contracts, NOT a trial.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { protocolInput } from './benchmark-fixture.mjs';
import { normalizePostBManifest, postBCells, bindPostBProtocol } from '../../js/analysis/benchmark/post-b.js';
import { admitCompetitiveProtocol } from '../../js/analysis/benchmark/competitive-protocol.js';
import { workFor } from './helpers.mjs';
import { checkU64Add7 } from '../../tools/competitive-arm64/source-oracle.mjs';
const bytes = fs.readFileSync(new URL('../competitive-arm64/manifest/post-b.json', import.meta.url));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const raw = () => JSON.parse(bytes);
function fixture() {
  const manifest = normalizePostBManifest(raw()), input = protocolInput(), first = input.cases[0];
  input.cases = manifest.cases.flatMap(sample => manifest.toolchainSlots.map(slot => {
    const recipe = manifest.recipes.find(row => row.id === sample.recipeId);
    return { ...first, caseId: `${sample.id}@${slot.id}`, sourceSha256: recipe.sourceSha256,
      language: recipe.language, platform: recipe.platform === 'darwin' ? 'apple-macos' : recipe.platform };
  }));
  const hashes = { manifestSha256: sha(bytes), metricSha256: Object.fromEntries(manifest.metrics.map(row => [row.id, sha(JSON.stringify(row))])) };
  return { manifest, input, hashes };
}
test('full Post-B denominator binds the existing protocol but cannot gain admission from a test packet', async t => {
  const { manifest, input, hashes } = fixture(), packet = bindPostBProtocol(manifest, input, hashes);
  assert.equal(packet.protocol.cases.length, 24);
  assert.equal(packet.cells.length, postBCells(manifest).length);
  assert.ok(packet.cells.every(row => row.state === 'UNMEASURED' && row.value === null));
  assert.equal(packet.victoryEstablished, false);
  const admission = await admitCompetitiveProtocol(packet.protocol, { work: workFor(t) });
  assert.equal(admission.status, 'NOT-ADMITTED');
  assert.ok(admission.obligations.some(reason => reason.includes('twin-not-admitted')));
});
test('missing case, replaced source and ambiguous microcase names cannot shrink the denominator', () => {
  const f = fixture();
  assert.throws(() => bindPostBProtocol(f.manifest, { ...f.input, cases: f.input.cases.slice(1) }, f.hashes), /incomplete/);
  f.input.cases[0].sourceSha256 = '0'.repeat(64);
  assert.throws(() => bindPostBProtocol(f.manifest, f.input, f.hashes), /source-mismatch/);
  const bad = raw(); bad.cases[0].id += '@nested';
  assert.throws(() => normalizePostBManifest(bad), /denominator/);
});
test('the independent finite-observation checker rejects a known wrong wrap result', () => {
  assert.equal(checkU64Add7([{ input: '18446744073709551615', output: '6' }]).status, 'verified');
  assert.equal(checkU64Add7([{ input: '18446744073709551615', output: '7' }]).status, 'rejected');
  assert.throws(() => checkU64Add7([{ input: '18446744073709551616', output: '7' }]), /width/);
});
