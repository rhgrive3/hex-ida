import { installProductUI as installBaseProductUI } from './product.js';
import { createProductSurfaceQueries } from '../analysis/query/product-surface.js';
import { FUNCTION_TABS, EXPLORER_SCOPES } from './registry.js';
import { h, uiButton, screen, card, emptyState, loadingState, errorState, evidenceBadge, tabs, listRow, VirtualList, scrollStrip } from './primitives.js';
import { addrHex } from '../format.js';

import { uiRoot } from '../ui-root.js';

// Follow the in-app language setting (the UI root's lang), not only the
// browser locale, so these screens switch language with the rest of Hex.
const ja = () => (uiRoot()?.lang || navigator.language || 'ja').toLowerCase().startsWith('ja');
const text = (j, e) => ja() ? j : e;
const CLAIM_PAGE_SIZE = 500;
const STRING_PAGE_SIZE = 200;

function addressText(value) {
  try { return addrHex(typeof value === 'bigint' ? value : BigInt(value)); }
  catch { return String(value ?? '—'); }
}

function currentFunctionName(app, address) {
  return app.symbols?.nameAt?.(address) || `sub_${BigInt(address).toString(16).toUpperCase()}`;
}

function verdictBadge(verdict) {
  switch (String(verdict || '').toLowerCase()) {
    case 'confirmed': return 'confirmed';
    case 'supported':
    case 'likely': return 'likely';
    case 'contradicted': return 'contradicted';
    default: return 'unverified';
  }
}

// A matching label is not independent confirmation when the semantic query
// copied the base result into a partial fallback. Only the producer's
// complete, evidence-backed semantic confirmation may promote the base row.
export function baseClassificationBadge(value, result) {
  const base = value?.base;
  const refinement = value?.refinement;
  if (!base || base.classification !== value?.classification) return 'unverified';
  if (result?.completeness !== 'complete') return 'unverified';
  if (value?.refinementReason !== 'semantic-evidence-confirmed-classification') return 'unverified';
  if (!refinement || refinement.classification !== value.classification) return 'unverified';
  if (!Array.isArray(refinement.evidence) || refinement.evidence.length === 0) return 'unverified';
  return 'confirmed';
}

export async function loadCanonicalClaims(queries, snapshot, detailId = null, options = {}) {
  if (detailId != null) {
    return queries.claims(snapshot, { claimId:detailId }, { offset:0, limit:1 }, options);
  }
  const value = [];
  let offset = 0;
  let completeness = 'complete';
  while (true) {
    const result = await queries.claims(snapshot, {}, { offset, limit:CLAIM_PAGE_SIZE }, options);
    const rows = Array.isArray(result?.value) ? result.value : [];
    value.push(...rows);
    if (result?.completeness !== 'complete') completeness = 'partial';
    if (options.signal?.aborted) return { value, completeness:'partial' };
    const page = result?.page;
    if (!page || !Object.hasOwn(page, 'next')) {
      return { value, completeness:'partial' };
    }
    const next = page.next;
    if (next === null) return { value, completeness };
    const expectedNext = offset + rows.length;
    if (!Number.isSafeInteger(next) || next <= offset || next !== expectedNext) {
      return { value, completeness:'partial' };
    }
    offset = next;
  }
}

export async function loadCanonicalStrings(queries, snapshot, filter = {}, options = {}) {
  const value = [];
  let offset = 0;
  let completeness = 'complete';
  let status = null;
  while (true) {
    const result = await queries.strings(snapshot, filter, { offset, limit:STRING_PAGE_SIZE }, options);
    const rows = Array.isArray(result?.value) ? result.value : null;
    if (!rows) return { value, completeness:'partial', status:result?.status || status };
    value.push(...rows);
    status = result?.status || status;
    if (result?.completeness !== 'complete') completeness = 'partial';
    if (options.signal?.aborted) return { value, completeness:'partial', status };
    const page = result?.page;
    if (!page || !Object.hasOwn(page, 'next')) {
      return { value, completeness:'partial', status };
    }
    const expectedNext = offset + rows.length;
    const total = page.total;
    const totalValid = total === null || (Number.isSafeInteger(total) && total >= expectedNext);
    if (page.offset !== offset || page.limit !== STRING_PAGE_SIZE || page.returned !== rows.length || !totalValid) {
      return { value, completeness:'partial', status };
    }
    const next = page.next;
    if (next === null) {
      if (result?.completeness === 'complete' && total !== expectedNext) {
        return { value, completeness:'partial', status };
      }
      return { value, completeness, status };
    }
    if (!Number.isSafeInteger(next) || next <= offset || next !== expectedNext || (total !== null && next >= total)) {
      return { value, completeness:'partial', status };
    }
    offset = next;
  }
}

