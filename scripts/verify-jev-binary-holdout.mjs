#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportDir = path.resolve(process.argv[2] ?? (process.env.HEX_JEV_HOLDOUT_DIR ?? path.join(root, 'reports/investigations/jev-final-decision-20260924/openemu')));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(fs.readFileSync(path.join(reportDir, 'holdout-manifest.json')));
const caseBytes = fs.readFileSync(path.join(reportDir, 'holdout-cases.json'));
if (hash(caseBytes) !== manifest.caseSha256) throw new Error('holdout-case-hash-mismatch');
if (hash(fs.readFileSync(path.join(root, 'js/pinpoint.js'))) !== manifest.routerFrozenSha256) {
  throw new Error('jev-router-freeze-mismatch');
}
const binary = process.env.HEX_JEV_HOLDOUT_BINARY ?? manifest.binary.localPath;
if (hash(fs.readFileSync(binary)) !== manifest.binary.sha256) throw new Error('holdout-binary-hash-mismatch');

const { openBinary } = await import(path.join(root, 'tests/harness.mjs'));
const { pinpointField, jevShortlist } = await import(path.join(root, 'js/pinpoint.js'));
const { parseGoal } = await import(path.join(root, 'js/goals.js'));
const world = await openBinary(binary, { log: () => {} });
const cases = JSON.parse(caseBytes);
const rows = [];
for (const c of cases) {
  const result = await pinpointField({
    goal: parseGoal(c.query), fields: world.fields, program: world.program,
    symbols: world.symbols, strings: world.strings, analyze: world.analyze,
    scanAccess: world.scanAccess, limit: 400,
  });
  const candidates = result?.candidates ?? [];
  const isGold = (candidate) => candidate && c.gold
    && (candidate.className ?? candidate.key?.split('#')?.[0]) === c.gold.class
    && (candidate.fieldName ?? candidate.field?.name ?? candidate.key?.split('#')?.[2]) === c.gold.field;
  const goldRank = c.gold ? candidates.findIndex(isGold) : -1;
  const shortlist = jevShortlist(candidates, { max: 255 });
  rows.push({
    id: c.id, answerable: !!c.gold, candidateCount: candidates.length,
    verdict: result?.verdict ?? 'none', goldRank: goldRank >= 0 ? goldRank + 1 : null,
    goldInLattice: goldRank >= 0, goldInShortlist: c.gold ? shortlist.some(isGold) : null,
    shortlistCount: shortlist.length,
  });
}
const answerable = rows.filter((r) => r.answerable);
const latticePresent = answerable.filter((r) => r.goldInLattice);
const retained = latticePresent.filter((r) => r.goldInShortlist);
const summary = {
  schema: 'hex-jev-binary-holdout-retention/v1',
  evaluatedAtUtc: new Date().toISOString(), caseSha256: manifest.caseSha256,
  binarySha256: manifest.binary.sha256, routerSha256: manifest.routerFrozenSha256,
  total: rows.length, answerable: answerable.length, abstain: rows.length - answerable.length,
  goldInLattice: latticePresent.length, goldInShortlist: retained.length,
  latticePresentRetention: latticePresent.length ? retained.length / latticePresent.length : null,
  allAnswerableRetention: answerable.length ? retained.length / answerable.length : null,
  rows,
};
fs.writeFileSync(path.join(reportDir, 'shortlist-retention.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ answerable: summary.answerable, goldInLattice: summary.goldInLattice,
  goldInShortlist: summary.goldInShortlist, latticePresentRetention: summary.latticePresentRetention }));
