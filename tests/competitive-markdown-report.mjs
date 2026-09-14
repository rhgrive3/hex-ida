import assert from 'node:assert/strict';
import { formatCompetitiveMarkdownReport } from '../tools/validation/competitive/report.mjs';

const markdown = formatCompetitiveMarkdownReport({
  profileId:'p',
  gitSha:'a'.repeat(40),
  treeSha:'b'.repeat(40),
  runtimeHardwareClass:'x',
  generatedAt:'2026-08-28T00:00:00.000Z',
  summary:{ totalMetrics:1, wins:0, ties:0, losses:0, unmeasured:1 },
  entries:[{
    metricId:'metric|id',
    hexValue:null,
    referenceTool:'tool|variant',
    referenceVersion:'1|0',
    referenceValue:null,
    comparison:'UN|MEASURED',
    runPolicy:'exact|head',
  }],
});

const row = markdown.split('\n').find((line) => line.startsWith('| `metric'));
assert.ok(row, 'metric row must be present');
assert.match(row, /`metric\\\|id`/);
assert.match(row, /tool\\\|variant \(1\\\|0\)/);
assert.match(row, /\*\*UN\\\|MEASURED\*\*/);
assert.match(row, /exact\\\|head/);

const unescapedSeparators = row.replace(/\\\|/g, '').match(/\|/g) || [];
assert.equal(unescapedSeparators.length, 7, 'six-cell Markdown row keeps only structural delimiters');

console.log('competitive markdown report escaping: PASS');
