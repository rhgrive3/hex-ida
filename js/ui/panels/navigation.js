import { Sheet, el, button, list, groupRow, tapRow, toast, alertDialog, userError } from "../../ui.js";
import { addrHex, addrText, parseAddress, parseHexPattern } from "../../format.js";
import { numberPattern } from "../numeric-pattern.js";
import { t } from "../../i18n.js";
import { queryStrings } from "../explorer-index.js";

export function showJump(app) {
  const region = app.store.get("currentRegion");
  if (!region) return;
  const sheet = new Sheet(t("jump.title"));

  const field = el("div", "field");
  const input = el("input");
  input.type = "text";
  input.inputMode = "text";
  input.autocapitalize = "off";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = "0x" + addrText(region.vmAddr);
  field.append(input, button(t("btn.go"), "chip", go));
  sheet.body.append(field);

  sheet.body.append(el("div", "hint", t("jump.hint", {
    from: addrHex(region.vmAddr),
    to: addrHex(region.vmAddr + region.size),
  })));

  const quick = list();
  quick.append(groupRow(t("jump.group")));
  quick.append(tapRow(t("jump.sectionStart"), {
    right: addrHex(region.vmAddr),
    onTap: () => { sheet.close(); app.goToAddress(region.vmAddr); },
  }));
  quick.append(tapRow(t("jump.sectionEnd"), {
    right: addrHex(region.vmAddr + region.size),
    onTap: () => { sheet.close(); app.viewer.goToRow(app.viewer.totalRows - 1, "top"); },
  }));
  const slice = app.currentSlice();
  if (slice && slice.info && slice.info.entry != null) {
    quick.append(tapRow(t("jump.entry"), {
      right: addrHex(slice.info.entry),
      onTap: () => { sheet.close(); app.goToAddress(slice.info.entry, { announce: true }); },
    }));
  }
  sheet.body.append(quick);

  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  setTimeout(() => input.focus(), 50);

  function go() {
    const v = parseAddress(input.value);
    if (v == null) { toast(t("jump.invalid")); return; }
    sheet.close();
    app.goToAddress(v, { announce: true });
  }
}

