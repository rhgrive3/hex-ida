#!/usr/bin/env node
import fs from 'node:fs';

const code = process.argv[2];
if (!code) throw new Error('audit code required');
const report = JSON.parse(fs.readFileSync('universal-platform-benchmark.json', 'utf8'));
const hits = Object.entries(report.targets || {})
  .filter(([, target]) => Array.isArray(target.auditErrorCodes) && target.auditErrorCodes.includes(code))
  .map(([name]) => name);
console.log(`${code}: ${hits.length ? hits.join(',') : 'absent'}`);
if (!hits.length) process.exit(1);
