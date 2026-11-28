/*
 * Investigation report: one shareable file (HTML or Markdown) with what the
 * user found and changed. Only recorded facts are written; nothing is inferred.
 */
import { goalLabel } from '../goals.js';
import { libraryInfoAt, isFoldable } from '../analysis/library-code.js';

const VERDICT_TEXT = {
  confirmed: ['確認済み', 'Confirmed'],
  likely: ['可能性が高い', 'Likely'],
  ambiguous: ['候補あり', 'Ambiguous'],
};

function toBig(value) {
  if (typeof value === 'bigint') return value;
  try { return value == null ? null : BigInt(value); } catch { return null; }
}
const hex = (value) => {
  const big = toBig(value);
  return big == null ? '' : '0x' + big.toString(16).toUpperCase();
};
const bytesHex = (bytes) => Array.from(bytes || [], (b) => Number(b).toString(16).padStart(2, '0').toUpperCase()).join(' ');

function nameAt(app, addr) {
  try { return app?.symbols?.nameAt?.(addr) || `sub_${addr.toString(16).toUpperCase()}`; } catch { return hex(addr); }
}

function reasonText(reason) {
  if (reason == null) return '';
  if (typeof reason === 'string') return reason;
  return String(reason.label || reason.text || reason.detail || reason.kind || reason.code || '');
}

function targetOf(app, pin) {
  const top = pin?.top || null;
  if (!top) return null;
  if (top.kind === 'field' && top.className && top.field) {
    return { kind: 'field', label: `${top.className}.${String(top.field.name || '').replace(/^_/, '') || '?'}`, addr: null };
  }
  const addr = toBig(top.addr ?? top.function ?? top.address);
  if (addr == null) return null;
  return { kind: 'function', label: top.name || nameAt(app, addr), addr };
}

