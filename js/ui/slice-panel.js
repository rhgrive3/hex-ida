/*
 * Track 10 (§13 / §19): Contextual Backward/Forward Value-Slice Drawer Panel.
 *
 * Displays cross-function provenance chain steps, source VA jump links,
 * and deobfuscation overlay badges (CFF, MBA, MiniArm64Emu, stack/XOR strings).
 * Pure ESM, zero external runtime dependencies, strictly XSS-safe DOM
 * construction (`textContent` only, never `innerHTML`).
 */

export const SLICE_DIRECTIONS = Object.freeze(['backward', 'forward']);

export const DEOBF_BADGE_KINDS = Object.freeze({
  cff: 'CFF Unflattened',
  mba: 'MBA Simplified',
  'emu-str': 'Emu Decoded String',
  'xor-str': 'XOR Decoded',
  'stack-str': 'Stack String',
  'const-fold': 'Const Folded',
});

const VALID_STEP_ROLES = new Set([
  'source',
  'transform',
  'call-arg',
  'call-ret',
  'mem-load',
  'mem-store',
  'sink',
]);

export function formatVaHex(va) {
  if (typeof va === 'bigint') return `0x${va.toString(16)}`;
  if (typeof va === 'number' && Number.isSafeInteger(va) && va >= 0) {
    return `0x${va.toString(16)}`;
  }
  const s = String(va ?? '').trim();
  if (/^0x[0-9a-f]+$/i.test(s)) return s.toLowerCase();
  if (/^\d+$/.test(s)) return `0x${BigInt(s).toString(16)}`;
  return '0x0';
}

function normalizeDeobfBadge(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const kind = Object.hasOwn(DEOBF_BADGE_KINDS, raw) ? raw : 'const-fold';
    return Object.freeze({
      kind,
      label: DEOBF_BADGE_KINDS[kind] ?? raw,
      detail: '',
    });
  }
  if (typeof raw === 'object') {
    const kind = Object.hasOwn(DEOBF_BADGE_KINDS, raw.kind) ? raw.kind : 'const-fold';
    return Object.freeze({
      kind,
      label: String(raw.label ?? DEOBF_BADGE_KINDS[kind] ?? kind),
      detail: String(raw.detail ?? ''),
      originalExpr: raw.originalExpr != null ? String(raw.originalExpr) : null,
      simplifiedExpr: raw.simplifiedExpr != null ? String(raw.simplifiedExpr) : null,
    });
  }
  return null;
}

function normalizeStep(raw, index) {
  const step = raw && typeof raw === 'object' ? raw : {};
  const role = VALID_STEP_ROLES.has(step.role) ? step.role : 'transform';
  const badges = Array.isArray(step.deobfBadges)
    ? step.deobfBadges.map(normalizeDeobfBadge).filter(Boolean)
    : [];
  return Object.freeze({
    index,
    va: formatVaHex(step.va),
    funcVa: formatVaHex(step.funcVa ?? step.va),
    funcName: String(step.funcName ?? `sub_${formatVaHex(step.funcVa ?? step.va).slice(2)}`),
    expr: String(step.expr ?? ''),
    role,
    depth: Number.isSafeInteger(step.depth) && step.depth >= 0 ? step.depth : 0,
    confidence: typeof step.confidence === 'number' && Number.isFinite(step.confidence)
      ? Math.max(0, Math.min(1, step.confidence))
      : 1.0,
    deobfBadges: Object.freeze(badges),
  });
}

function summarizeDeobfBadges(steps) {
  const counts = Object.create(null);
  let total = 0;
  for (const step of steps) {
    for (const b of step.deobfBadges) {
      counts[b.kind] = (counts[b.kind] ?? 0) + 1;
      total += 1;
    }
  }
  return Object.freeze({ total, byKind: Object.freeze(counts) });
}

/**
 * Pure controller for the contextual Value-Slice Panel.
 */
