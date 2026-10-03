#!/usr/bin/env node
// Development metadata audit. Inputs contain plain queries and a release
// binary identity only. No source/debug oracle is opened by this collector.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { openProduct } from '../tools/validation/public-benchmark/product-host.mjs';
import { recoverCxxMembersForQuery } from '../js/analysis/query/app-adapter.js';
import { sha256, persistentWrite } from './jev-realgame-final-contract.mjs';

const [binary, queries, output] = process.argv.slice(2);
if (!binary || !queries || !output) throw new Error('usage: RELEASE_BINARY PLAIN_QUERIES OUTPUT');
const bytes = fs.readFileSync(queries), manifest = JSON.parse(bytes);
if (!manifest.binarySha256 || !Array.isArray(manifest.cases)
  || manifest.cases.some(c => Object.keys(c).some(key => !['id','query','mode'].includes(key)))) throw new Error('plain query input required');
const product = await openProduct(binary), rows = [];
try {
  if (product.sha !== manifest.binarySha256) throw new Error('binary binding mismatch');
  for (const row of manifest.cases) {
    let choices, body;
    const recovery = await recoverCxxMembersForQuery(product.app, row.query, { enabled: true, planOnly: true,
      jevRetrieval: true, jevClient: { call: async input => { choices = input.choices; body = input.body; return null; } } });
    rows.push({ id: row.id, query: row.query, recovery, choices: choices ?? [], body: body ?? null });
  }
  const root = new URL('../', import.meta.url);
  const files = ['js/analysis/cxx/primary-owner.js','js/analysis/cxx/project.js','js/analysis/cxx/query-recovery.js',
    'js/analysis/query/app-adapter.js','js/analysis/query/jev-recovery.js','scripts/audit-jev-realgame-recovery.mjs'];
  persistentWrite(output, { schema: 'hex-jev-recovery-metadata-audit/v3', complete: true,
    productSha: execFileSync('git', ['rev-parse','HEAD'], { encoding: 'utf8' }).trim(),
    binarySha256: product.sha, queriesSha256: sha256(bytes), profile: product.profile,
    sourceHashes: Object.fromEntries(files.map(file => [file,sha256(fs.readFileSync(new URL(file,root)))])), rows });
  console.log(JSON.stringify({ complete: true, queries: rows.length, functions: rows[0]?.recovery.functionCount,
    maximumChoices: Math.max(...rows.map(row=>row.choices.length)), analysisCalls: 0 }));
} finally { await product.close(); }
