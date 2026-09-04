#!/usr/bin/env node
import fs from 'node:fs';

const code = process.argv[2];
const mode = process.argv[3] || null;
if (!code) throw new Error('audit code required');
const modes = new Set(['section', 'segment', 'null', 'nonnull', 'start', 'end']);
if (mode && !modes.has(mode)) throw new Error(`unknown mode ${mode}`);
const report = JSON.parse(fs.readFileSync('universal-platform-benchmark.json', 'utf8'));
const hits = [];
for (const [name, target] of Object.entries(report.targets || {})) {
  for (const detail of target.auditErrorDetails || []) {
    if (detail.code !== code) continue;
    const message = String(detail.message || '');
    if (mode === 'section' && !message.startsWith('section ')) continue;
    if (mode === 'segment' && !message.startsWith('segment ')) continue;
    if (mode === 'null' && !message.includes(' -> null expected ')) continue;
    if (mode === 'nonnull' && message.includes(' -> null expected ')) continue;
    const label = message.split(':', 1)[0];
    if (mode === 'end' && !label.endsWith(' end')) continue;
    if (mode === 'start' && label.endsWith(' end')) continue;
    hits.push({ name, message });
  }
}
for (const hit of hits) console.log(`${hit.name}: ${hit.message}`);
if (!hits.length) {
  console.log(`${code}${mode ? `/${mode}` : ''}: absent`);
  process.exit(1);
}
