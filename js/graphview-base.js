/* Graph rendering and CFG/Call Graph adapters. Routing lives in graph-routing.js. */

import {
  LINE_H, PAD_X, PAD_Y, MAX_LINES, MAX_CHARS,
  layoutNodes, routeEdges, roundedOrthogonalPath, graphRoutingDiagnostics,
} from './graph-routing.js';
import { pick } from './i18n.js';

export { graphRoutingDiagnostics };

const NS = 'http://www.w3.org/2000/svg';
let graphSerial = 0;

function svgEl(tag, attrs) {
  const n = document.createElementNS(NS, tag);
  if (attrs) for (const k of Object.keys(attrs)) n.setAttribute(k, String(attrs[k]));
  return n;
}

/**
 * @param {Array} nodes [{id, title, lines:[string], kind, onTap}]
 * @param {Array} edges [{from, to, kind:'true'|'false'|'jump'|'back'|'call', label}]
 * @param {object} opts {height, onNode}
 * @returns {HTMLElement} スクロール・拡大縮小できる入れ物
 */
export function renderGraph(nodes, edges, opts) {
  const o = opts || {};
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const layout = layoutNodes(nodes, edges, byId);
  const routes = routeEdges(edges, layout);

  const wrap = document.createElement('div');
  wrap.className = 'graphwrap';
  const svg = svgEl('svg', {
    class: 'graph',
    width: layout.width, height: layout.height,
    viewBox: '0 0 ' + layout.width + ' ' + layout.height,
  });

  /* 同じページに複数グラフがあっても marker id が衝突しない。 */
  const markerPrefix = 'g' + (++graphSerial) + '-';
  const defs = svgEl('defs');
  for (const [id, cls] of [['ga', 'g-arrow'], ['gt', 'g-arrow true'], ['gf', 'g-arrow false'], ['gb', 'g-arrow back']]) {
    const marker = svgEl('marker', {
      id: markerPrefix + id, viewBox: '0 0 10 10', refX: 8, refY: 5,
      markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse',
      markerUnits: 'strokeWidth',
    });
    marker.append(svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: cls }));
    defs.append(marker);
  }
  svg.append(defs);

  const edgeMeta = new WeakMap();
  const nodeAction = new WeakMap();

  /* 線を先に描く。各線には halo と太い透明 hit-area を持たせる。 */
  for (const route of routes) {
    const e = route.edge;
    const cls = 'g-edge ' + (e.kind || 'jump');
    const markerId = e.kind === 'true' ? 'gt' : e.kind === 'false' ? 'gf' : e.kind === 'back' ? 'gb' : 'ga';
    const d = roundedOrthogonalPath(route.points);
    const group = svgEl('g', { class: 'g-edge-group' });

    const haloBase = e.kind === 'back' ? 7 : 5.5;
    const hit = svgEl('path', {
      d, fill: 'none', stroke: 'transparent', 'stroke-width': 14,
      'pointer-events': 'stroke',
    });
    const halo = svgEl('path', {
      d, fill: 'none', stroke: 'var(--surface-2)', 'stroke-width': haloBase,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'pointer-events': 'none',
    });
    const path = svgEl('path', {
      d, class: cls,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      'marker-end': 'url(#' + markerPrefix + markerId + ')',
      'pointer-events': 'none',
    });
    edgeMeta.set(hit, { path, halo, baseWidth: e.kind === 'back' ? 2.5 : 1.6, haloBase });

    group.append(hit, halo, path);

    if (e.label && route.label) {
      const w = e.label.length * 12 + 10;
      group.append(svgEl('rect', {
        x: route.label.x - w / 2, y: route.label.y - 12,
        width: w, height: 16, rx: 4, class: 'g-labelbg',
      }));
      const mid = svgEl('text', { x: route.label.x, y: route.label.y, class: 'g-label' });
      mid.textContent = e.label;
      group.append(mid);
    }
    svg.append(group);
  }

  /* 箱 */
  for (const n of nodes) {
    const p = layout.pos.get(n.id);
    if (!p) continue;
    const label = [n.title, ...(n.lines || []).slice(0, 2)].filter(Boolean).join(' — ');
    const g = svgEl('g', {
      class: 'g-node' + (n.kind ? ' ' + n.kind : ''), tabindex: 0, 'data-node-id': String(n.id),
      role: n.onTap || o.onNode ? 'button' : 'img', 'aria-label': label || pick('関係図のノード', 'Graph node'),
    });
    g.append(svgEl('rect', { x: p.x, y: p.y, width: p.w, height: p.h, rx: 8, class: 'g-box' }));
    if (n.title) {
      const t = svgEl('text', { x: p.x + PAD_X, y: p.y + PAD_Y + 12, class: 'g-title' });
      t.textContent = n.title;
      g.append(t);
    }
    const start = p.y + PAD_Y + (n.title ? LINE_H + 12 : 12);
    (n.lines || []).slice(0, MAX_LINES).forEach((text, i) => {
      const t = svgEl('text', { x: p.x + PAD_X, y: start + i * LINE_H, class: 'g-line' });
      t.textContent = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS - 1) + '…' : text;
      g.append(t);
    });
    if ((n.lines || []).length > MAX_LINES) {
      const t = svgEl('text', { x: p.x + PAD_X, y: start + MAX_LINES * LINE_H, class: 'g-line dim' });
      const extra = n.lines.length - MAX_LINES;
      t.textContent = pick('… ほか ' + extra + ' 行', '… ' + extra + ' more line' + (extra === 1 ? '' : 's'));
      g.append(t);
    }
    if (n.onTap || o.onNode) {
      g.style.cursor = 'pointer';
      nodeAction.set(g, () => (n.onTap ? n.onTap() : o.onNode(n)));
    }
    svg.append(g);
  }

  const delegationController = typeof AbortController === 'function' ? new AbortController() : null;
  const sigOpts = delegationController ? { signal: delegationController.signal } : undefined;
  const onEmphasize = (event) => {
    const meta = edgeMeta.get(event.target);
    if (!meta) return;
    meta.path.style.strokeWidth = String(meta.baseWidth + 1.6);
    meta.halo.style.strokeWidth = String(meta.haloBase + 2.4);
  };
  const onNormalize = (event) => {
    const meta = edgeMeta.get(event.target);
    if (!meta) return;
    meta.path.style.strokeWidth = '';
    meta.halo.style.strokeWidth = String(meta.haloBase);
  };
  svg.addEventListener('pointerover', onEmphasize, sigOpts);
  svg.addEventListener('pointerout', onNormalize, sigOpts);
  svg.addEventListener('focusin', onEmphasize, sigOpts);
  svg.addEventListener('focusout', onNormalize, sigOpts);
  svg.addEventListener('click', (event) => {
    const node = event.target?.closest?.('.g-node');
    const action = node ? nodeAction.get(node) : null;
    if (action) action();
  }, sigOpts);
  svg.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const node = event.target?.closest?.('.g-node');
    const action = node ? nodeAction.get(node) : null;
    if (action) { event.preventDefault(); action(); }
  }, sigOpts);

  wrap.append(svg);
  const panZoom = attachPanZoom(wrap, svg, layout);
  wrap.dispose = () => {
    delegationController?.abort();
    panZoom.dispose?.();
  };
  return wrap;
}