export function showSearch(app) {
  const region = app.store.get("currentRegion");
  if (!region) return;
  const sheet = new Sheet(t("search.title"), {
    onClose: () => { if (running) app.backend.cancelSearch(running); app.backend.onSearchProgress = null; },
  });

  let kind = app.store.get("searchKind") || "asm";

  const chips = el("div", "chips");
  const defs = [
    ["asm", t("search.kind.asm")],
    ["text", t("search.kind.text")],
    ["hex", t("search.kind.hex")],
    ["num", t("search.kind.num")],
    ["addr", t("search.kind.addr")],
  ];
  const chipEls = new Map();
  for (const [k, label] of defs) {
    const c = button(label, "chip", () => setKind(k));
    c.setAttribute("aria-pressed", String(k === kind));
    chipEls.set(k, c);
    chips.append(c);
  }

  const field = el("div", "field");
  const input = el("input");
  input.type = "search";
  input.autocapitalize = "off";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.value = app.store.get("searchQuery") || "";
  const goBtn = button(t("btn.find"), "chip", () => (running ? stop() : run()));
  field.append(input, goBtn);

  const bar = el("div", "progress");
  const fill = el("i");
  bar.append(fill);

  const status = el("div", "hint", "");
  const results = list();

  sheet.body.append(chips, field, bar, status, results);
  setKind(kind);
  setTimeout(() => input.focus(), 50);

  input.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });

  let running = false;

  function setKind(k) {
    kind = k;
    app.store.set({ searchKind: k });
    for (const [key, c] of chipEls) c.setAttribute("aria-pressed", String(key === k));
    input.placeholder = t("search.ph." + k);
    status.textContent = t("search.help." + k, { region: region.name });
  }

  function run() {
    const q = input.value.trim();
    app.store.set({ searchQuery: q });
    if (!q) { toast(t("search.needQuery")); return; }

    if (kind === "addr") {
      const v = parseAddress(q);
      if (v == null) { toast(t("search.badAddr")); return; }
      sheet.close();
      app.goToAddress(v, { announce: true });
      return;
    }
    if (running) app.backend.cancelSearch(running);

    results.replaceChildren();
    fill.style.width = "0%";
    status.textContent = t("search.searching");
    running = true;
    goBtn.textContent = t("btn.stop");

    const params = { regionId: region.id, kind, from: 0 };
    if (kind === "hex") {
      const pat = parseHexPattern(q);
      if (!pat) { toast(t("search.badHex")); running = false; goBtn.textContent = t("btn.find"); return; }
      params.hex = pat;
    } else if (kind === "num") {
      const hexText = numberPattern(q);
      const pat = hexText ? parseHexPattern(hexText) : null;
      if (!pat) { toast(t("search.badNum")); running = false; goBtn.textContent = t("btn.find"); return; }
      params.kind = "hex";
      params.hex = pat;
    } else {
      params.query = q;
    }

    const progress = (p) => {
      if (!p.all) return;
      fill.style.width = Math.min(100, Math.round((p.done / p.all) * 100)) + "%";
      status.textContent = t("search.searchingN", { n: p.hits });
    };

    const request = app.backend.search(params, progress);
    running = request;
    request.then((res) => {
      running = false;
      goBtn.textContent = t("btn.find");
      fill.style.width = "100%";
      if (res.cancelled) status.textContent = t("search.stopped", { n: res.results.length });
      else if (!res.results.length) status.textContent = t("search.none", { region: region.name });
      else {
        status.textContent = t("search.count", { n: res.results.length }) +
          (res.capped ? t("search.capped", { n: res.results.length }) : "");
      }
      render(res.results);
    }).catch((err) => {
      const cancelled = err?.name === "AbortError" || err?.code === "ABORT_ERR";
      running = false;
      goBtn.textContent = t("btn.find");
      status.textContent = cancelled ? t("search.stopped", { n: 0 }) : "";
      if (!cancelled) alertDialog(t("search.failed"), userError(err));
    });
  }

  function stop() {
    app.backend.cancelSearch(running);
    running = false;
    goBtn.textContent = t("btn.find");
    status.textContent = t("search.stopped", { n: 0 });
  }

  const PAGE = 150;

  function render(items) {
    results.replaceChildren();
    let shown = 0;
    const more = tapRow(t("search.more"), { onTap: () => page() });

    const page = () => {
      more.remove();
      const frag = document.createDocumentFragment();
      const end = Math.min(items.length, shown + PAGE);
      for (; shown < end; shown++) {
        const it = items[shown];
        frag.append(tapRow(addrText(it.addr), {
          sub: it.text,
          onTap: () => {
            sheet.close();
            app.viewer.goToRow(it.row, "third");
            app.viewer.mark(it.row);
            app.viewer.select(it.row, false);
            app.store.set({ selectedRow: it.row });
          },
        }));
      }
      results.append(frag);
      if (shown < items.length) {
        more.replaceChildren();
        more.append(el("div", null, t("search.showMore", { n: Math.min(PAGE, items.length - shown) })));
        results.append(more);
      }
    };
    if (items.length) page();
  }
}

