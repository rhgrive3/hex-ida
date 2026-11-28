import { Sheet, el, button, list, tapRow, toast, alertDialog, userError, noteBox, codeBlock } from '../../ui.js';
import { addrHex, sizeText } from '../../format.js';
import { showDecompiler, showCfg, showCallGraphPanel } from '../../tools.js';
import { functionViews, openFunctionView } from '../next-views.js';
import { decompile as decompileModel } from '../../decompile.js';
import { t, pick } from '../../i18n.js';
import { buildGoalCandidateSummary, findGoalHighlightLines } from '../function-analysis-presentation.js';

const COMPLETENESS_JA = Object.freeze({
  complete:'完全',
  partial:'一部',
  truncated:'上限まで',
  unsupported:'未対応',
});

function functionName(value, address) {
  return value?.name ?? `sub_${BigInt(address).toString(16).toUpperCase()}`;
}

function stale(error) {
  return error?.name === 'AnalysisSnapshotStaleError'
    || error?.code === 'ANALYSIS_SNAPSHOT_STALE';
}

async function withFreshSnapshot(app, operation, options = {}) {
  const api = app?.analysisQueries;
  if (!api) throw new Error('AnalysisQueryAPI is unavailable');
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const snapshot = await api.snapshot(options);
    try {
      return await operation(api, snapshot);
    } catch (error) {
      last = error;
      if (!stale(error) || attempt > 0) throw error;
    }
  }
  throw last ?? new Error('analysis-query-retry-exhausted');
}

export async function analysisBundle(app, functionId, options = {}) {
  return withFreshSnapshot(app, async (api, snapshot) => {
    const fn = await api.function(snapshot, functionId);
    const resolved = fn?.value?.startAddress ?? fn?.value?.functionId ?? functionId;
    const target = BigInt(resolved);
    const value = fn?.value ?? null;
    if (value == null) return { snapshot, fn, decompile:null, cfg:null, target };
    const decompiled = value.decompiler ?? (value.model
      ? decompileModel(value.model, { name: value.name ?? null, addr:target })
      : null);
    const cfgValue = value.pipeline?.cfg ?? value.semanticAnalysis?.pipeline?.cfg ?? value.cfg ?? null;
    const decompile = decompiled == null ? null : { value:decompiled, completeness:fn.completeness, status:fn.status };
    const cfg = cfgValue == null ? null : { value:cfgValue, completeness:fn.completeness, status:fn.status };
    return { snapshot, fn, decompile, cfg, target };
  }, options);
}

const FUNCTION_PAGE_LIMIT = 600;

async function functionPage(app, text, signal, offset = 0) {
  return withFreshSnapshot(app, (api, snapshot) => api.functions(
    snapshot,
    text ? { text } : {},
    { offset, limit:FUNCTION_PAGE_LIMIT },
    { signal },
  ), { signal });
}

/**
 * Keep the UI consumer on the canonical function pagination contract.  The
 * query API owns the page size and continuation; the panel only requests the
 * next page when the user asks for it.
 */
export function createFunctionPager(fetchPage) {
  let offset = 0;
  let done = false;
  let completeness = 'complete';
  let total = null;
  let totalInvalidated = false;

  return {
    get hasMore() { return !done; },
    get completeness() { return completeness; },
    get total() { return total; },
    async next(options = {}) {
      if (done) return { value:[], completeness, total, done:true, unsupported:false };
      const requestedOffset = offset;
      const response = await fetchPage(requestedOffset, options);
      const rowsValid = Array.isArray(response?.value);
      const value = rowsValid ? response.value : [];
      const pageCompleteness = response?.completeness ?? response?.status?.completeness ?? 'unknown';
      if (!rowsValid || pageCompleteness !== 'complete') completeness = 'partial';

      const page = response?.page;
      const rawTotal = page?.total;
      if (rawTotal == null) {
        total = null;
      } else if (typeof rawTotal !== 'number' || !Number.isSafeInteger(rawTotal) || rawTotal < requestedOffset + value.length) {
        completeness = 'partial';
        total = null;
        totalInvalidated = true;
      } else if (totalInvalidated) {
        total = null;
      } else if (total == null) {
        total = rawTotal;
      } else if (total !== rawTotal) {
        completeness = 'partial';
        total = null;
        totalInvalidated = true;
      }

      if (!page || !Object.hasOwn(page, 'next')) {
        completeness = 'partial';
        done = true;
      } else if (page.next === null) {
        done = true;
      } else {
        const expectedNext = requestedOffset + value.length;
        if (!Number.isSafeInteger(page.next) || page.next <= requestedOffset || page.next !== expectedNext) {
          completeness = 'partial';
          done = true;
        } else {
          offset = page.next;
        }
      }

      return {
        value,
        completeness,
        total,
        done,
        unsupported: response?.completeness === 'unsupported' || !rowsValid,
        status: response?.status ?? null,
      };
    },
  };
}