function collectFindings(app) {
  const out = [];
  const seen = new Set();
  const push = (goal, pin) => {
    if (!goal || !pin?.top || !VERDICT_TEXT[pin.verdict]) return;
    const target = targetOf(app, pin);
    if (!target) return;
    const key = `${goal.id ?? goalLabel(goal)}|${target.label}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      goal: goalLabel(goal),
      verdict: pin.verdict,
      target,
      reasons: (pin.top.reasons || pin.reasons || []).map(reasonText).filter(Boolean).slice(0, 3),
    });
  };
  const ctx = app?.lastGoalContext;
  if (ctx?.goal && ctx?.pinpoint) push(ctx.goal, ctx.pinpoint);
  for (const g of app?.autoReport?.report?.goals || []) push(g?.goal, g?.pinned);
  return out;
}

function collectFunctions(app) {
  const rows = new Map();
  const row = (addrLike) => {
    const addr = toBig(addrLike);
    if (addr == null) return null;
    const key = addr.toString();
    if (!rows.has(key)) rows.set(key, { addr, userName: null, comment: null, bookmark: null, patched: false });
    return rows.get(key);
  };
  const notes = app?.notes;
  try { for (const entry of notes?.nameEntries?.() || []) { const r = row(entry.addr); if (r) r.userName = entry.name; } } catch { /* optional */ }
  try { for (const [k, v] of notes?.comments || []) { const r = row(k); if (r && v) r.comment = String(v); } } catch { /* optional */ }
  try {
    for (const bm of app?.bookmarks?.list?.() || []) {
      const r = row(bm?.addr);
      if (r) r.bookmark = { note: bm.note ? String(bm.note) : '', tags: Array.isArray(bm.tags) ? bm.tags.map(String) : [] };
    }
  } catch { /* optional */ }
  try { for (const p of app?.patches?.list?.() || []) { const r = row(p.addr); if (r) r.patched = true; } } catch { /* optional */ }
  return [...rows.values()]
    .map((r) => {
      const lib = libraryInfoAt(app, r.addr);
      return { ...r, name: nameAt(app, r.addr), library: isFoldable(lib) ? lib.vendor : null };
    })
    .sort((a, b) => (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0));
}

function collectPatches(app) {
  try {
    return (app?.patches?.list?.() || []).map((p) => ({
      offset: toBig(p.offset), addr: toBig(p.addr), before: bytesHex(p.before), after: bytesHex(p.after), label: p.label ? String(p.label) : '',
    }));
  } catch { return []; }
}

export function collectReport(app, { now = new Date() } = {}) {
  const info = app?.store?.get?.('fileInfo') || {};
  const sliceIndex = app?.store?.get?.('sliceIndex');
  const slice = Array.isArray(info.slices) ? info.slices[sliceIndex] : null;
  return {
    file: {
      name: String(info.name || info.fileName || ''),
      format: String(info.format || info.formatName || slice?.info?.format || ''),
      architecture: String(app?.store?.get?.('architecture') || slice?.capability?.architecture || ''),
      size: info.size != null ? Number(info.size) : null,
    },
    generatedAt: now.toISOString(),
    findings: collectFindings(app),
    functions: collectFunctions(app),
    patches: collectPatches(app),
  };
}

function L(ja, en, isJa) { return isJa ? ja : en; }

export function reportMarkdown(model, { ja = true } = {}) {
  const md = (s) => String(s ?? '').replace(/[\\`*_[\]<>|#]/g, (c) => '\\' + c).replace(/\r?\n/g, ' ');
  const out = [];
  out.push(`# ${md(model.file.name || 'Hex')} — ${L('調査レポート', 'Investigation report', ja)}`);
  out.push('');
  out.push(`- ${L('形式', 'Format', ja)}: ${md([model.file.format, model.file.architecture].filter(Boolean).join(' · '))}`);
  if (model.file.size != null) out.push(`- ${L('サイズ', 'Size', ja)}: ${model.file.size.toLocaleString()} bytes`);
  out.push(`- ${L('作成', 'Created', ja)}: ${model.generatedAt}`);
  if (model.findings.length) {
    out.push('', `## ${L('調べた結果', 'Findings', ja)}`, '');
    out.push(`| ${L('目的', 'Goal', ja)} | ${L('答え', 'Answer', ja)} | ${L('判定', 'Verdict', ja)} | ${L('根拠', 'Evidence', ja)} |`, '|---|---|---|---|');
    for (const f of model.findings) {
      const target = f.target.addr != null ? `${md(f.target.label)} (\`${hex(f.target.addr)}\`)` : md(f.target.label);
      out.push(`| ${md(f.goal)} | ${target} | ${L(...VERDICT_TEXT[f.verdict], ja)} | ${f.reasons.map(md).join(' / ')} |`);
    }
  }
  if (model.functions.length) {
    out.push('', `## ${L('名前とメモ', 'Names and notes', ja)}`, '');
    out.push(`| ${L('アドレス', 'Address', ja)} | ${L('名前', 'Name', ja)} | ${L('メモ', 'Note', ja)} |`, '|---|---|---|');
    for (const f of model.functions) {
      const note = [f.comment, f.bookmark?.note, f.bookmark?.tags?.length ? `#${f.bookmark.tags.join(' #')}` : '', f.patched ? L('パッチあり', 'patched', ja) : '', f.library ? `${L('ライブラリ', 'library', ja)}: ${f.library}` : '']
        .filter(Boolean).map(md).join(' / ');
      out.push(`| \`${hex(f.addr)}\` | ${md(f.name)}${f.bookmark ? ' ★' : ''} | ${note} |`);
    }
  }
  if (model.patches.length) {
    out.push('', `## ${L('パッチ', 'Patches', ja)}`, '');
    out.push(`| ${L('アドレス', 'Address', ja)} | ${L('ファイル位置', 'File offset', ja)} | ${L('元', 'Before', ja)} | ${L('後', 'After', ja)} | ${L('メモ', 'Label', ja)} |`, '|---|---|---|---|---|');
    for (const p of model.patches) out.push(`| \`${hex(p.addr)}\` | \`${hex(p.offset)}\` | \`${p.before}\` | \`${p.after}\` | ${md(p.label)} |`);
  }
  if (!model.findings.length && !model.functions.length && !model.patches.length) out.push('', L('記録はまだありません。', 'Nothing recorded yet.', ja));
  out.push('');
  return out.join('\n');
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function reportHtml(model, { ja = true } = {}) {
  const title = `${model.file.name || 'Hex'} — ${L('調査レポート', 'Investigation report', ja)}`;
  const table = (heads, rows) => `<div class="t"><table><thead><tr>${heads.map((x) => `<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  const parts = [];
  parts.push(`<h1>${esc(title)}</h1>`);
  parts.push(`<p class="meta">${esc([model.file.format, model.file.architecture].filter(Boolean).join(' · '))}${model.file.size != null ? ` · ${esc(model.file.size.toLocaleString())} bytes` : ''} · ${esc(model.generatedAt)}</p>`);
  if (model.findings.length) {
    parts.push(`<h2>${esc(L('調べた結果', 'Findings', ja))}</h2>`);
    parts.push(table([L('目的', 'Goal', ja), L('答え', 'Answer', ja), L('判定', 'Verdict', ja), L('根拠', 'Evidence', ja)], model.findings.map((f) => `<tr><td>${esc(f.goal)}</td><td>${esc(f.target.label)}${f.target.addr != null ? ` <code>${esc(hex(f.target.addr))}</code>` : ''}</td><td><span class="v v-${esc(f.verdict)}">${esc(L(...VERDICT_TEXT[f.verdict], ja))}</span></td><td>${f.reasons.map(esc).join('<br>')}</td></tr>`)));
  }
  if (model.functions.length) {
    parts.push(`<h2>${esc(L('名前とメモ', 'Names and notes', ja))}</h2>`);
    parts.push(table([L('アドレス', 'Address', ja), L('名前', 'Name', ja), L('メモ', 'Note', ja)], model.functions.map((f) => {
      const tags = f.bookmark?.tags?.length ? `<span class="tag">#${f.bookmark.tags.map(esc).join(' #')}</span>` : '';
      const extra = [f.patched ? L('パッチあり', 'patched', ja) : '', f.library ? `${L('ライブラリ', 'library', ja)}: ${f.library}` : ''].filter(Boolean).map((x) => `<span class="tag">${esc(x)}</span>`).join(' ');
      const note = [f.comment, f.bookmark?.note].filter(Boolean).map((x) => `<div>${esc(x)}</div>`).join('');
      return `<tr><td><code>${esc(hex(f.addr))}</code></td><td>${esc(f.name)}${f.bookmark ? ' ★' : ''}</td><td>${note}${tags} ${extra}</td></tr>`;
    })));
  }
  if (model.patches.length) {
    parts.push(`<h2>${esc(L('パッチ', 'Patches', ja))}</h2>`);
    parts.push(table([L('アドレス', 'Address', ja), L('ファイル位置', 'File offset', ja), L('元', 'Before', ja), L('後', 'After', ja), L('メモ', 'Label', ja)], model.patches.map((p) => `<tr><td><code>${esc(hex(p.addr))}</code></td><td><code>${esc(hex(p.offset))}</code></td><td><code>${esc(p.before)}</code></td><td><code>${esc(p.after)}</code></td><td>${esc(p.label)}</td></tr>`)));
  }
  if (!model.findings.length && !model.functions.length && !model.patches.length) parts.push(`<p>${esc(L('記録はまだありません。', 'Nothing recorded yet.', ja))}</p>`);
  const css = ':root{color-scheme:light dark;--fg:#1c2321;--bg:#f7f5ef;--line:#d9d5ca;--mut:#5f6b67;--acc:#1f6b57}'
    + '@media (prefers-color-scheme:dark){:root{--fg:#e6ece9;--bg:#101918;--line:#2a3633;--mut:#9aa8a3;--acc:#5cc2a3}}'
    + 'body{margin:0 auto;max-width:960px;padding:24px 16px;font:15px/1.6 system-ui,-apple-system,"Hiragino Sans",sans-serif;color:var(--fg);background:var(--bg)}'
    + 'h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}.meta{color:var(--mut);margin:0}'
    + '.t{overflow-x:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;vertical-align:top;padding:6px 8px;border-bottom:1px solid var(--line)}'
    + 'th{font-size:13px;color:var(--mut);font-weight:600}code{font:13px ui-monospace,Menlo,monospace}'
    + '.tag{display:inline-block;font-size:12px;color:var(--mut);margin-right:6px}.v{font-weight:600}.v-confirmed{color:var(--acc)}'
    + '@media print{body{background:#fff;color:#000}}';
  return `<!doctype html>\n<html lang="${ja ? 'ja' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${esc(title)}</title><style>${css}</style></head><body>${parts.join('\n')}</body></html>\n`;
}

export function reportFile(app, format = 'html', { ja = true, now = new Date() } = {}) {
  const model = collectReport(app, { now });
  const base = (model.file.name || 'hex').replace(/[\\/:*?"<>|]+/g, '_');
  if (format === 'md') {
    return { name: `${base}-report.md`, blob: new Blob([reportMarkdown(model, { ja })], { type: 'text/markdown;charset=utf-8' }) };
  }
  return { name: `${base}-report.html`, blob: new Blob([reportHtml(model, { ja })], { type: 'text/html;charset=utf-8' }) };
}