/* ── 指で動かす・広げる ─────────────────────────────────── */

function attachPanZoom(wrap, svg, layout) {
  const MIN = 0.2, MAX = 3;
  let scale = 1;

  const apply = () => {
    svg.setAttribute('width', Math.round(layout.width * scale));
    svg.setAttribute('height', Math.round(layout.height * scale));
    if (pctBtn) pctBtn.textContent = Math.round(scale * 100) + '%';
  };

  let rafId = 0;
  let fitRafId = 0;
  let pendingPanX = 0;
  let pendingPanY = 0;
  let pendingZoom = null;

  const zoomTo = (next, cx, cy) => {
    pendingZoom = null;
    const box = wrap.getBoundingClientRect();
    const px = (cx == null ? box.width / 2 : cx - box.left);
    const py = (cy == null ? box.height / 2 : cy - box.top);
    const gx = (wrap.scrollLeft + px) / scale;
    const gy = (wrap.scrollTop + py) / scale;
    scale = Math.max(MIN, Math.min(MAX, next));
    apply();
    wrap.scrollLeft = gx * scale - px;
    wrap.scrollTop = gy * scale - py;
  };

  const flushFrame = () => {
    rafId = 0;
    if (pendingZoom) {
      const z = pendingZoom;
      pendingZoom = null;
      zoomTo(z.nextScale, z.cx, z.cy);
    }
    if (pendingPanX || pendingPanY) {
      wrap.scrollLeft += pendingPanX;
      wrap.scrollTop += pendingPanY;
      pendingPanX = 0;
      pendingPanY = 0;
    }
  };

  const scheduleFrame = () => {
    if (!rafId) rafId = requestAnimationFrame(flushFrame);
  };

  const queueZoom = (factor, cx, cy) => {
    const base = pendingZoom ? pendingZoom.nextScale : scale;
    pendingZoom = { nextScale: Math.max(MIN, Math.min(MAX, base * factor)), cx, cy };
    scheduleFrame();
  };

  const queuePan = (dx, dy) => {
    pendingPanX += dx;
    pendingPanY += dy;
    scheduleFrame();
  };

  const fit = () => {
    pendingZoom = null;
    pendingPanX = 0;
    pendingPanY = 0;
    const w = wrap.clientWidth || 320;
    const h = wrap.clientHeight || 320;
    scale = Math.max(MIN, Math.min(1, Math.min((w - 24) / layout.width, (h - 24) / layout.height)));
    apply();
    wrap.scrollLeft = Math.max(0, (layout.width * scale - w) / 2);
    wrap.scrollTop = 0;
  };

  const bar = document.createElement('div');
  bar.className = 'graph-tools';
  const mk = (label, title, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tb-btn';
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', fn);
    return b;
  };
  const pctBtn = mk('100%', pick('等倍に戻す', 'Reset zoom to 100%'), () => zoomTo(1));
  bar.append(
    mk('－', pick('縮小', 'Zoom out'), () => zoomTo(scale - 0.2)),
    pctBtn,
    mk('＋', pick('拡大', 'Zoom in'), () => zoomTo(scale + 0.2)),
    mk(pick('全体', 'Fit'), pick('全体を画面に収める', 'Fit graph to view'), fit));
  wrap.append(bar);

  const points = new Map();
  let pinch = 0;
  let last = null;
  let suppressClick = false;
  let multiTouchGesture = false;
  wrap.addEventListener('pointerdown', (e) => {
    if (e.target.closest && e.target.closest('.graph-tools')) return;
    if (points.size === 0) { suppressClick = false; multiTouchGesture = false; }
    points.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (points.size === 1) {
      last = { x: e.clientX, y: e.clientY, moved: false, pointerId: e.pointerId };
      wrap.classList.add('dragging');
      /* No pointer capture yet: capturing on pointerdown retargets the tap's
         click to this wrapper, so tapping a block or function node did
         nothing. Capture only once the pointer really drags (below). */
    } else if (points.size === 2) {
      multiTouchGesture = true;
      pinch = spread(points);
    }
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!points.has(e.pointerId)) return;
    points.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (points.size >= 2) {
      const now = spread(points);
      if (pinch > 0 && now > 0) {
        const c = centre(points);
        queueZoom(now / pinch, c.x, c.y);
      }
      pinch = now;
      e.preventDefault();
      return;
    }
    if (!last) return;
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    if (!last.moved && Math.abs(dx) + Math.abs(dy) > 3) {
      last.moved = true;
      try { wrap.setPointerCapture(last.pointerId); } catch { /* pointer already released */ }
    }
    queuePan(-dx, -dy);
    last.x = e.clientX;
    last.y = e.clientY;
    e.preventDefault();
  });
  const release = (e) => {
    points.delete(e.pointerId);
    if (points.size < 2) pinch = 0;
    if (!points.size) {
      wrap.classList.remove('dragging');
      suppressClick = !!(last && last.moved) || multiTouchGesture;
      last = null;
    }
  };
  wrap.addEventListener('pointerup', release);
  wrap.addEventListener('pointercancel', release);
  wrap.addEventListener('click', (e) => {
    if (suppressClick) {
      suppressClick = false;
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);

  wrap.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      queueZoom(e.deltaY > 0 ? 0.9 : 1.1, e.clientX, e.clientY);
      e.preventDefault();
      return;
    }
    queuePan(e.deltaX, e.deltaY);
    e.preventDefault();
  }, { passive: false });

  fitRafId = requestAnimationFrame(() => {
    fitRafId = 0;
    fit();
  });
  const dispose = () => {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (fitRafId) {
      cancelAnimationFrame(fitRafId);
      fitRafId = 0;
    }
    pendingZoom = null;
    pendingPanX = 0;
    pendingPanY = 0;
  };
  return { apply, fit, zoomTo, dispose };
}