function abortFailure(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(reason == null ? 'Operation aborted' : String(reason));
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function throwIfPanelAborted(signal) {
  if (signal?.aborted) throw abortFailure(signal);
}

async function awaitConsumer(promise, signal) {
  if (!signal) return promise;
  throwIfPanelAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, abortFailure(signal));
    signal.addEventListener('abort', onAbort, { once:true });
    Promise.resolve(promise).then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

/**
 * Budgeted toolbar string browser. Unlike the historical panel this reuses the
 * file-scoped StringCollection and the incremental shared string index.
 */
export function showStrings(app) {
  const info = app.store.get('fileInfo');
  if (!info) { toast(t('err.openFirst')); return; }
  const controller = new AbortController();
  const sheet = new Sheet(t('strings.title'), { onClose:() => controller.abort('strings-sheet-closed') });
  const regions = app.store.get('regions') || [];
  const candidates = regions.filter((r) => r.size > 0n &&
    (r.cstrings || /string|cstring|objc_method|objc_class|__const/i.test(r.section || '')));
  const currentRegion = app.store.get('currentRegion');
  const targets = candidates.length ? candidates : (currentRegion ? [currentRegion] : []);
  let active = targets[0] || null;
  let collection = null;
  const rowsByRegion = new Map();
  let renderSerial = 0;

  const chips = el('div', 'chips');
  const field = el('div', 'field');
  const input = el('input');
  input.type = 'search';
  input.placeholder = t('strings.filter');
  input.autocapitalize = 'off';
  input.autocomplete = 'off';
  input.spellcheck = false;
  field.append(input);
  const status = el('div', 'hint', t('strings.scanning'));
  const results = list();
  sheet.body.append(chips, field, status, results);

  const renderRows = async () => {
    const serial = ++renderSerial;
    if (!collection || !active) return;
    const rows = rowsByRegion.get(active.id) || [];
    try {
      const filtered = await queryStrings(rows, input.value, { signal:controller.signal, limit:600 });
      if (controller.signal.aborted || serial !== renderSerial || !sheet.root.isConnected) return;
      results.replaceChildren();
      const pageSize = 120;
      let shown = 0;
      const more = tapRow(t('search.more'), { onTap:() => page() });
      const completeness = collection.complete === false || collection.truncated ? '一部' : '完全';
      const updateStatus = () => {
        status.textContent = `${rows.length.toLocaleString()} 個 · ${completeness}` +
          (filtered.length > pageSize
            ? ` · ${shown.toLocaleString()}/${filtered.length.toLocaleString()}件表示`
            : '') +
          (filtered.length >= 600 ? ' · 検索結果は先頭600件' : '');
      };
      const page = () => {
        more.remove();
        const frag = document.createDocumentFragment();
        const end = Math.min(filtered.length, shown + pageSize);
        for (; shown < end; shown++) {
          const row = filtered[shown];
          frag.append(tapRow(row.text, {
            sub:addrHex(row.addr),
            onTap:() => {
              sheet.close();
              if (typeof app.goToStringAddress === 'function') app.goToStringAddress(active, row.addr);
              else app.goToAddress(row.addr, { announce:true });
            },
          }));
        }
        results.append(frag);
        if (shown < filtered.length) {
          more.replaceChildren();
          more.append(el('div', null, t('search.showMore', {
            n:Math.min(pageSize, filtered.length - shown),
          })));
          results.append(more);
        }
        updateStatus();
      };
      if (filtered.length) page();
      else {
        results.append(tapRow(t('strings.none'), { disabled:true }));
        updateStatus();
      }
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      alertDialog(t('search.failed'), userError(error));
    }
  };

  for (const region of targets) {
    const chip = button(region.section || region.name, 'chip', () => {
      active = region;
      for (const child of chips.children) child.setAttribute('aria-pressed', String(child._region === region));
      void renderRows();
    });
    chip._region = region;
    chip.setAttribute('aria-pressed', String(region === active));
    chips.append(chip);
  }
  input.addEventListener('input', () => { void renderRows(); });

  void (async () => {
    try {
      collection = await awaitConsumer(app.ensureStrings?.(), controller.signal);
      throwIfPanelAborted(controller.signal);
      if (!Array.isArray(collection) || !sheet.root.isConnected) return;
      for (const row of collection) {
        const id = row?.region?.id;
        if (id == null) continue;
        const bucket = rowsByRegion.get(id) || [];
        bucket.push(row);
        rowsByRegion.set(id, bucket);
      }
      await renderRows();
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      status.textContent = '';
      alertDialog(t('search.failed'), userError(error));
    }
  })();
}

/** Canonical xref sheet: consume AnalysisQueryAPI pagination without weakening source completeness. */
export function showXrefs(app, target) {
  const api = app?.analysisQueries;
  if (!api) return;
  const controller = new AbortController();
  const sheet = new Sheet(t('xref.title'), { onClose:() => controller.abort('xrefs-sheet-closed') });
  const status = el('div', 'hint', t('xref.scanning'));
  const results = list();
  const pageSize = 400;
  let snapshot = null;
  let nextOffset = 0;
  let loaded = 0;
  let completeness = null;
  let exactTotal = null;
  let totalTrusted = true;
  let loading = false;
  const more = tapRow(t('search.more'), { onTap:() => { void loadNext(); } });
  sheet.body.append(el('div', 'hint', `${addrHex(target)}\n${t('xref.hint')}`), status, results);

  const updateStatus = () => {
    const state = completeness || 'unknown';
    if (!loaded && nextOffset == null) {
      status.textContent = state === 'complete'
        ? t('xref.none')
        : `この時点では参照を確認できません（解析状態: ${state}）。`;
      return;
    }
    const count = exactTotal != null && exactTotal >= loaded
      ? `${loaded.toLocaleString()}/${exactTotal.toLocaleString()} 件表示`
      : `${loaded.toLocaleString()} 件表示`;
    status.textContent = `${count} · ${state}`;
  };

  const appendRows = (rows) => {
    const frag = document.createDocumentFragment();
    for (const row of rows) {
      const siteRaw = row?.site ?? row?.addr ?? row?.address;
      let site;
      try { site = BigInt(siteRaw); } catch { continue; }
      const fn = app.symbols?.functionAt?.(site) ?? null;
      const owner = fn ? (app.symbols?.nameAt?.(fn.start) || addrHex(fn.start)) : addrHex(site);
      frag.append(tapRow(owner, {
        sub:`${addrHex(site)} · ${String(row.kind || row.refKind || 'reference')}`,
        onTap:() => {
          sheet.close();
          if (fn?.start != null && app.openFunctionReport) app.openFunctionReport(fn.start);
          else app.goToAddress(site, { announce:true });
        },
      }));
    }
    results.append(frag);
  };

  const markPaginationPartial = () => {
    if (completeness == null || completeness === 'complete' || completeness === 'unknown') {
      completeness = 'partial';
    }
    exactTotal = null;
    totalTrusted = false;
    nextOffset = null;
    more.remove();
    updateStatus();
  };

  const mergeCompleteness = (pageCompleteness) => {
    if (completeness == null) {
      completeness = pageCompleteness;
      return;
    }
    if (pageCompleteness === 'complete') return;
    if (completeness === 'complete' || completeness === 'unknown' || pageCompleteness === 'truncated') {
      completeness = pageCompleteness;
    }
  };

  async function loadNext() {
    if (loading || snapshot == null || nextOffset == null) return;
    loading = true;
    more.remove();
    const requestedOffset = nextOffset;
    try {
      const page = await api.xrefs(
        snapshot,
        BigInt(target),
        { offset:requestedOffset, limit:pageSize },
        { signal:controller.signal },
      );
      if (controller.signal.aborted || !sheet.root.isConnected) return;

      const rowsValid = Array.isArray(page?.value);
      const rows = rowsValid ? page.value : [];
      const pageCompleteness = page?.completeness ?? page?.status?.completeness ?? 'unknown';
      mergeCompleteness(pageCompleteness);

      const pageInfo = page?.page;
      if (!rowsValid || !pageInfo || !Object.hasOwn(pageInfo, 'next')) {
        markPaginationPartial();
        return;
      }

      const rawTotal = pageInfo.total;
      if (pageCompleteness !== 'complete') {
        exactTotal = null;
        totalTrusted = false;
      } else if (rawTotal == null) {
        exactTotal = null;
      } else if (typeof rawTotal !== 'number' || !Number.isSafeInteger(rawTotal) || !totalTrusted) {
        markPaginationPartial();
        return;
      } else if (exactTotal == null || exactTotal === rawTotal) {
        if (rawTotal < requestedOffset + rows.length) {
          markPaginationPartial();
          return;
        }
        exactTotal = rawTotal;
      } else {
        markPaginationPartial();
        return;
      }

      appendRows(rows);
      loaded += rows.length;

      const rawNext = pageInfo.next;
      if (rawNext == null) {
        nextOffset = null;
        if (exactTotal != null && loaded < exactTotal) {
          markPaginationPartial();
          return;
        }
        updateStatus();
        return;
      }

      const candidateNext = rawNext;
      const expectedNext = requestedOffset + rows.length;
      if (typeof candidateNext !== 'number' || !Number.isSafeInteger(candidateNext) ||
          candidateNext <= requestedOffset || candidateNext !== expectedNext ||
          (exactTotal != null && candidateNext >= exactTotal)) {
        markPaginationPartial();
        return;
      }

      nextOffset = candidateNext;
      const remaining = exactTotal == null ? pageSize : Math.min(pageSize, exactTotal - loaded);
      more.replaceChildren();
      more.append(el('div', null, t('search.showMore', { n:remaining })));
      results.append(more);
      updateStatus();
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      status.textContent = '';
      alertDialog(t('search.failed'), userError(error));
    } finally {
      loading = false;
    }
  }

  void (async () => {
    try {
      snapshot = await api.snapshot({ signal:controller.signal });
      if (controller.signal.aborted || !sheet.root.isConnected) return;
      await loadNext();
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      status.textContent = '';
      alertDialog(t('search.failed'), userError(error));
    }
  })();
}