function productRouter() {
  return (typeof window !== 'undefined' && window.__hexUi?.router) || null;
}

function summaryLegacyOpeners(app) {
  return {
    decompiler:(address) => showDecompiler(app, BigInt(address)),
    cfg:(address) => showCfg(app, BigInt(address)),
    callGraph:(address) => showCallGraphPanel(app, BigInt(address)),
    code:(address) => app.goToFunction(BigInt(address)),
  };
}

function summaryNextViews(app, sheet, address) {
  const views = functionViews({
    address,
    capability:{ canDisassemble:app.store?.get?.('canDisassemble') !== false },
    exclude:['report'],
    primary:'pseudocode',
    ja:true,
  });
  if (!views.length) return null;
  const root = el('section', 'next-views');
  root.append(el('h4', 'sec-title', 'この関数を別の形で見る'));
  const bar = el('div', 'action-bar');
  const legacy = summaryLegacyOpeners(app);
  for (const view of views) {
    const control = button('', 'action-btn' + (view.primary ? ' strong' : ''), () => {
      const opened = openFunctionView(view, { router:productRouter(), legacy });
      if (opened) sheet.close();
      else toast('この形では開けませんでした。');
    });
    control.replaceChildren(
      el('span', 'action-label', view.label),
      el('span', 'action-hint', view.hint),
    );
    if (!view.available) {
      control.disabled = true;
      control.classList.add('is-disabled');
      control.title = view.reason;
      control.querySelector('.action-hint').textContent = view.reason;
    }
    bar.append(control);
  }
  root.append(bar);
  return root;
}

function resolveGoalContext(app, target, options) {
  const safeOpts = options && typeof options === 'object' ? options : {};
  const explicit = safeOpts.goalContext
    || ((safeOpts.goal || safeOpts.candidate || safeOpts.pinpoint || safeOpts.fields)
      ? {
        goal: safeOpts.goal ?? null,
        candidate: safeOpts.candidate ?? null,
        pinpoint: safeOpts.pinpoint ?? null,
        fields: safeOpts.fields ?? null,
        disasm: safeOpts.disasm ?? null,
      }
      : null);
  if (explicit) return { ...explicit, explicit: true };

  const stored = app?.lastGoalContext && typeof app.lastGoalContext === 'object'
    ? app.lastGoalContext
    : null;
  if (stored) {
    const ctxAddr = stored.targetAddr ?? stored.addr ?? stored.address ?? stored.candidate?.addr ?? null;
    if (ctxAddr != null && target != null) {
      try {
        if (BigInt(ctxAddr) === BigInt(target)) {
          return { ...stored, explicit: true };
        }
      } catch {
        // invalid address — never reuse mismatched stored context
      }
    }
  }

  if (app?.lastGoal) {
    return { goal: app.lastGoal, candidate: null, pinpoint: null, fields: null, explicit: false };
  }
  return null;
}