function spread(points) {
  const p = Array.from(points.values());
  if (p.length < 2) return 0;
  return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
}

function centre(points) {
  const p = Array.from(points.values());
  return { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 };
}

/** 図の下に置く凡例。線の意味を、色だけに頼らせない。 */
export function graphLegend(kind) {
  const wrap = document.createElement('div');
  wrap.className = 'graph-legend';
  const add = (cls, text) => {
    const s = document.createElement('span');
    s.className = cls;
    s.append(document.createElement('i'));
    s.append(document.createTextNode(text));
    wrap.append(s);
  };
  if (kind === 'call') {
    add('lg-call', pick('呼んでいる向き（上が呼ぶ側・下が呼ばれる側）', 'Call direction (caller above, callee below)'));
  } else {
    add('lg-true', pick('条件が成り立つとき', 'When condition is true'));
    add('lg-false', pick('成り立たないとき', 'When condition is false'));
    add('lg-back', pick('ここへ戻る（ループ）', 'Loop (back edge)'));
  }
  const tip = document.createElement('span');
  tip.textContent = pick('押したまま動かす／2 本指でつまむと拡大縮小', 'Drag to pan · pinch to zoom');
  wrap.append(tip);
  return wrap;
}

/* ── モデルから図の材料を作る ──────────────────────────── */

