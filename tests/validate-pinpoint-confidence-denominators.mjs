import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'reports/investigations/pinpoint-confidence-calibration');
const rows = fs.readFileSync(path.join(DIR, 'rows.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(JSON.parse);
const summary = JSON.parse(fs.readFileSync(path.join(DIR, 'summary.json'), 'utf8'));
const field = rows.filter((r) => r.kind === 'field');
const dsda = rows.filter((r) => r.kind === 'location');

function eq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: got ${actual}, want ${expected}`);
}

eq(field.length, 426, 'fieldRows');
eq(dsda.length, 1, 'dsdaHoldoutRows');
eq(rows.length, 427, 'totalRows');
eq(summary.dataset.fieldQueries, 426, 'summary.dataset.fieldQueries');
eq(summary.dataset.dsdaHoldout, 'included-separately', 'summary.dataset.dsdaHoldout');
eq(summary.exact.queries + summary.partialOverall.queries, 426, 'field regime denominator');
eq(summary.presentVsNotFound.present + summary.presentVsNotFound.notFound, 426, 'field present/not-found denominator');
eq(summary.partialNotFound, 54, 'partial not-found denominator');

process.stdout.write('denominator contract: ok\n');
