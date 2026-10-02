import { FUNCTION_TABS } from './registry.js';
import { h, uiButton, screen, card, emptyState, loadingState, errorState, evidenceBadge, tabs, tabPanel, updateScreenTitle, listRow } from './primitives.js';
import { addrHex } from '../format.js';
import { uiRoot } from '../ui-root.js';

const ja = () => (uiRoot()?.lang || navigator.language || 'ja').toLowerCase().startsWith('ja');
const text = (j, e) => ja() ? j : e;
const PAGE_SIZE = 100;
const MAX_RENDERED_EVIDENCE = 5_000;

function addressText(value) {
  try { return addrHex(typeof value === 'bigint' ? value : BigInt(value)); }
  catch { return String(value ?? '—'); }
}

function badgeVerdict(verdict) {
  switch (typeof verdict === 'string' ? verdict.toLowerCase() : '') {
    case 'confirmed': return 'confirmed';
    case 'contradicted': return 'contradicted';
    case 'supported':
    case 'likely': return 'likely';
    default: return 'unverified';
  }
}

function rowTitle(item, index) {
  const evidence = item?.evidence ?? null;
  return String(
    item?.title
      ?? item?.kind
      ?? evidence?.title
      ?? evidence?.reason
      ?? evidence?.kind
      ?? evidence?.type
      ?? evidence?.source
      ?? text(`根拠 ${index + 1}`, `Evidence ${index + 1}`),
  );
}

function rowSubtitle(item) {
  const evidence = item?.evidence ?? null;
  const bits = [];
  const address = item?.address ?? evidence?.address ?? evidence?.addr ?? null;
  if (address != null) bits.push(addressText(address));
  const detail = item?.detail ?? evidence?.detail ?? null;
  if (detail != null && detail !== '') bits.push(String(detail));
  const source = item?.source ?? evidence?.source ?? null;
  if (source != null && source !== '' && source !== detail) bits.push(String(source));
  return bits.join(' · ');
}

// The display name comes from the shell's shared label action, so this route
// never reads a symbol authority itself.
function functionTitle(actions, address) {
  const label = actions?.has?.('function.label') ? actions.run('function.label', address) : null;
  return label || `sub_${BigInt(address).toString(16).toUpperCase()}`;
}

