import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { collectReport, reportHtml, reportMarkdown } from '../js/ui/investigation-report.js';

function fakeApp() {
  const names = new Map([['4096', '<img src=x onerror=alert(1)>coin']]);
  return {
    store: { get: (k) => ({ fileInfo: { name: 'game|bin', size: 100, format: 'Mach-O', slices: [] }, sliceIndex: 0, architecture: 'arm64' })[k] },
    symbols: { nameAt: (a) => (a === 0x1000n ? names.get('4096') : a === 0x2000n ? 'addCoins' : null), renames: new Map() },
    notes: {
      nameEntries: () => [{ addr: 0x1000n, name: names.get('4096') }],
      comments: new Map([['8192', '所持金を足す\n2行目 | pipe']]),
    },
    bookmarks: { list: () => [{ addr: 0x2000n, note: 'ここ', tags: ['coin'] }] },
    patches: { list: () => [{ offset: 0x200n, addr: 0x2000n, before: [0xc0, 0x03, 0x5f, 0xd6], after: [0x1f, 0x20, 0x03, 0xd5], label: 'nop' }] },
    lastGoalContext: {
      goal: { id: 'money', ja: '所持金', en: 'Money' },
      pinpoint: { verdict: 'likely', top: { kind: 'function', addr: 0x2000n, name: 'addCoins', reasons: ['"coin =" を参照'] } },
    },
    autoReport: { report: { goals: [{ goal: { id: 'hp', ja: 'HP', en: 'HP' }, pinned: { verdict: 'none', top: { addr: 0x3000n } } }] } },
  };
}

test('report collects names, comments, bookmarks, patches and findings', () => {
  const model = collectReport(fakeApp(), { now: new Date('2026-01-01T00:00:00Z') });
  assert.equal(model.functions.length, 2);
  assert.equal(model.patches[0].before, 'C0 03 5F D6');
  assert.equal(model.findings.length, 1, 'verdict none is not reported');
  assert.equal(model.findings[0].target.label, 'addCoins');
});

test('HTML report escapes hostile names and has no script', () => {
  const html = reportHtml(collectReport(fakeApp()), { ja: true });
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;coin'));
  assert.ok(!/<script/i.test(html));
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(html.includes('可能性が高い'));
});

test('Markdown report keeps tables intact', () => {
  const md = reportMarkdown(collectReport(fakeApp()), { ja: true });
  const rows = md.split('\n').filter((l) => l.startsWith('| `0x2000`'));
  assert.equal(rows.length, 2);
  for (const row of rows) assert.ok(!/[^\\]\|[^|]*\n/.test(row));
  assert.ok(md.includes('game\\|bin'));
  assert.ok(md.includes('2行目 \\| pipe'));
});

test('empty project writes a single short line', () => {
  const app = { store: { get: () => null } };
  assert.match(reportMarkdown(collectReport(app), { ja: true }), /記録はまだありません。/);
});

test('exportReportFromProduct guards against fileLoading', () => {
  const productBase = fs.readFileSync(new URL('../js/ui/product-base.js', import.meta.url), 'utf8');
  assert.match(productBase, /function exportReportFromProduct\(app,\s*format\)\s*\{\s*\n\s*if\s*\(guardFileLoading\(app\)\)\s*return;/);
});