/**
 * 関数 1 つの制御フローグラフ。
 * @param {object} model  Semantic Model
 * @param {object} opts {rowOfAddress, addrOfRow, brief(insn) → 1 行の説明, onNode}
 */
export function cfgGraph(model, opts) {
  const o = opts || {};
  const blocks = model.basicBlocks || [];
  const byRow = new Map();
  for (const i of model.instructions) byRow.set(i.row, i);

  let blocksSorted = true;
  for (let i = 1; i < blocks.length; i++) {
    if (blocks[i].startRow < blocks[i - 1].startRow || blocks[i].startRow <= blocks[i - 1].endRow) {
      blocksSorted = false;
      break;
    }
  }
  const nodeOfRow = (row) => {
    if (blocksSorted) {
      let lo = 0, hi = blocks.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const b = blocks[mid];
        if (row < b.startRow) hi = mid - 1;
        else if (row > b.endRow) lo = mid + 1;
        else return b.index;
      }
      return -1;
    }
    for (const b of blocks) if (row >= b.startRow && row <= b.endRow) return b.index;
    return -1;
  };

  const nodes = blocks.map((b) => {
    const lines = [];
    for (const r of b.rows) {
      const insn = byRow.get(r);
      if (!insn) continue;
      lines.push(o.text ? o.text(insn) : (insn.mnemonic + ' ' + insn.operands).trim());
    }
    const addr = byRow.get(b.startRow) ? byRow.get(b.startRow).address : null;
    return {
      id: b.index,
      title: (addr != null ? '0x' + addr.toString(16).toUpperCase() : '#' + b.index) +
        (b.isLoopHeader ? pick('  ← ここへ戻ってくる', '  ← loop header') : ''),
      lines,
      kind: b.isLoopHeader ? 'loop' : (b.index === 0 ? 'entry' : ''),
      addr,
      onTap: o.onNode ? () => o.onNode(b, addr) : null,
    };
  });

  const edges = [];
  const backEdges = new Set((model.backEdges || []).map((e) => `${e.from}:${e.to}`));
  const isBackEdge = (fromBlock, toBlock, terminalRow) => {
    if (toBlock == null || toBlock < 0) return false;
    const target = blocks[toBlock];
    return !!target && backEdges.has(`${terminalRow}:${target.startRow}`);
  };
  for (const b of blocks) {
    let last = null;
    for (let ri = b.rows.length - 1; ri >= 0; ri--) {
      const insn = byRow.get(b.rows[ri]);
      if (insn && !insn.data) { last = insn; break; }
    }
    if (!last) continue;
    const base = (last.mnemonic || '').toLowerCase();
    if (last.isReturn || last.isTailCall) continue;
    const targetRow = last.branchTarget != null && o.rowOfAddress ? o.rowOfAddress(last.branchTarget) : null;
    const ti = targetRow != null ? nodeOfRow(targetRow) : -1;
    const next = b.index + 1 < blocks.length ? b.index + 1 : null;

    if (last.isConditional || /^(cbz|cbnz|tbz|tbnz)$/.test(base) || /^b\./.test(base)) {
      if (ti >= 0) edges.push({ from: b.index, to: ti, kind: isBackEdge(b.index, ti, last.row) ? 'back' : 'true', label: pick('成り立つ', 'true') });
      if (next != null) edges.push({ from: b.index, to: next, kind: 'false', label: pick('成り立たない', 'false') });
      continue;
    }
    if (base === 'b') {
      if (ti >= 0) edges.push({ from: b.index, to: ti, kind: isBackEdge(b.index, ti, last.row) ? 'back' : 'jump' });
      continue;
    }
    if (next != null) edges.push({ from: b.index, to: next, kind: 'jump' });
  }
  return { nodes, edges };
}

