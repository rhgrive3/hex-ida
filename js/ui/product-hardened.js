import { installProductUI as installBaseProductUI } from './product.js';
import { createProductSurfaceQueries } from '../analysis/query/product-surface.js';
import { FUNCTION_TABS, EXPLORER_SCOPES } from './registry.js';
import { h, uiButton, screen, card, emptyState, loadingState, errorState, evidenceBadge, tabs, listRow, VirtualList } from './primitives.js';
import { addrHex } from '../format.js';

const ja = () => (navigator.language || 'ja').toLowerCase().startsWith('ja');
const text = (j, e) => ja() ? j : e;

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
    default: return 'unverified';
  }
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
      const snapshot = await queries.snapshot({ signal:meta.signal });
      const result = await queries.classification(snapshot, address, { signal:meta.signal });
      if (meta.signal.aborted) return;
      const value = result.value || {};
      const grid = h('div', 'ui-card-grid');
      const identity = card(text('コードの分類', 'Code identity'), {
        subtitle:text('Explorerと同じ分類authorityを使い、関数解析後はsemantic evidenceで明示的にrefineします。', 'Uses the same classification authority as Explorer, with explicit semantic refinement after function analysis.'),
      });
      identity.body.append(listRow({
        title:String(value.classification || 'UNKNOWN'),
        subtitle:(value.evidence || []).join(' · ') || text('十分な分類根拠がありません', 'Not enough classification evidence'),
        meta:`confidence ${Number(value.confidence || 0).toFixed(2)}`,
        badge:evidenceBadge(value.classification === 'UNKNOWN' ? 'unverified' : 'likely'),
      }));
      if (value.base) {
        identity.body.append(listRow({
          title:text('基礎分類', 'Base classification'),
          subtitle:String(value.base.classification || 'UNKNOWN'),
          meta:value.base.knowledgeSourceId ? `knowledge ${value.base.knowledgeSourceId}` : '',
          badge:evidenceBadge(value.base.classification === value.classification ? 'confirmed' : 'unverified'),
        }));
      }
      if (value.refinement) {
        identity.body.append(listRow({
          title:text('Semantic refinement', 'Semantic refinement'),
          subtitle:value.refinementReason || '',
          meta:(value.refinement.evidence || []).join(' · '),
          badge:evidenceBadge(result.completeness === 'complete' ? 'confirmed' : 'likely'),
        }));
      }
      grid.append(identity.root);

      const subsystems = card(text('関連サブシステム', 'Subsystems'));
      const rows = value.subsystems || [];
      if (!rows.length) subsystems.body.append(h('p', 'ui-sub', text('サブシステム推定はまだありません。', 'No subsystem inference yet.')));
      for (const item of rows.slice(0, 5)) {
        subsystems.body.append(listRow({
          title:item.subsystem,
          subtitle:(item.evidence || []).join(' · '),
          meta:`confidence ${Number(item.confidence || 0).toFixed(2)}`,
          badge:evidenceBadge(item.confidence >= 0.72 ? 'likely' : 'unverified'),
        }));
      }
      grid.append(subsystems.root);

      const facts = card(text('基本情報', 'Basic facts'));
      facts.body.append(listRow({ title:text('命令数', 'Instructions'), meta:String(value.facts?.instructions ?? '—') }));
      facts.body.append(listRow({ title:text('ブロック数', 'Basic blocks'), meta:String(value.facts?.blocks ?? '—') }));
      facts.body.append(listRow({ title:text('アドレス', 'Address'), meta:addressText(address), mono:true }));
      facts.body.append(listRow({ title:text('解析状態', 'Analysis status'), meta:result.completeness, badge:evidenceBadge(result.completeness === 'complete' ? 'confirmed' : 'likely') }));
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
    subtitle:detailId ? text('canonical claimと根拠状態を表示します。', 'Shows the canonical claim and evidence verdict.') : text('解析済みclaimをcanonical verdictのまま表示します。', 'Shows analysed claims using canonical verdicts without UI confidence thresholds.'),
  });
  const host = h('div', 'ui-stack');
  host.append(loadingState(text('結果を確認しています…', 'Loading results…')));
  s.body.append(host);

  (async () => {
    try {
      const snapshot = await queries.snapshot({ signal:meta.signal });
      const result = await queries.claims(snapshot, detailId ? { claimId:detailId } : {}, { offset:0, limit:detailId ? 1 : 500 }, { signal:meta.signal });
      if (meta.signal.aborted) return;
      const claims = result.value || [];
      if (detailId) {
        const claim = claims[0];
        if (!claim) {
          host.replaceChildren(emptyState(text('結果が見つかりません', 'Finding not found'), text('現在のsnapshotにこのclaimはありません。', 'This claim is not present in the current snapshot.'), uiButton(text('結果一覧へ', 'Back to Results'), { onClick:() => router.navigate('/results') })));
          return;
        }
        const c = card(claim.title, { subtitle:claim.address != null ? addressText(claim.address) : '' });
        c.body.append(listRow({ title:text('Verdict', 'Verdict'), meta:claim.verdict, badge:evidenceBadge(verdictBadge(claim.verdict)) }));
        if (claim.summary) c.body.append(h('p', 'ui-lead', String(claim.summary)));
        if (claim.contradictions?.length) c.body.append(listRow({ title:text('矛盾する根拠', 'Contradictions'), meta:String(claim.contradictions.length), badge:evidenceBadge('unverified') }));
        const actions = h('div', 'ui-actions');
        if (claim.address != null) actions.append(uiButton(text('該当関数を開く', 'Open function'), { cls:'ui-primary-action', onClick:() => router.navigate(`/function/${BigInt(claim.address).toString()}/overview`) }));
        actions.append(uiButton(text('結果一覧へ', 'Back to Results'), { onClick:() => router.navigate('/results') }));
        c.body.append(actions);
        host.replaceChildren(c.root);
        return;
      }
      if (!claims.length) {
        host.replaceChildren(emptyState(text('まだ結果がありません', 'No results yet'), text('「調べる」で目的を入力してください。', 'Investigate a goal to create claims.')));
        return;
      }
      const renderRow = (claim) => listRow({
        title:claim.title,
        subtitle:claim.address != null ? addressText(claim.address) : '',
        meta:claim.verdict,
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
      if (result.completeness !== 'complete') host.prepend(h('p', 'ui-partial-note', text('結果集合は部分的です。未処理claimを「存在しない」とは扱いません。', 'The claim set is partial; unprocessed claims are not treated as absent.')));
    } catch (error) {
      if (!meta.signal.aborted) host.replaceChildren(errorState(text('結果を表示できませんでした', 'Could not show results'), String(error?.message || error)));
    }
  })();
  return { root:s.root };
}

function linkedController(parentSignal) {
  const controller = new AbortController();
  if (parentSignal?.aborted) controller.abort(parentSignal.reason);
  else if (parentSignal) parentSignal.addEventListener('abort', () => controller.abort(parentSignal.reason), { once:true });
  return controller;
}

function renderCanonicalStrings(app, router, route, meta, queries) {
  const s = screen(text('索引', 'Explorer'), { id:'explorer', subtitle:text('文字列artifactをregion単位で増分検索します。', 'Searches the canonical string artifact incrementally by region.') });
  const controls = h('div', 'ui-explorer-controls');
  const scopes = h('div', 'ui-scope-tabs');
  for (const item of EXPLORER_SCOPES) {
    const button = uiButton(item.label, { cls:'ui-scope' + (item.id === 'strings' ? ' active' : ''), onClick:() => router.navigate(`/explorer/${item.id}`) });
    button.setAttribute('aria-selected', String(item.id === 'strings'));
    scopes.append(button);
  }
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
    host.replaceChildren(loadingState(text('文字列artifactを検索しています…', 'Searching string artifact…')));
    try {
      const snapshot = await queries.snapshot({ signal });
      const result = await queries.strings(snapshot, { text:search.value.trim() }, { offset:0, limit:200 }, { signal });
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
        nodes.push(h('p', 'ui-partial-note', text(`部分結果: ${scanned}/${total} regionを走査。未走査領域を「該当なし」とは扱いません。`, `Partial result: scanned ${scanned}/${total} regions; unscanned regions are not treated as negative evidence.`)));
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