function renderGoalSummaryBanner(summary, highlightLines, onJumpToHighlight) {
  const banner = el('section', 'goal-candidate-summary');
  if (banner.style) {
    banner.style.borderLeft = '3px solid var(--accent, #f59e0b)';
    banner.style.background = 'rgba(245, 158, 11, 0.08)';
    banner.style.padding = '10px 12px';
    banner.style.borderRadius = '6px';
    banner.style.marginBottom = '10px';
  }

  const topRow = el('div', 'goal-summary-head');
  if (topRow.style) {
    topRow.style.display = 'flex';
    topRow.style.alignItems = 'center';
    topRow.style.justifyContent = 'space-between';
    topRow.style.gap = '8px';
    topRow.style.marginBottom = '4px';
  }
  const titleText = summary.goalLabel
    ? pick(`目的との関連: ${summary.goalLabel}`, `Goal context: ${summary.goalLabel}`)
    : pick('目的候補の要約', 'Goal candidate summary');
  const title = el('div', 'goal-summary-title', titleText);
  if (title.style) {
    title.style.fontSize = '12px';
    title.style.fontWeight = '600';
    title.style.opacity = '0.85';
  }
  topRow.append(title);

  if (summary.verdictLabel) {
    const badge = el('span', 'goal-summary-verdict', summary.verdictLabel);
    if (badge.style) {
      badge.style.fontSize = '11px';
      badge.style.fontWeight = '600';
      badge.style.padding = '2px 6px';
      badge.style.borderRadius = '4px';
      badge.style.background = 'rgba(245, 158, 11, 0.18)';
    }
    topRow.append(badge);
  }
  banner.append(topRow);

  const headline = el('div', 'goal-summary-headline', summary.headline);
  if (headline.style) {
    headline.style.fontWeight = '600';
    headline.style.marginBottom = summary.bullets.length ? '6px' : '0';
  }
  banner.append(headline);

  if (summary.bullets.length) {
    const ul = el('ul', 'goal-summary-list');
    if (ul.style) {
      ul.style.margin = '0';
      ul.style.paddingLeft = '18px';
    }
    for (const item of summary.bullets) {
      ul.append(el('li', 'goal-summary-item', item));
    }
    banner.append(ul);
  }

  if (Array.isArray(highlightLines) && highlightLines.length && highlightLines[0] >= 4 && typeof onJumpToHighlight === 'function') {
    const jumpBtn = button(
      pick('該当箇所へ移動', 'Jump to match'),
      'btn sm goal-jump-btn',
      () => onJumpToHighlight(),
    );
    if (jumpBtn.style) {
      jumpBtn.style.marginTop = '8px';
    }
    banner.append(jumpBtn);
  }

  return banner;
}

function renderHighlightedPseudocode(pseudocode, highlightLines) {
  const allLines = String(pseudocode || '').split('\n');
  const trimmedAll = allLines.join('\n').trim();
  if (!trimmedAll) return { element: null, firstHighlighted: null };

  const highlightSet = new Set(Array.isArray(highlightLines) ? highlightLines : []);
  if (!highlightSet.size) {
    const preview = allLines.slice(0, 24).join('\n').trim();
    return { element: preview ? codeBlock(preview) : null, firstHighlighted: null };
  }

  const firstHighlight = Math.min(...highlightSet);
  const maxHighlight = Math.max(...highlightSet);
  const visibleLimit = Math.min(allLines.length, Math.max(24, firstHighlight + 6, Math.min(240, maxHighlight + 6)));
  const pre = el('pre', 'doc-code hex-goal-code');
  let firstHighlighted = null;

  for (let i = 0; i < visibleLimit; i++) {
    const isHit = highlightSet.has(i);
    const lineEl = el('div', isHit ? 'hex-code-line hex-goal-highlight' : 'hex-code-line', allLines[i] || ' ');
    lineEl.setAttribute?.('data-line-index', String(i));
    if (isHit) {
      if (lineEl.style) {
        lineEl.style.borderLeft = '3px solid var(--accent, #f59e0b)';
        lineEl.style.background = 'rgba(245, 158, 11, 0.14)';
        lineEl.style.paddingLeft = '8px';
        lineEl.style.marginLeft = '-11px';
        lineEl.style.display = 'block';
      }
      if (!firstHighlighted) firstHighlighted = lineEl;
    }
    pre.append(lineEl);
  }

  return { element: pre, firstHighlighted };
}

