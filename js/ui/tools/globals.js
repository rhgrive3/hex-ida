import { Sheet, el, list, tapRow, noteBox } from '../../ui.js';
import { addrHex } from '../../format.js';
import { findGlobals } from '../../linkage.js';
import { globalReferenceStats } from '../../analysis/global-ref-stats.js';

function betterGlobal(a, b) {
  return a.refs > b.refs || (a.refs === b.refs && a.addr < b.addr);
}
function worseGlobal(a, b) {
  return a.refs < b.refs || (a.refs === b.refs && a.addr > b.addr);
}
function boundedTopGlobals(limit) {
  const heap = [];
  const swap = (a, b) => { const value = heap[a]; heap[a] = heap[b]; heap[b] = value; };
  const up = (index) => {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!worseGlobal(heap[index], heap[parent])) break;
      swap(index, parent);
      index = parent;
    }
  };
  const down = (index) => {
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let worst = index;
      if (left < heap.length && worseGlobal(heap[left], heap[worst])) worst = left;
      if (right < heap.length && worseGlobal(heap[right], heap[worst])) worst = right;
      if (worst === index) break;
      swap(index, worst);
      index = worst;
    }
  };
  return {
    offer(value) {
      if (limit <= 0) return;
      if (heap.length < limit) { heap.push(value); up(heap.length - 1); return; }
      if (!betterGlobal(value, heap[0])) return;
      heap[0] = value;
      down(0);
    },
    values() {
      return heap.sort((a, b) => b.refs - a.refs || (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0));
    },
  };
}

export function mergeGlobals(named, stats, limit = 400) {
  const cap = Math.max(0, Math.floor(Number(limit) || 0));
  const seen = new Set();
  const top = boundedTopGlobals(cap);
  for (const row of named || []) {
    const key = BigInt(row.addr).toString();
    const counted = stats?.counts?.get?.(key);
    seen.add(key);
    top.offer({ ...row, refs:counted?.refs ?? 0 });
  }
  if (stats?.counts) {
    for (const hit of stats.counts.values()) {
      const key = hit.addr.toString();
      if (seen.has(key) || hit.refs < 2) continue;
      top.offer({
        addr:hit.addr,
        name:null,
        readable:'off_' + hit.addr.toString(16).toUpperCase(),
        region:hit.region,
        refs:hit.refs,
        named:false,
      });
    }
  }
  return top.values();
}

function renderRows(app, sheet, host, rows, { pending = false, complete = true, reason = null } = {}) {
  host.replaceChildren();
  host.append(el('div', 'hint', pending
    ? '名前付きの共有データを先に表示しています。参照頻度は共有Program artifactから集計中です。'
    : complete
      ? '参照頻度まで確認済みです。'
      : `参照頻度は一部のみ確認済みです${reason ? `（${reason}）` : ''}。`));

  if (!rows.length) {
    host.append(noteBox(pending
      ? '名前付きグローバルはまだ見つかっていません。'
      : '見つかりませんでした（未解析範囲がある場合は absence を確定しません）。'));
    return;
  }

  const rowsList = list();
  for (const global of rows.slice(0, 300)) {
    rowsList.append(tapRow(global.readable || global.name || ('off_' + global.addr.toString(16).toUpperCase()), {
      sub:addrHex(global.addr) + '  ·  ' + (global.region || '')
        + (pending ? '  ·  参照数を集計中' : '  ·  ' + global.refs + ' か所から参照')
        + (global.named ? '' : '\n（名前は残っていません。参照の多さから見つけました）'),
      onTap:() => { sheet.close(); app.goToAddress(global.addr, { announce:true }); },
    }));
  }
  host.append(rowsList);
}

export function showGlobals(app) {
  const controller = new AbortController();
  const sheet = new Sheet('グローバル変数', { onClose:() => controller.abort('globals-sheet-closed') });
  const host = el('div');
  sheet.body.append(host);
  const regions = app.store.get('regions') || [];

  // Named data is cheap and useful before the shared ProgramIndex is ready.
  const named = findGlobals(app.symbols, null, regions, { limit:400 });
  renderRows(app, sheet, host, named, { pending:true, complete:false });

  (async () => {
    try {
      const program = await app.ensureProgram?.({ signal:controller.signal, priority:'user-visible' });
      if (!program || controller.signal.aborted || !sheet.root.isConnected) return;
      const stats = await globalReferenceStats(program, regions, { signal:controller.signal });
      if (controller.signal.aborted || !sheet.root.isConnected) return;
      renderRows(app, sheet, host, mergeGlobals(named, stats), { complete:stats.complete, reason:stats.reason });
    } catch (error) {
      if (error?.name === 'AbortError' || controller.signal.aborted) return;
      if (sheet.root.isConnected) renderRows(app, sheet, host, named, { complete:false, reason:error?.message || '参照集計に失敗' });
    }
  })();

  return sheet;
}