function inCodeRegion(app, address) {
  const region = (app.store?.get?.('regions') || []).find((r) => r.size > 0n && address >= r.vmAddr && address < r.vmAddr + r.size);
  return !!region?.exec;
}

function staleSnapshot(error) {
  return error?.name === 'AnalysisSnapshotStaleError' || error?.code === 'ANALYSIS_SNAPSHOT_STALE';
}

/*
 * Background discovery can advance the analysis between taking a snapshot and
 * querying it; opening the first function right after a file loaded used to
 * end on "analysis-product-snapshot-stale". Re-read the snapshot and retry.
 */
async function withCurrentSnapshot(queries, signal, operation, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    const snapshot = await queries.snapshot({ signal });
    try {
      return await operation(snapshot);
    } catch (error) {
      if (!staleSnapshot(error) || attempt >= attempts || signal?.aborted) throw error;
    }
  }
}

const CLASSIFICATION_LABELS = {
  APPLICATION:['アプリ独自のコード', 'Application code'],
  SYSTEM:['OS（システム）のコード', 'System code'],
  RUNTIME:['ランタイムのコード', 'Runtime code'],
  SDK:['SDK のコード', 'SDK code'],
  LIBRARY:['ライブラリのコード', 'Library code'],
  GENERATED:['コンパイラが作ったコード', 'Compiler-generated code'],
  UNKNOWN:['まだ分類できません', 'Not classified yet'],
};
const EVIDENCE_LABELS = {
  'custom-objc-type':['独自の Objective-C 型を使う', 'uses an app-defined Objective-C type'],
  'custom-swift-type':['独自の Swift 型を使う', 'uses an app-defined Swift type'],
  'app-specific-string':['アプリ独自の文字列を使う', 'uses an app-specific string'],
  'state-writes':['状態を書き換える', 'writes state'],
  'application-entry-path':['アプリの処理から呼ばれる', 'reached from application code'],
  'not-known-vendor':['既知のライブラリではない', 'not a known vendor library'],
  'uses-runtime-api':['ランタイム API を使う', 'uses runtime APIs'],
  'compiler-generated-name':['コンパイラが付けた名前', 'compiler-generated name'],
  'runtime-symbol-name':['ランタイムの関数名', 'runtime symbol name'],
  'semantic-write-threshold':['しきい値で値を書き換える', 'threshold-guarded write'],
};
const REFINEMENT_LABELS = {
  'semantic-evidence-confirmed-classification':['意味解析でも同じ分類になりました', 'semantic evidence confirmed the classification'],
  'semantic-evidence-refined-classification':['意味解析で分類を修正しました', 'semantic evidence refined the classification'],
  'semantic-evidence-unavailable':['意味解析の根拠はまだありません', 'no semantic evidence yet'],
};
const COMPLETENESS_LABELS = {
  complete:['完全', 'complete'],
  partial:['一部のみ', 'partial'],
  unsupported:['未対応', 'unsupported'],
};

function labelFrom(table, value) {
  const entry = table[String(value ?? '')];
  return entry ? text(entry[0], entry[1]) : String(value ?? '');
}
function classificationLabel(value) { return labelFrom(CLASSIFICATION_LABELS, value || 'UNKNOWN'); }
function refinementLabel(value) { return value ? labelFrom(REFINEMENT_LABELS, value) : ''; }
function completenessLabel(value) { return labelFrom(COMPLETENESS_LABELS, value); }
function evidenceList(items) {
  return (Array.isArray(items) ? items : []).map((item) => {
    const raw = String(item);
    if (EVIDENCE_LABELS[raw]) return labelFrom(EVIDENCE_LABELS, raw);
    const [kind, ...rest] = raw.split(':');
    const detail = rest.join(':');
    if (kind === 'signature-hint' && detail) return text(`既知の関数に似ている: ${detail}`, `signature hint: ${detail}`);
    if (kind === 'signature' && detail) return text(`既知の関数と一致: ${detail}`, `known signature: ${detail}`);
    if (kind === 'system-library' && detail) return text(`システムライブラリ: ${detail}`, `system library: ${detail}`);
    return raw;
  }).join(' · ');
}

