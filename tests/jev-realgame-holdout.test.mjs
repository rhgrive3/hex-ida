import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  buildCriteria,
  deterministicLexicalPick,
  isGoldMatch,
  validateResponse,
} from '../scripts/run-jev-realgame-eval.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_DIR = path.join(ROOT, 'reports/investigations/jev-real-game-freeform-holdout');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('holdout manifest and case hashes are verified and frozen', () => {
  const manifestPath = path.join(REPORT_DIR, 'holdout-manifest.json');
  const casesPath = path.join(REPORT_DIR, 'holdout-cases.json');
  const criteriaPath = path.join(REPORT_DIR, 'evaluation-criteria.json');

  assert.ok(fs.existsSync(manifestPath), 'manifest must exist');
  assert.ok(fs.existsSync(casesPath), 'cases must exist');
  assert.ok(fs.existsSync(criteriaPath), 'criteria must exist');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const casesBytes = fs.readFileSync(casesPath);
  const actualCaseSha = sha256(casesBytes);

  assert.equal(actualCaseSha, manifest.caseSha256, 'case hash must match manifest');
  assert.equal(manifest.caseCount, 70, 'total case count must be exactly 70');
  assert.equal(manifest.answerableCases, 55, 'answerable cases must be 55');
  assert.equal(manifest.abstainCases, 15, 'abstain cases must be 15');

  const currentRouterSha = sha256(fs.readFileSync(path.join(ROOT, 'js/pinpoint.js')));
  // The historical manifest stays immutable. A contributes two exact C++
  // safeguards; pinpoint-jev-probe-audit verifies their complete reverse delta.
  assert.equal(manifest.routerFrozenSha256, '62f3c7eb561218527db146b658f3394a1a6e12469b465b88b848e3f8cddb2173');
  assert.equal(currentRouterSha, 'c94629ce03c6da9190c944928fa26ad8d467f812f4bbb545224b8a6423207d4e');
});

test('case format integrity: queries, golds, and ground truth citations', () => {
  const cases = JSON.parse(fs.readFileSync(path.join(REPORT_DIR, 'holdout-cases.json'), 'utf8'));
  assert.equal(cases.length, 70);

  const ids = new Set();
  for (const c of cases) {
    assert.ok(c.id, 'case must have id');
    assert.ok(!ids.has(c.id), `duplicate id ${c.id}`);
    ids.add(c.id);

    assert.ok(c.query && typeof c.query === 'string', `${c.id} query must be string`);
    assert.ok(c.binary === 'openttd' || c.binary === 'openmw', `${c.id} binary must be openttd or openmw`);
    assert.equal(c.mode, 'partial');

    if (c.gold) {
      assert.ok(c.gold.class && typeof c.gold.class === 'string', `${c.id} gold must have class`);
      assert.ok(c.gold.field && typeof c.gold.field === 'string', `${c.id} gold must have field`);
      assert.ok(c.groundTruthSource, `${c.id} gold must cite objective ground truth source`);
    } else {
      assert.ok(c.abstainReason, `${c.id} abstain case must provide reason`);
    }
  }
});

test('candidate criteria builder supports Arms B, C, D, E', () => {
  const sample = [
    { className: 'Vehicle', fieldName: 'cur_speed', type: 'uint16_t', offset: 306, category: 'physics' },
    { className: 'CompanyProperties', fieldName: 'money', type: 'Money', offset: 152, category: 'accounting' },
  ];

  const armB = buildCriteria(sample, 'B');
  assert.equal(armB.c0, 'cur_speed');
  assert.equal(armB.c1, 'money');

  const armC = buildCriteria(sample, 'C');
  assert.equal(armC.c0, 'Vehicle.cur_speed');
  assert.equal(armC.c1, 'CompanyProperties.money');

  const armD = buildCriteria(sample, 'D');
  assert.equal(armD.c0, 'class: Vehicle | field: cur_speed');
  assert.equal(armD.c1, 'class: CompanyProperties | field: money');

  const armE = buildCriteria(sample, 'E');
  assert.ok(armE.c0.includes('uint16_t') && armE.c0.includes('+0x132'));
  assert.ok(armE.c1.includes('Money') && armE.c1.includes('+0x98'));
});

test('deterministic lexical comparator handles natural vs synthetic behavior', () => {
  const sample = [
    { className: 'SPUBasicUpdateDriver', fieldName: '_host' },
    { className: 'SPUUIBasedUpdateDriver', fieldName: '_resumingDownloadedInfoOrUpdate' },
  ];
  const query = 'Host bundle being checked or updated by the basic update driver';
  const pick = deterministicLexicalPick(query, sample);
  // Lexical screen picks the candidate with highest word overlap ('update', 'driver', 'downloaded')
  assert.equal(pick.fieldName, '_resumingDownloadedInfoOrUpdate');
});

test('response validator rejects malformed payloads and out-of-bounds indices', () => {
  assert.equal(validateResponse(null, 5), 'model-mismatch');
  assert.equal(validateResponse({ model: 'wrong' }, 5), 'model-mismatch');
  assert.equal(validateResponse({ model: 'openjev', answers: { pick: { choice: 'invalid' } } }, 5), 'malformed-choice');
  assert.equal(validateResponse({
    model: 'openjev',
    answers: {
      pick: { type: 'choice', choice: 'c9', probabilities: { c9: 1 }, confidence: 1 },
      unique: { type: 'noul', noul: 0.5 },
    },
  }, 5), 'invalid-candidate'); // Index 9 >= count 5
});