export function showFunctions(app) {
  const region = app.store.get('currentRegion');
  if (!region) { toast('先にファイルを開いてください。'); return; }
  let sequence = 0;
  let controller = null;
  let debounceTimer = 0;
  const sheet = new Sheet('関数', {
    onClose:() => {
      clearTimeout(debounceTimer);
      debounceTimer = 0;
      sequence++;
      controller?.abort('functions-sheet-closed');
      controller = null;
    },
  });
  const status = el('div', 'hint', '関数を確認しています…');
  const field = el('div', 'field');
  const input = el('input');
  input.type = 'search';
  input.placeholder = '名前またはアドレスで検索';
  input.autocapitalize = 'off';
  input.autocomplete = 'off';
  input.spellcheck = false;
  field.append(input);
  const results = list();
  sheet.body.append(field, status, results);

  let pager = null;
  let loaded = 0;
  let loading = false;
  let more = null;

  const updateStatus = (completeness, total) => {
    const count = total != null && total >= loaded
      ? `${total.toLocaleString()} 個中 ${loaded.toLocaleString()} 個を表示`
      : `${loaded.toLocaleString()} 個`;
    status.textContent = `${count} · ${COMPLETENESS_JA[completeness] ?? completeness}`;
  };

  const appendRows = (items) => {
    const fragment = document.createDocumentFragment();
    for (const item of items) {
      const address = item.address ?? item.addr ?? null;
      if (address == null) continue;
      const addr = BigInt(address);
      const details = [addrHex(addr)];
      const size = item.size == null ? null : BigInt(item.size);
      if (size != null && size > 0n) details.push(sizeText(size));
      fragment.append(tapRow(item.name || '名前のない関数', {
        sub:details.join('  ·  '),
        onTap:() => { sheet.close(); app.goToFunction(addr); },
      }));
    }
    results.append(fragment);
  };

  const updateMore = (current, completeness, total) => {
    updateStatus(completeness, total);
    if (!pager?.hasMore) {
      more?.remove();
      more = null;
      return;
    }
    if (!more) more = tapRow(t('search.more'), { onTap:() => { void loadMore(current); } });
    more.replaceChildren(el('div', null, total != null
      ? t('search.showMore', { n:Math.max(0, total - loaded).toLocaleString() })
      : t('search.more')));
    results.append(more);
  };

  const loadMore = async (current) => {
    if (loading || current !== sequence || !pager) return;
    loading = true;
    more?.remove();
    try {
      const page = await pager.next({ signal:controller.signal });
      if (current !== sequence || controller.signal.aborted) return;
      loaded += page.value.length;
      appendRows(page.value);
      updateMore(current, page.completeness, page.total);
    } catch (error) {
      if (current !== sequence && error?.name !== 'AbortError') return;
      if (error?.name !== 'AbortError' && current === sequence) {
        alertDialog('関数を調べられませんでした', userError(error));
        updateMore(current, pager.completeness, pager.total);
      }
    } finally {
      if (current === sequence) loading = false;
    }
  };

  const render = async () => {
    const current = ++sequence;
    controller?.abort();
    controller = new AbortController();
    const text = input.value.trim();
    status.textContent = '関数を確認しています…';
    results.replaceChildren();
    pager = createFunctionPager((offset, options) => functionPage(app, text, options.signal, offset));
    loaded = 0;
    loading = false;
    more = null;
    try {
      const page = await pager.next({ signal:controller.signal });
      if (current !== sequence || controller.signal.aborted || !sheet.root.isConnected) return;
      if (page.unsupported) {
        const reason = page.status?.reason ? `（${page.status.reason}）` : '';
        status.textContent = `関数一覧は現在の解析経路では利用できません${reason}。`;
        results.append(tapRow('関数一覧を作れませんでした', { disabled:true }));
        return;
      }
      loaded = page.value.length;
      appendRows(page.value);
      if (!page.value.length) results.append(tapRow('見つかりませんでした', { disabled:true }));
      updateStatus(page.completeness, page.total);
      updateMore(current, page.completeness, page.total);
    } catch (error) {
      if (error?.name === 'AbortError' || current !== sequence) return;
      status.textContent = '';
      alertDialog('関数を調べられませんでした', userError(error));
    }
  };
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = 0;
      void render();
    }, 120);
  });
  void render();
}

