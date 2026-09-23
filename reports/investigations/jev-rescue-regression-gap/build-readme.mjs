#!/usr/bin/env node
// README.md is the canonical narrative; this script only refreshes machine-checked numeric stamps if needed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const readme = path.join(HERE, 'README.md');
if (!fs.existsSync(readme)) throw new Error('README.md missing');
const text = fs.readFileSync(readme, 'utf8');
for (const needle of ['Direct answers', 'Baseline', 'Jev forced rerank', 'Ambiguous-only', 'Deterministic comparator', 'Oracle', 'wrong→correct', 'false-strong']) {
  if (!text.includes(needle)) throw new Error(`README missing ${needle}`);
}
console.log('README present with required tables/answers');