function staleSnapshot(error) {
  return error?.name === 'AnalysisSnapshotStaleError' || error?.code === 'ANALYSIS_SNAPSHOT_STALE';
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

async function loadEvidencePages(app, address, rows, signal) {
  const snapshot = await app.analysisQueries.snapshot({ signal });
  let offset = 0;
  let finalResult = null;
  while (rows.length < MAX_RENDERED_EVIDENCE) {
    const result = await app.analysisQueries.evidence(
      snapshot,
      { functionId:address },
      { offset, limit:PAGE_SIZE },
      { signal },
    );
    finalResult = result;
    if (signal?.aborted) return finalResult;
    const pageRows = Array.isArray(result.value) ? result.value : [];
    rows.push(...pageRows);
    const next = result.page?.next;
    if (next == null || next === offset || pageRows.length === 0) break;
    offset = next;
  }
  return finalResult;
}

function renderCanonicalEvidence(app, router, route, meta, actions) {
  let address;
  try { address = BigInt(route.params.address); }
  catch {
    const invalid = screen(text('根拠', 'Evidence'), { id:'function' });
    invalid.body.append(errorState(text('関数アドレスが不正です', 'Invalid function address'), String(route.params.address || '')));
    return { root:invalid.root };
  }

  // Same heading as the other function tabs: the function, not the tab name.
  const s = screen(functionTitle(actions, address), {
    id:'function',
    subtitle:addressText(address),
  });
  const tabbar = tabs(FUNCTION_TABS, 'evidence', (next) => router.navigate(`/function/${address.toString()}/${next}`), { panelId:'ui-function-panel', label:text('関数の表示', 'Function views') });
  s.body.append(tabbar);
  const content = tabPanel(tabbar, 'ui-workspace-content');
  content.append(loadingState(text('根拠を集めています…', 'Collecting evidence…')));
  s.body.append(content);

  (async () => {
    try {
      const rows = [];
      let finalResult = null;
      // Background discovery may advance the snapshot while pages load; start
      // over on the new snapshot instead of ending on a stale-snapshot error.
      for (let attempt = 1; ; attempt++) {
        rows.length = 0;
        finalResult = null;
        try {
          finalResult = await loadEvidencePages(app, address, rows, meta.signal);
          break;
        } catch (error) {
          if (!staleSnapshot(error) || attempt >= 3 || meta.signal?.aborted) throw error;
        }
      }
      if (meta.signal?.aborted) return;

      if (!rows.length) {
        const reason = finalResult?.status?.reason || null;
        content.replaceChildren(emptyState(
          text('表示できる根拠がありません', 'No evidence available'),
          reason ? String(reason) : text('この関数の根拠は、まだ集まっていません。', 'The current snapshot has no evidence for this function.'),
          /^function-|range/.test(String(reason || ''))
            ? uiButton(text('コードで命令を読む', 'Read instructions in Code'), { cls:'ui-secondary-action', onClick:() => router.navigate(`/code/${address.toString()}`) })
            : uiButton(text('「調べる」で根拠を集める', 'Collect evidence in Investigate'), { cls:'ui-secondary-action', onClick:() => router.navigate('/investigate') }),
        ));
        return;
      }
      const stack = h('div', 'ui-evidence-stack');
      rows.slice(0, MAX_RENDERED_EVIDENCE).forEach((item, index) => {
        const verdict = typeof item?.verdict === 'string' ? item.verdict.toLowerCase() : 'unverified';
        stack.append(listRow({
          title:rowTitle(item, index),
          subtitle:rowSubtitle(item),
          meta:verdict,
          badge:evidenceBadge(badgeVerdict(verdict)),
        }));
      });

      const note = card(text('表示の意味', 'How to read this'), {
        subtitle:text(
          '各行の状態（確認済み・可能性が高い・未確認・矛盾あり）は、解析エンジンの判定をそのまま表示しています。画面側で判定を強めたり弱めたりはしません。',
          'Statuses are projections of verdicts returned by the AnalysisQuery evidence producer; the UI does not derive certainty from proof or confidence.',
        ),
      });
      const nodes = [note.root, stack];
      if (finalResult?.completeness !== 'complete' || finalResult?.page?.next != null || rows.length > MAX_RENDERED_EVIDENCE) {
        nodes.unshift(h('p', 'ui-partial-note', text(
          '根拠集合は部分的です。未取得の根拠を「存在しない」とは扱いません。',
          'The evidence set is partial; evidence outside the returned pages is not treated as absent.',
        )));
      }
      content.replaceChildren(...nodes);
    } catch (error) {
      if (!meta.signal?.aborted) {
        content.replaceChildren(errorState(text('根拠を表示できませんでした', 'Could not show evidence'), String(error?.message || error)));
      }
    }
  })();

  return { root:s.root };
}

export function installCanonicalProductEvidence(app, installed) {
  const router = installed?.router;
  if (!router || !app?.analysisQueries) return installed;
  const previousOnRoute = router.onRoute.bind(router);
  const appRoot = document.getElementById('app');
  const routeHost = document.getElementById('ui-route-host');
  if (!appRoot || !routeHost) return installed;

  router.onRoute = (route, meta = {}) => {
    const targetEvidence = route.route.id === 'function' && route.params.tab === 'evidence';
    if (!targetEvidence) return previousOnRoute(route, meta);
    prepareRouteShell(appRoot, routeHost, route);
    const view = renderCanonicalEvidence(app, router, route, meta, installed.actions);
    routeHost.append(view.root);
    updateScreenTitle(view.root);
    requestAnimationFrame(() => routeHost.focus({ preventScroll:true }));
    return wrapRouteView(view, routeHost);
  };

  const current = router.current;
  if (current?.route?.id === 'function' && current.params?.tab === 'evidence') {
    router._render(current.fullPath, { replace:true, restoredState:null });
  }
  return installed;
}