export function showFunctionSummary(app, row, options = {}) {
  const region = app.store.get('currentRegion');
  if (!region) return;
  const address = app.viewer?.rowAddress?.(row) ?? null;
  if (address == null) {
    toast('この行のアドレスを取得できませんでした。');
    return;
  }

  const controller = new AbortController();
  const sheet = new Sheet('関数の要約', { onClose:() => controller.abort('function-summary-closed') });
  const status = el('div', 'hint', '同じ解析スナップショットから要約を作っています…');
  sheet.body.append(status);

  const initialGen = app?.backend?.gen;
  const initialFile = app?.store?.get?.('fileInfo');
  const isCurrentBinary = () => app?.backend?.gen === initialGen && app?.store?.get?.('fileInfo') === initialFile;
  void (async () => {
    try {
      const bundle = await analysisBundle(app, BigInt(address), { signal:controller.signal });
      if (controller.signal.aborted || !sheet.root.isConnected || !isCurrentBinary()) return;
      status.remove();

      const fn = bundle.fn;
      if (!fn || fn.value == null || fn.completeness === 'unsupported') {
        sheet.body.append(noteBox(`この関数は現在の解析経路では扱えません${fn?.status?.reason ? `（${fn.status.reason}）` : ''}。`));
        return;
      }

      const value = fn.value;
      const target = bundle.target;
      const decompiled = bundle.decompile?.value ?? value.decompiler ?? null;
      const rawPseudocode = String(decompiled?.pseudocode || '');
      const goalCtx = resolveGoalContext(app, target, options);
      const highlightLines = goalCtx && rawPseudocode
        ? findGoalHighlightLines(rawPseudocode, { ...goalCtx, functionAddr: target })
        : [];
      const goalSummary = goalCtx
        ? buildGoalCandidateSummary({
          goal: goalCtx.goal,
          candidate: goalCtx.candidate,
          pinpoint: goalCtx.pinpoint,
          fields: goalCtx.fields,
          pseudocode: rawPseudocode || null,
          disasm: goalCtx.disasm ?? value.model?.instructions ?? null,
          functionAddr: target,
        })
        : null;

      const renderedPseudocode = decompiled
        ? renderHighlightedPseudocode(rawPseudocode, highlightLines)
        : { element: null, firstHighlighted: null };
      const firstHighlightedEl = renderedPseudocode.firstHighlighted;
      const shouldShowBanner = Boolean(
        goalSummary && (
          goalCtx.explicit
          || goalSummary.fieldOperations.length
          || goalSummary.matchedStrings.length
          || goalSummary.matchedSymbols.length
          || highlightLines.length
        )
      );
      if (shouldShowBanner) {
        const banner = renderGoalSummaryBanner(
          goalSummary,
          highlightLines,
          firstHighlightedEl
            ? () => { firstHighlightedEl.scrollIntoView?.({ behavior: 'smooth', block: 'center' }); }
            : null,
        );
        sheet.body.append(banner);
      }

      const architecture = value.architectureId
        ?? app.store.get('architecture')
        ?? app.store.get('capability')?.architecture
        ?? 'unknown';
      const abi = value.abiId ?? null;
      const head = el('div', 'fn-head');
      head.append(el('div', 'fn-name', functionName(value, target)));
      head.append(el('div', 'fn-range mono', addrHex(target)));
      sheet.body.append(head);

      const facts = list();
      facts.append(tapRow('解析状態', {
        sub:`${COMPLETENESS_JA[fn.completeness] ?? fn.completeness} · ${architecture}${abi ? ` · ${abi}` : ''}`,
        disabled:true,
      }));
      const start = value.startAddress == null ? target : BigInt(value.startAddress);
      const end = value.endAddress == null ? null : BigInt(value.endAddress);
      if (end != null && end > start) {
        facts.append(tapRow('解析範囲', {
          sub:`${addrHex(start)} – ${addrHex(end)} · ${sizeText(end - start)}`,
          disabled:true,
        }));
      }
      if (fn.status?.reason) facts.append(tapRow('解析上の注意', { sub:String(fn.status.reason), disabled:true }));
      sheet.body.append(facts);

      if (decompiled) {
        if (decompiled.signature) sheet.body.append(el('div', 'code-sig mono', decompiled.signature));
        if (decompiled.summary) sheet.body.append(el('div', 'hint', decompiled.summary));
        if (renderedPseudocode.element) sheet.body.append(renderedPseudocode.element);
      }

      const cfg = bundle.cfg?.value ?? value.pipeline?.cfg ?? null;
      if (Array.isArray(cfg?.blocks)) {
        const edgeCount = cfg.blocks.reduce((sum, block) => sum + (block.successors?.length || 0), 0);
        sheet.body.append(el('div', 'hint', `制御フロー: ${cfg.blocks.length} blocks · ${edgeCount} edges`));
      }

      const views = summaryNextViews(app, sheet, target);
      if (views) sheet.body.append(views);
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError' || !isCurrentBinary()) return;
      status.textContent = '';
      alertDialog('解析できませんでした', userError(error));
    }
  })();
}