function confidenceText(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${Math.round(Math.max(0, Math.min(1, n)) * 100)}%` : '—';
}

function wrapRouteView(view, routeHost) {
  const originalGet = view.getState;
  return {
    ...view,
    getState: () => ({ ...(originalGet ? originalGet() : {}), routeScroll:routeHost.scrollTop }),
    restoreState: (state) => {
      view.restoreState?.(state);
      routeHost.scrollTop = Number(state?.routeScroll) || 0;
    },
  };
}

function prepareRouteShell(appRoot, routeHost, route) {
  appRoot.classList.toggle('ui-code-route', route.route.id === 'code');
  appRoot.classList.toggle('ui-screen-route', route.route.id !== 'code');
  for (const button of appRoot.querySelectorAll('.ui-bottom-nav [data-route-id]')) {
    button.setAttribute('aria-current', button.dataset.routeId === route.route.id ? 'page' : 'false');
  }
  routeHost.hidden = false;
  routeHost.replaceChildren();
}

function renderCanonicalFunctionOverview(app, router, route, meta, queries) {
  let address;
  try { address = BigInt(route.params.address); }
  catch {
    const s = screen(text('関数', 'Function'), { id:'function' });
    s.body.append(errorState(text('関数アドレスが不正です', 'Invalid function address'), String(route.params.address || '')));
    return { root:s.root };
  }
  const s = screen(currentFunctionName(app, address), { id:'function', subtitle:addressText(address) });
  s.body.append(tabs(FUNCTION_TABS, 'overview', (next) => router.navigate(`/function/${address.toString()}/${next}`)));
  const content = h('div', 'ui-workspace-content');
  content.append(loadingState(text('分類根拠を統合しています…', 'Combining classification evidence…')));
  s.body.append(content);

  (async () => {
    try {
      const result = await withCurrentSnapshot(queries, meta.signal, (snapshot) => queries.classification(snapshot, address, { signal:meta.signal }));
      if (meta.signal.aborted) return;
      const value = result.value || {};
      const grid = h('div', 'ui-card-grid');
      const identity = card(text('コードの分類', 'Code identity'), {
        subtitle:text('見つかった手がかりから、この関数がどんな種類のコードかを推定します。', 'Uses the same classification authority as Explorer, with explicit semantic refinement after function analysis.'),
      });
      identity.body.append(listRow({
        title:classificationLabel(value.classification),
        // Confidence rides in the subtitle: the narrow meta column cut it to "確からしさ 3…" on phones.
        subtitle:[evidenceList(value.evidence) || text('十分な分類根拠がありません', 'Not enough classification evidence'), text('確からしさ ', 'confidence ') + confidenceText(value.confidence)].join(' · '),
        badge:evidenceBadge(value.classification === 'UNKNOWN' ? 'unverified' : 'likely'),
      }));
      if (value.base) {
        identity.body.append(listRow({
          title:text('基本の分類', 'Base classification'),
          subtitle:classificationLabel(value.base.classification),
          meta:value.base.knowledgeSourceId ? `knowledge ${value.base.knowledgeSourceId}` : '',
          badge:evidenceBadge(baseClassificationBadge(value, result)),
        }));
      }
      if (value.refinement) {
        identity.body.append(listRow({
          title:text('意味解析による確認', 'Semantic refinement'),
          subtitle:[refinementLabel(value.refinementReason), evidenceList(value.refinement.evidence)].filter(Boolean).join(' — '),
          badge:evidenceBadge(result.completeness === 'complete' ? 'confirmed' : 'likely'),
        }));
      }
      grid.append(identity.root);

      const subsystems = card(text('関連サブシステム', 'Subsystems'));
      const rows = value.subsystems || [];
      if (!rows.length) subsystems.body.append(h('p', 'ui-sub', text('関連するサブシステム（通信・保存・ゲーム処理など）は、まだ見つかっていません。', 'No subsystem inference yet.')));
      for (const item of rows.slice(0, 5)) {
        subsystems.body.append(listRow({
          title:item.subsystem,
          subtitle:[evidenceList(item.evidence), text('確からしさ ', 'confidence ') + confidenceText(item.confidence)].filter(Boolean).join(' · '),
          badge:evidenceBadge(item.confidence >= 0.72 ? 'likely' : 'unverified'),
        }));
      }
      grid.append(subsystems.root);

      const facts = card(text('基本情報', 'Basic facts'));
      facts.body.append(listRow({ title:text('命令数', 'Instructions'), meta:String(value.facts?.instructions ?? '—') }));
      facts.body.append(listRow({ title:text('ブロック数', 'Basic blocks'), meta:String(value.facts?.blocks ?? '—') }));
      facts.body.append(listRow({ title:text('アドレス', 'Address'), meta:addressText(address), mono:true }));
      facts.body.append(listRow({ title:text('解析状態', 'Analysis status'), meta:completenessLabel(result.completeness), badge:evidenceBadge(result.completeness === 'complete' ? 'confirmed' : 'likely') }));
      grid.append(facts.root);

      const next = card(text('次に見る', 'Next steps'));
      for (const [tabId, label] of [
        ['pseudocode', text('疑似Cで読む', 'Read pseudocode')],
        ['flow', text('分岐とループを見る', 'Inspect branches and loops')],
        ['evidence', text('なぜそう言えるか', 'Review evidence')],
        ['runtime', text('実行して確かめる', 'Verify at runtime')],
      ]) next.body.append(listRow({ title:label, onClick:() => router.navigate(`/function/${address.toString()}/${tabId}`) }));
      grid.append(next.root);
      content.replaceChildren(grid);
    } catch (error) {
      if (!meta.signal.aborted) content.replaceChildren(errorState(text('分類を表示できませんでした', 'Could not render classification'), String(error?.message || error)));
    }
  })();

  return { root:s.root };
}

function renderCanonicalClaims(app, router, route, meta, queries) {
  const detailId = route.route.id === 'finding' || route.params?.id != null ? String(route.params.id || '') : null;
  const s = screen(detailId ? text('結果の詳細', 'Finding Detail') : text('結果', 'Results'), {
    id:detailId ? 'finding' : 'results',
    subtitle:detailId ? text('見つかった結果と、その根拠の状態です。', 'Shows the canonical claim and evidence verdict.') : text('自動解析で見つかった結果です。状態は解析エンジンの判定をそのまま表示します。', 'Shows analysed claims using canonical verdicts without UI confidence thresholds.'),
  });
  const host = h('div', 'ui-stack');
  host.append(loadingState(text('結果を確認しています…', 'Loading results…')));
  s.body.append(host);

  (async () => {
    try {
      const result = await withCurrentSnapshot(queries, meta.signal, (snapshot) => loadCanonicalClaims(queries, snapshot, detailId, { signal:meta.signal }));
      if (meta.signal.aborted) return;
      const claims = result.value || [];
      if (detailId) {
        const claim = claims[0];
        if (!claim) {
          host.replaceChildren(emptyState(text('結果が見つかりません', 'Finding not found'), text('現在の解析結果の中に、この結果はありません。', 'This claim is not present in the current snapshot.'), uiButton(text('結果一覧へ', 'Back to Results'), { onClick:() => router.navigate('/results') })));
          return;
        }
        const c = card(claim.title, { subtitle:claim.address != null ? addressText(claim.address) : '' });
        c.body.append(listRow({ title:text('判定', 'Verdict'), badge:evidenceBadge(verdictBadge(claim.verdict)) }));
        if (claim.summary) c.body.append(h('p', 'ui-lead', String(claim.summary)));
        if (claim.contradictions?.length) c.body.append(listRow({ title:text('矛盾する根拠', 'Contradictions'), meta:String(claim.contradictions.length), badge:evidenceBadge('unverified') }));
        const actions = h('div', 'ui-actions');
        // A claim about data (a string, a table) has no function to open;
        // show its bytes instead of a made-up sub_<address> function.
        if (claim.address != null) {
          const target = BigInt(claim.address);
          actions.append(inCodeRegion(app, target)
            ? uiButton(text('該当関数を開く', 'Open function'), { cls:'ui-primary-action', onClick:() => router.navigate(`/function/${target.toString()}/overview`) })
            : uiButton(text('この場所を開く', 'Open this location'), { cls:'ui-primary-action', onClick:() => router.navigate(`/code/${target.toString()}`) }));
        }
        actions.append(uiButton(text('結果一覧へ', 'Back to Results'), { onClick:() => router.navigate('/results') }));
        c.body.append(actions);
        host.replaceChildren(c.root);
        return;
      }
      if (!claims.length) {
        /* Results are the automatic analysis' claims; asking one question in
           Investigate does not add here, so say what fills this screen and
           offer to run it. */
        const run = uiButton(text('自動解析を実行する', 'Run automatic analysis'), { cls:'ui-primary-action', onClick:() => runAutomaticAnalysis(app, router) });
        host.replaceChildren(emptyState(
          text('まだ結果がありません', 'No results yet'),
          text('ここには自動解析で見つかった結果が並びます。ファイル全体を調べて、HP・攻撃力などの目的ごとに答えを探します。', 'Investigate a goal to create claims.'),
          run,
        ));
        return;
      }
      const renderRow = (claim) => listRow({
        title:claim.title,
        subtitle:claim.address != null ? addressText(claim.address) : '',
        badge:evidenceBadge(verdictBadge(claim.verdict)),
        onClick:() => router.navigate(`/finding/${encodeURIComponent(claim.claimId)}`),
      });
      const list = claims.length > 80 ? new VirtualList({ items:claims, rowHeight:64, ariaLabel:text('解析結果', 'Analysis results'), renderRow }) : null;
      if (list) host.replaceChildren(list.root);
      else {
        const rows = h('div', 'ui-list');
        claims.forEach((claim) => rows.append(renderRow(claim)));
        host.replaceChildren(rows);
      }
      if (result.completeness !== 'complete') host.prepend(h('p', 'ui-partial-note', text('結果は一部だけです。まだ処理していない結果を「無い」とは判断しません。', 'The claim set is partial; unprocessed claims are not treated as absent.')));
    } catch (error) {
      if (!meta.signal.aborted) host.replaceChildren(errorState(text('結果を表示できませんでした', 'Could not show results'), String(error?.message || error)));
    }
  })();
  return { root:s.root };
}

function linkedController(parentSignal) {
  const controller = new AbortController();
  if (parentSignal?.aborted) {
    controller.abort(parentSignal.reason);
  } else if (parentSignal) {
    const onParentAbort = () => controller.abort(parentSignal.reason);
    parentSignal.addEventListener('abort', onParentAbort, { once:true });
    controller.signal.addEventListener('abort', () => {
      parentSignal.removeEventListener('abort', onParentAbort);
    }, { once:true });
  }
  return controller;
}

// Runs the whole-file overview in its sheet. When that sheet closes while the
// user is still on Results, Results re-queries so the new claims appear.
function runAutomaticAnalysis(app, router) {
  import('../panels.js').then((panels) => {
    const sheet = panels.showOverview(app);
    if (!sheet) return;
    const previous = sheet.onClose;
    sheet.onClose = (...args) => {
      previous?.(...args);
      if (router.current?.route?.id === 'results') router.navigate('/results?run=' + Date.now(), { replace:true });
    };
  });
}

function renderCanonicalStrings(app, router, route, meta, queries) {
  const s = screen(text('索引', 'Explorer'), { id:'explorer', subtitle:text('ファイルの中の文字列を探します。大きいファイルは少しずつ読み込みます。', 'Searches the canonical string artifact incrementally by region.') });
  const controls = h('div', 'ui-explorer-controls');
  const scopes = h('div', 'ui-scope-tabs');
  scopes.setAttribute('role', 'tablist');
  for (const item of EXPLORER_SCOPES) {
    const button = uiButton(item.label, { cls:'ui-scope' + (item.id === 'strings' ? ' active' : ''), onClick:() => router.navigate(`/explorer/${item.id}`) });
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(item.id === 'strings'));
    scopes.append(button);
  }
  scrollStrip(scopes);
  const search = h('input', 'ui-search-field');
  search.type = 'search';
  search.placeholder = text('文字列を検索', 'Search strings');
  search.value = route.query.get('q') || '';
  controls.append(scopes, search);
  s.body.append(controls);
  const host = h('div', 'ui-explorer-content');
  s.body.append(host);
  let disposed = false;
  let timer = 0;
  let queryController = null;
  let virtual = null;

  const run = async () => {
    queryController?.abort('query-replaced');
    queryController = linkedController(meta.signal);
    const signal = queryController.signal;
    const filter = { text:search.value.trim() };
    host.replaceChildren(loadingState(text('文字列を検索しています…', 'Searching string artifact…')));
    try {
      const result = await withCurrentSnapshot(queries, signal, (snapshot) => loadCanonicalStrings(queries, snapshot, filter, { signal }));
      if (disposed || signal.aborted) return;
      virtual?.dispose(); virtual = null;
      const items = result.value || [];
      if (!items.length) {
        host.replaceChildren(emptyState(text('見つかりません', 'Nothing found'), result.completeness === 'complete' ? text('完全走査済みです。', 'The relevant scope was completely scanned.') : text('まだ未走査領域があります。', 'There are still unscanned regions.')));
        return;
      }
      const renderRow = (item) => listRow({
        title:item.text,
        subtitle:addressText(item.addr),
        meta:item.region?.section || item.region?.name || '',
        onClick:() => router.navigate(`/code/${BigInt(item.addr).toString()}`),
      });
      virtual = new VirtualList({ items, rowHeight:64, ariaLabel:text('文字列検索結果', 'String search results'), renderRow });
      const nodes = [];
      if (result.completeness !== 'complete') {
        const scanned = Number(result.status?.scannedRegions || 0);
        const total = Number(result.status?.totalRegions || 0);
        nodes.push(h('p', 'ui-partial-note', text(`一部の結果です（${scanned}/${total} 領域を検索済み）。まだ検索していない領域に「無い」とは判断しません。`, `Partial result: scanned ${scanned}/${total} regions; unscanned regions are not treated as negative evidence.`)));
      }
      nodes.push(virtual.root);
      host.replaceChildren(...nodes);
    } catch (error) {
      if (!signal.aborted && !disposed) host.replaceChildren(errorState(text('文字列を検索できませんでした', 'Could not search strings'), String(error?.message || error)));
    }
  };

  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 120); });
  run();
  return {
    root:s.root,
    getState:() => ({ query:search.value, virtual:virtual?.getState?.() || null }),
    restoreState:(state) => { if (state?.query != null) search.value = state.query; },
    dispose:() => { disposed = true; clearTimeout(timer); queryController?.abort('strings-view-disposed'); virtual?.dispose(); },
  };
}

export function installHardenedProductUI(app) {
  const installed = installBaseProductUI(app);
  if (!installed?.router) return installed;
  const router = installed.router;
  const originalOnRoute = router.onRoute.bind(router);
  const queries = createProductSurfaceQueries(app);
  const appRoot = document.getElementById('app');
  const routeHost = document.getElementById('ui-route-host');
  if (!appRoot || !routeHost) return installed;

  router.onRoute = (route, meta = {}) => {
    const targetOverview = route.route.id === 'function' && (!route.params.tab || route.params.tab === 'overview');
    const targetClaims = route.route.id === 'results' || route.route.id === 'finding';
    const targetStrings = route.route.id === 'explorer' && route.params.scope === 'strings';
    if (!targetOverview && !targetClaims && !targetStrings) return originalOnRoute(route, meta);
    prepareRouteShell(appRoot, routeHost, route);
    const view = targetOverview
      ? renderCanonicalFunctionOverview(app, router, route, meta, queries)
      : targetClaims
        ? renderCanonicalClaims(app, router, route, meta, queries)
        : renderCanonicalStrings(app, router, route, meta, queries);
    routeHost.append(view.root);
    requestAnimationFrame(() => routeHost.focus({ preventScroll:true }));
    return wrapRouteView(view, routeHost);
  };

  const current = router.current;
  if (current) {
    const targetOverview = current.route.id === 'function' && (!current.params.tab || current.params.tab === 'overview');
    const targetClaims = current.route.id === 'results' || current.route.id === 'finding';
    const targetStrings = current.route.id === 'explorer' && current.params.scope === 'strings';
    if (targetOverview || targetClaims || targetStrings) router._render(current.fullPath, { replace:true, restoredState:null });
  }
  return installed;
}
