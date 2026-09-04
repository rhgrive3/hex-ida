#!/usr/bin/env node
import fs from 'node:fs';

const code = process.argv[2];
const owner = process.argv[3] || null;
if (!code) throw new Error('audit code required');
if (owner && !['section', 'segment'].includes(owner)) throw new Error(`unknown owner ${owner}`);
const report = JSON.parse(fs.readFileSync('universal-platform-benchmark.json', 'utf8'));
const hits = [];
for (const [name, target] of Object.entries(report.targets || {})) {
  for (const detail of target.auditErrorDetails || []) {
    if (detail.code !== code) continue;
    if (owner && !String(detail.message || '').startsWith(`${owner} `)) continue;
    hits.push({ name, message: detail.message });
  }
}
for (const hit of hits) console.log(`${hit.name}: ${hit.message}`);
if (!hits.length) {
  console.log(`${code}${owner ? `/${owner}` : ''}: absent`);
  process.exit(1);
}
