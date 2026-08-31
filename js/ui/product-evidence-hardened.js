import { FUNCTION_TABS } from './registry.js';
import { h, screen, card, emptyState, loadingState, errorState, evidenceBadge, tabs, listRow } from './primitives.js';
import { addrHex } from '../format.js';

const ja = () => (navigator.language || 'ja').toLowerCase().startsWith('ja');
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

function renderCanonicalEvidence(app, router, route, meta) {
  let address;
  try { address = BigInt(route.params.address); }
  catch {
    const invalid = screen(text('根拠', 'Evidence'), { id:'function' });
    invalid.body.append(errorState(text('関数アドレスが不正です', 'Invalid function address'), String(route.params.address || '')));
    return { root:invalid.root };
  }

  const s = screen(text('根拠', 'Evidence'), {
    id:'function',
    subtitle:addressText(address),
  });
  s.body.append(tabs(FUNCTION_TABS, 'evidence', (next) => router.navigate(`/function/${address.toString()}/${next}`)));
  const content = h('div', 'ui-workspace-content');
  content.append(loadingState(text('根拠を集めています…', 'Collecting evidence…')));
  s.body.append(content);

  (async () => {
    try {
      const snapshot = await app.analysisQueries.snapshot({ signal:meta.signal });
      const rows = [];
      let offset = 0;
      let finalResult = null;
      while (rows.length < MAX_RENDERED_EVIDENCE) {
        const result = await app.analysisQueries.evidence(
          snapshot,
          { functionId:address },
          { offset, limit:PAGE_SIZE },
          { signal:meta.signal },
        );
        finalResult = result;
        if (meta.signal?.aborted) return;
        const pageRows = Array.isArray(result.value) ? result.value : [];
        rows.push(...pageRows);
        const next = result.page?.next;
        if (next == null || next === offset || pageRows.length === 0) break;
        offset = next;
      }
      if (meta.signal?.aborted) return;

      if (!rows.length) {
        const reason = finalResult?.status?.reason || null;
        content.replaceChildren(emptyState(
          text('表示できる根拠がありません', 'No evidence available'),
          reason ? String(reason) : text('現在のsnapshotにはこの関数の根拠がありません。', 'The current snapshot has no evidence for this function.'),
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
          '状態はAnalysisQueryのevidence producerが返したverdictをそのまま表示します。UIではproofやconfidenceから確信度を再判定しません。',
          'Statuses are projections of verdicts returned by the AnalysisQuery evidence producer; the UI does not derive certainty from proof or confidence.',
        ),
      });
      const nodes = [note.root, stack];
      if (finalResult?.completeness !== 'complete' || finalResult?.page?.next != null || rows.length >= MAX_RENDERED_EVIDENCE) {
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
    const view = renderCanonicalEvidence(app, router, route, meta);
    routeHost.append(view.root);
    requestAnimationFrame(() => routeHost.focus({ preventScroll:true }));
    return wrapRouteView(view, routeHost);
  };

  const current = router.current;
  if (current?.route?.id === 'function' && current.params?.tab === 'evidence') {
    router._render(current.fullPath, { replace:true, restoredState:null });
  }
  return installed;
}