export function createSlicePanelController(options = {}) {
  const onJumpToVa = typeof options.onJumpToVa === 'function' ? options.onJumpToVa : null;
  const onDirectionChange = typeof options.onDirectionChange === 'function' ? options.onDirectionChange : null;

  let state = {
    open: false,
    direction: 'backward',
    rootTarget: null,
    steps: Object.freeze([]),
    filter: Object.freeze({ onlyDeobfuscated: false, maxDepth: null, search: '' }),
    selectedStepIndex: -1,
    budgetStatus: Object.freeze({ visitedNodes: 0, maxNodes: 256, depth: 0, maxDepth: 4, truncated: false }),
    deobfSummary: Object.freeze({ total: 0, byKind: Object.freeze({}) }),
  };

  const listeners = new Set();

  function emit() {
    const snap = getState();
    for (const fn of listeners) fn(snap);
  }

  function getVisibleSteps() {
    const { onlyDeobfuscated, maxDepth, search } = state.filter;
    const q = search.trim().toLowerCase();
    return state.steps.filter((step) => {
      if (onlyDeobfuscated && step.deobfBadges.length === 0) return false;
      if (maxDepth != null && step.depth > maxDepth) return false;
      if (q) {
        const hay = `${step.funcName} ${step.expr} ${step.va} ${step.deobfBadges.map((b) => `${b.label} ${b.detail}`).join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function getState() {
    return Object.freeze({
      ...state,
      visibleSteps: Object.freeze(getVisibleSteps()),
    });
  }

  function openSlice({ direction = 'backward', rootTarget = null, steps = [], budgetStatus = null } = {}) {
    const dir = direction === 'forward' ? 'forward' : 'backward';
    const normalizedSteps = Object.freeze((Array.isArray(steps) ? steps : []).map(normalizeStep));
    const normalizedRoot = rootTarget && typeof rootTarget === 'object'
      ? Object.freeze({
        va: formatVaHex(rootTarget.va),
        funcVa: formatVaHex(rootTarget.funcVa ?? rootTarget.va),
        funcName: String(rootTarget.funcName ?? ''),
        varName: String(rootTarget.varName ?? ''),
        expr: String(rootTarget.expr ?? ''),
      })
      : null;

    const budget = budgetStatus && typeof budgetStatus === 'object'
      ? Object.freeze({
        visitedNodes: Number(budgetStatus.visitedNodes ?? normalizedSteps.length),
        maxNodes: Number(budgetStatus.maxNodes ?? 256),
        depth: Number(budgetStatus.depth ?? 0),
        maxDepth: Number(budgetStatus.maxDepth ?? 4),
        truncated: Boolean(budgetStatus.truncated),
      })
      : Object.freeze({
        visitedNodes: normalizedSteps.length,
        maxNodes: 256,
        depth: normalizedSteps.reduce((m, s) => Math.max(m, s.depth), 0),
        maxDepth: 4,
        truncated: false,
      });

    state = {
      ...state,
      open: true,
      direction: dir,
      rootTarget: normalizedRoot,
      steps: normalizedSteps,
      selectedStepIndex: normalizedSteps.length > 0 ? 0 : -1,
      budgetStatus: budget,
      deobfSummary: summarizeDeobfBadges(normalizedSteps),
    };
    emit();
    return getState();
  }

  function close() {
    if (!state.open) return getState();
    state = { ...state, open: false };
    emit();
    return getState();
  }

  function setDirection(direction) {
    const nextDir = direction === 'forward' ? 'forward' : 'backward';
    if (nextDir === state.direction) return getState();
    state = { ...state, direction: nextDir };
    if (onDirectionChange) onDirectionChange(nextDir, state.rootTarget);
    emit();
    return getState();
  }

  function setFilter(partial = {}) {
    const nextFilter = Object.freeze({
      onlyDeobfuscated: partial.onlyDeobfuscated != null ? Boolean(partial.onlyDeobfuscated) : state.filter.onlyDeobfuscated,
      maxDepth: partial.maxDepth !== undefined ? (partial.maxDepth == null ? null : Number(partial.maxDepth)) : state.filter.maxDepth,
      search: partial.search != null ? String(partial.search) : state.filter.search,
    });
    state = { ...state, filter: nextFilter };
    emit();
    return getState();
  }

  function selectStep(index) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= state.steps.length) {
      return null;
    }
    state = { ...state, selectedStepIndex: index };
    emit();
    return state.steps[index];
  }

  function jumpToStep(index) {
    const step = selectStep(index);
    if (!step) return { ok: false, reason: 'invalid_step_index' };
    const payload = { va: step.va, funcVa: step.funcVa, funcName: step.funcName, step };
    if (onJumpToVa) onJumpToVa(payload);
    return { ok: true, ...payload };
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return {
    openSlice,
    close,
    setDirection,
    setFilter,
    selectStep,
    jumpToStep,
    getVisibleSteps,
    getState,
    subscribe,
  };
}

/**
 * Renders the contextual Value-Slice Drawer Panel using strictly safe DOM APIs
 * (`textContent` only; zero `innerHTML`).
 */
export function renderSlicePanel(controller, options = {}) {
  const doc = options.document ?? globalThis.document;
  if (!doc || typeof doc.createElement !== 'function') {
    throw new Error('renderSlicePanel requires a document with createElement');
  }

  const ac = new AbortController();
  const { signal } = ac;

  const el = (tag, cls, text) => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = String(text);
    return node;
  };

  const root = el('aside', 'hex-drawer hex-slice-panel');
  root.setAttribute('role', 'complementary');
  root.setAttribute('data-panel', 'slice-drawer');
  root.setAttribute('aria-label', 'Value Slice Provenance');

  const header = el('div', 'hex-drawer-header');
  const titleEl = el('h3', 'hex-drawer-title', 'Value Slice');
  const targetMeta = el('div', 'hex-slice-root-meta', '');
  const closeBtn = el('button', 'hex-drawer-close', '×');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.addEventListener('click', () => controller.close(), { signal });
  header.appendChild(titleEl);
  header.appendChild(targetMeta);
  header.appendChild(closeBtn);

  const controls = el('div', 'hex-slice-controls');
  const backBtn = el('button', 'hex-slice-dir-btn', 'Backward');
  backBtn.type = 'button';
  backBtn.setAttribute('data-dir', 'backward');
  backBtn.addEventListener('click', () => controller.setDirection('backward'), { signal });

  const fwdBtn = el('button', 'hex-slice-dir-btn', 'Forward');
  fwdBtn.type = 'button';
  fwdBtn.setAttribute('data-dir', 'forward');
  fwdBtn.addEventListener('click', () => controller.setDirection('forward'), { signal });

  const deobfOnlyLabel = el('label', 'hex-slice-filter-toggle');
  const deobfOnlyCheck = el('input', 'hex-slice-deobf-only');
  deobfOnlyCheck.type = 'checkbox';
  deobfOnlyCheck.addEventListener('change', () => {
    controller.setFilter({ onlyDeobfuscated: Boolean(deobfOnlyCheck.checked) });
  }, { signal });
  deobfOnlyLabel.appendChild(deobfOnlyCheck);
  deobfOnlyLabel.appendChild(el('span', '', 'Deobfuscated only'));

  const summaryBadge = el('span', 'hex-slice-deobf-summary', '');
  controls.appendChild(backBtn);
  controls.appendChild(fwdBtn);
  controls.appendChild(deobfOnlyLabel);
  controls.appendChild(summaryBadge);

  const budgetBanner = el('div', 'hex-slice-budget-banner', '');
  budgetBanner.setAttribute('data-role', 'budget-banner');

  const listEl = el('ol', 'hex-slice-step-list');
  listEl.setAttribute('data-role', 'step-list');

  // Event delegation for VA jump buttons (zero per-step listener churn)
  listEl.addEventListener('click', (ev) => {
    let target = ev?.target ?? null;
    if (target && typeof target.closest === 'function') {
      target = target.closest('[data-va]');
    } else {
      while (target && target !== listEl && target.getAttribute?.('data-va') == null) {
        target = target.parentNode ?? null;
      }
    }
    if (!target || target === listEl) return;
    const idxAttr = target.getAttribute?.('data-step-index');
    if (idxAttr == null) return;
    const stepIndex = Number.parseInt(idxAttr, 10);
    if (Number.isSafeInteger(stepIndex)) {
      controller.jumpToStep(stepIndex);
    }
  }, { signal });

  root.appendChild(header);
  root.appendChild(controls);
  root.appendChild(budgetBanner);
  root.appendChild(listEl);

  function clearChildren(node) {
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function sync(snap) {
    root.setAttribute('data-open', snap.open ? 'true' : 'false');
    root.setAttribute('data-direction', snap.direction);
    backBtn.setAttribute('aria-pressed', String(snap.direction === 'backward'));
    fwdBtn.setAttribute('aria-pressed', String(snap.direction === 'forward'));
    deobfOnlyCheck.checked = snap.filter.onlyDeobfuscated;

    if (snap.rootTarget) {
      targetMeta.textContent = `${snap.rootTarget.varName || snap.rootTarget.expr} in ${snap.rootTarget.funcName} (${snap.rootTarget.va})`;
    } else {
      targetMeta.textContent = '';
    }

    summaryBadge.textContent = snap.deobfSummary.total > 0
      ? `Deobf overlays: ${snap.deobfSummary.total}`
      : 'No deobf overlays';

    if (snap.budgetStatus.truncated) {
      budgetBanner.textContent = `Budget cap reached (${snap.budgetStatus.visitedNodes}/${snap.budgetStatus.maxNodes} nodes, depth ${snap.budgetStatus.depth}/${snap.budgetStatus.maxDepth})`;
      budgetBanner.setAttribute('data-truncated', 'true');
    } else {
      budgetBanner.textContent = '';
      budgetBanner.setAttribute('data-truncated', 'false');
    }

    clearChildren(listEl);
    for (const step of snap.visibleSteps) {
      const li = el('li', 'hex-slice-step');
      li.setAttribute('data-step-index', String(step.index));
      if (step.index === snap.selectedStepIndex) {
        li.setAttribute('data-selected', 'true');
      }

      const rowHead = el('div', 'hex-slice-step-head');
      const roleSpan = el('span', 'hex-slice-step-role', step.role);
      const vaBtn = el('button', 'hex-slice-va-link', step.va);
      vaBtn.type = 'button';
      vaBtn.setAttribute('data-va', step.va);
      vaBtn.setAttribute('data-step-index', String(step.index));

      const fnSpan = el('span', 'hex-slice-func-name', step.funcName);
      rowHead.appendChild(roleSpan);
      rowHead.appendChild(vaBtn);
      rowHead.appendChild(fnSpan);

      const exprCode = el('code', 'hex-slice-expr', step.expr);
      li.appendChild(rowHead);
      li.appendChild(exprCode);

      if (step.deobfBadges.length > 0) {
        const badgeRow = el('div', 'hex-slice-deobf-badges');
        for (const badge of step.deobfBadges) {
          const b = el('span', `hex-deobf-badge hex-deobf-${badge.kind}`, badge.detail ? `${badge.label}: ${badge.detail}` : badge.label);
          b.setAttribute('data-deobf-badge', badge.kind);
          badgeRow.appendChild(b);
        }
        li.appendChild(badgeRow);
      }

      listEl.appendChild(li);
    }
  }

  sync(controller.getState());
  const unsubscribe = controller.subscribe(sync);

  return {
    element: root,
    destroy: () => {
      unsubscribe();
      ac.abort();
      root.remove?.();
    },
    sync: () => sync(controller.getState()),
  };
}