/**
 * 呼び出しグラフ。中心の関数から、呼ぶ側（上）と呼ばれる側（下）へ広げる。
 * @param {object} program ProgramIndex
 * @param {object} symbols SymbolIndex
 * @param {BigInt} addr 中心の関数
 * @param {object} opts {depth, limit, label(addr), onNode}
 */
export function callGraph(program, symbols, addr, opts) {
  const o = opts || {};
  const depth = o.depth || 1;
  const limit = o.limit || 8;
  const label = o.label || ((a) => (symbols && symbols.nameAt(a)) || 'sub_' + a.toString(16).toUpperCase());

  const nodes = [];
  const edges = [];
  const seen = new Map();
  const seenEdges = new Set();
  const idOf = (a) => a.toString();

  /* #5481: a self-recursive function observes the same A->A relation from both
     the caller and callee traversals; the edge set is deduped so one logical
     call edge is published once. */
  const addEdge = (from, to, kind) => {
    const key = `${from}\u0000${to}\u0000${kind}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push({ from, to, kind });
  };

  const add = (a, kind) => {
    const id = idOf(a);
    if (seen.has(id)) return id;
    seen.set(id, true);
    nodes.push({
      id, title: null, lines: [label(a)], kind,
      addr: a,
      onTap: o.onNode ? () => o.onNode(a) : null,
    });
    return id;
  };

  add(addr, 'entry');

  let frontier = [addr];
  const expandedCallers = new Set([idOf(addr)]);
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const a of frontier) {
      const callers = program ? program.callersOf(a, limit) : [];
      for (const c of callers) {
        const start = c.addr;
        if (start == null) continue;
        const startId = add(start, 'caller');
        addEdge(startId, idOf(a), 'call');
        if (!expandedCallers.has(startId)) {
          expandedCallers.add(startId);
          next.push(start);
        }
      }
    }
    frontier = next;
  }

  frontier = [addr];
  const expandedCallees = new Set([idOf(addr)]);
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const a of frontier) {
      const range = program ? program.functionRange(a) : null;
      if (!range) continue;
      const callees = program.calleesOf(range.start, range.end, limit) || [];
      for (const c of callees) {
        const target = c.addr;
        if (target == null) continue;
        const targetId = add(target, 'callee');
        addEdge(idOf(a), targetId, 'call');
        if (!expandedCallees.has(targetId)) {
          expandedCallees.add(targetId);
          next.push(target);
        }
      }
    }
    frontier = next;
  }
  return { nodes, edges };
}
