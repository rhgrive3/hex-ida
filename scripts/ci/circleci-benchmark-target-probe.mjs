#!/usr/bin/env node
import fs from 'node:fs';

const target = process.argv[2];
const category = process.argv[3] || 'all';
if (!target) throw new Error('target required');
if (!['all', 'identity', 'work'].includes(category)) throw new Error(`unknown category ${category}`);
const current = JSON.parse(fs.readFileSync('universal-platform-benchmark.json', 'utf8'));
const baseline = JSON.parse(fs.readFileSync('tests/benchmark-baseline.json', 'utf8'));
const got = current.targets?.[target];
const expected = baseline.observations?.binary?.targets?.[target];
const fixture = baseline.fixtures?.[target];
if (!got || !expected || !fixture) throw new Error(`missing target ${target}`);
const maxRatio = baseline.regressionPolicy.deterministicWork.maxRatio;
const identityChecks = [
  ['fixture size', got.fixture?.size === fixture.size, `${got.fixture?.size} == ${fixture.size}`],
  ['fixture hash', got.fixture?.sha256 === fixture.sha256, `${got.fixture?.sha256} == ${fixture.sha256}`],
  ['source-backed', got.sourceBacked === true, String(got.sourceBacked)],
  ['audit errors', got.auditErrors === 0, String(got.auditErrors)],
  ['identity bytes', got.bytes === expected.identity.bytes, `${got.bytes} == ${expected.identity.bytes}`],
  ['identity format', got.format === expected.identity.format, `${got.format} == ${expected.identity.format}`],
  ['identity arch', got.arch === expected.identity.arch, `${got.arch} == ${expected.identity.arch}`],
];
const workChecks = [
  ['range reads', got.work?.rangeReads <= Math.ceil(expected.work.rangeReads * maxRatio), `${got.work?.rangeReads} <= ${Math.ceil(expected.work.rangeReads * maxRatio)}`],
  ['requested bytes', got.work?.totalRequestedBytes <= Math.ceil(expected.work.totalRequestedBytes * maxRatio), `${got.work?.totalRequestedBytes} <= ${Math.ceil(expected.work.totalRequestedBytes * maxRatio)}`],
];
const checks = category === 'identity' ? identityChecks : category === 'work' ? workChecks : [...identityChecks, ...workChecks];
let failed = false;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${target} ${category} ${name}: ${detail}`);
  if (!ok) failed = true;
}
if (failed) process.exit(1);
