import {
  h, uiButton, screen, card, emptyState, loadingState, errorState, evidenceBadge,
  listRow, VirtualList,
} from './primitives.js';
import { pick } from '../i18n.js';
import { addrHex } from '../format.js';
import { createProductSurfaceQueries } from '../analysis/query/product-surface.js';

const CLAIM_PAGE_SIZE = 80;

function addressText(value) {
  if (value == null) return '';
  try { return addrHex(typeof value === 'bigint' ? value : BigInt(value)); }
  catch { return String(value); }
}

function claimTitle(claim) {
  return String(claim?.title || pick('解析結果', 'Finding'));
}

function claimVerdict(claim) {
  return typeof claim?.verdict === 'string' && claim.verdict ? claim.verdict : 'unverified';
}

function claimAddress(claim) {
  const value = claim?.address;
  if (value == null) return null;
  try { return typeof value === 'bigint' ? value : BigInt(value); }
  catch { return null; }
}

function isAbort(error, signal) {
  return !!signal?.aborted || error?.name === 'AbortError';
}

function currentQueryError(error) {
  if (error?.code === 'ANALYSIS_SNAPSHOT_STALE' || error?.name === 'AnalysisSnapshotStaleError') {
    return errorState(
      pick('解析結果が更新されました', 'Analysis results changed'),
      pick('現在の解析スナップショットと一致しません。結果画面を開き直してください。', 'The active analysis snapshot changed. Reopen Results to query the current snapshot.'),
    );
  }
  return errorState(
    pick('結果を読み込めませんでした', 'Could not load results'),
    String(error?.message || error),
  );
}

function claimRow(claim, router) {
  const address = claimAddress(claim);
  return listRow({
    title: claimTitle(claim),
    subtitle: address != null ? addressText(address) : '',
    badge: evidenceBadge(claimVerdict(claim)),
    onClick: () => router.navigate('/finding/' + encodeURIComponent(String(claim.claimId))),
  });
}

function renderClaimDetail(app, router, route, routeContext = {}) {
  const s = screen(pick('結果の詳細', 'Finding Detail'), {
    id: 'finding',
    subtitle: pick('現在の解析スナップショットに結び付いた結果を表示します。', 'Shows the finding bound to the current analysis snapshot.'),
  });
  const host = h('div', 'ui-stack');
  host.append(loadingState(pick('結果と根拠を確認しています…', 'Loading finding and evidence…')));
  s.body.append(host);

  const fallbackController = routeContext.signal ? null : new AbortController();
  const signal = routeContext.signal || fallbackController.signal;
  let disposed = false;

  (async () => {
    try {
      const queries = createProductSurfaceQueries(app);
      const snapshot = await queries.snapshot({ signal });
      const result = await queries.claims(
        snapshot,
        { claimId:String(route?.params?.id ?? '') },
        { offset:0, limit:1 },
        { signal },
      );
      if (disposed || signal.aborted) return;

      if (result?.completeness === 'unsupported') {
        host.replaceChildren(errorState(
          pick('この結果は現在の解析に属していません', 'Finding is not part of the current analysis'),
          String(result?.status?.reason || 'claim-report-snapshot-mismatch'),
        ));
        return;
      }

      const claim = Array.isArray(result?.value) ? result.value[0] : null;
      if (!claim) {
        host.replaceChildren(emptyState(
          pick('結果が見つかりません', 'Finding not found'),
          pick('このIDの結果は現在の解析結果に存在しないか、更新されました。', 'This finding ID is not present in the current analysis results or has expired.'),
          uiButton(pick('結果一覧へ', 'Back to Results'), {
            cls:'ui-primary-action',
            onClick:() => router.navigate('/results'),
          }),
        ));
        return;
      }

      const address = claimAddress(claim);
      const detail = card(claimTitle(claim), { subtitle:address != null ? addressText(address) : '' });
      detail.body.append(listRow({
        title:pick('状態', 'Verdict'),
        meta:claim.confidence != null ? `confidence ${Number(claim.confidence).toFixed(2)}` : '',
        badge:evidenceBadge(claimVerdict(claim)),
      }));
      detail.body.append(listRow({
        title:pick('解析スナップショット', 'Analysis snapshot'),
        meta:String(claim.snapshotId || result.snapshotId || snapshot.snapshotId),
      }));
      if (claim.summary) detail.body.append(h('p', 'ui-lead', String(claim.summary)));
      if (Array.isArray(claim.evidenceIds) && claim.evidenceIds.length) {
        detail.body.append(listRow({
          title:pick('根拠', 'Evidence'),
          meta:pick(`${claim.evidenceIds.length} 件`, `${claim.evidenceIds.length} items`),
          badge:evidenceBadge(claimVerdict(claim)),
        }));
      }
      if (Array.isArray(claim.contradictions) && claim.contradictions.length) {
        detail.body.append(listRow({
          title:pick('矛盾する根拠', 'Contradictions'),
          meta:String(claim.contradictions.length),
          badge:evidenceBadge('contradicted'),
        }));
      }
      if (Array.isArray(claim.assumptions) && claim.assumptions.length) {
        detail.body.append(listRow({
          title:pick('前提', 'Assumptions'),
          meta:claim.assumptions.map(String).join(' · '),
          badge:evidenceBadge('unverified'),
        }));
      }

      const actions = h('div', 'ui-actions');
      if (address != null) {
        actions.append(uiButton(pick('該当関数を開く', 'Open function overview'), {
          cls:'ui-primary-action',
          onClick:() => router.navigate('/function/' + address.toString() + '/overview'),
        }));
        actions.append(uiButton(pick('根拠を確認する', 'Review evidence'), {
          cls:'ui-secondary-action',
          onClick:() => router.navigate('/function/' + address.toString() + '/evidence'),
        }));
      }
      actions.append(uiButton(pick('結果一覧に戻る', 'Back to Results'), {
        cls:'ui-secondary-action',
        onClick:() => router.navigate('/results'),
      }));
      detail.body.append(actions);
      host.replaceChildren(detail.root);
    } catch (error) {
      if (!disposed && !isAbort(error, signal)) host.replaceChildren(currentQueryError(error));
    }
  })();

  return {
    root:s.root,
    dispose:() => {
      disposed = true;
      fallbackController?.abort('product-finding-route-disposed');
    },
  };
}

function renderClaimList(app, router, routeContext = {}) {
  const s = screen(pick('結果', 'Results'), {
    id:'results',
    subtitle:pick('確認した答え、根拠、履歴、ピンをここへ集めます。', 'Confirmed answers, evidence, history and pins live here.'),
  });
  const host = h('div', 'ui-stack');
  host.append(loadingState(pick('現在の解析結果を読み込んでいます…', 'Loading current analysis results…')));
  s.body.append(host);

  const fallbackController = routeContext.signal ? null : new AbortController();
  const signal = routeContext.signal || fallbackController.signal;
  let disposed = false;
  let loading = false;
  let snapshot = null;
  let nextOffset = 0;
  let lastCompleteness = 'complete';
  let lastReason = null;
  const claims = [];
  let virtual = null;

  const paint = () => {
    virtual?.dispose();
    virtual = null;
    host.replaceChildren();

    if (!claims.length && nextOffset == null) {
      host.append(emptyState(
        pick('まだ解析結果がありません', 'No analysis results yet'),
        pick('「調べる」で目的を入力すると、答えと根拠をここから辿れるようになります。', 'Investigate a goal to create results you can revisit.'),
        uiButton(pick('調べるへ', 'Go to Investigate'), {
          cls:'ui-primary-action',
          onClick:() => router.navigate('/investigate'),
        }),
      ));
      return;
    }

    if (lastCompleteness !== 'complete') {
      host.append(h(
        'p',
        'ui-partial-note',
        pick(
          `結果は一部です${lastReason ? `: ${lastReason}` : ''}。未解析部分を「該当なし」とは扱いません。`,
          `Results are partial${lastReason ? `: ${lastReason}` : ''}; unanalysed data is not treated as negative evidence.`,
        ),
      ));
    }

    const renderRow = (claim) => claimRow(claim, router);
    if (claims.length > CLAIM_PAGE_SIZE) {
      virtual = new VirtualList({
        items:claims,
        rowHeight:64,
        ariaLabel:pick('解析結果', 'Analysis results'),
        renderRow,
      });
      host.append(virtual.root);
    } else {
      const list = h('div', 'ui-list');
      for (const claim of claims) list.append(renderRow(claim));
      host.append(list);
    }

    if (nextOffset != null) {
      host.append(uiButton(pick('続きを読み込む', 'Load more'), {
        cls:'ui-secondary-action',
        onClick:() => loadNextPage(),
      }));
    }
  };

  const loadNextPage = async () => {
    if (loading || disposed || signal.aborted || nextOffset == null) return;
    loading = true;
    try {
      const queries = createProductSurfaceQueries(app);
      snapshot ||= await queries.snapshot({ signal });
      const result = await queries.claims(
        snapshot,
        {},
        { offset:nextOffset, limit:CLAIM_PAGE_SIZE },
        { signal },
      );
      if (disposed || signal.aborted) return;
      if (result?.completeness === 'unsupported') {
        host.replaceChildren(errorState(
          pick('結果のスナップショットが一致しません', 'Results snapshot mismatch'),
          String(result?.status?.reason || 'claim-report-snapshot-mismatch'),
        ));
        nextOffset = null;
        return;
      }
      const pageClaims = Array.isArray(result?.value) ? result.value : [];
      claims.push(...pageClaims);
      lastCompleteness = result?.completeness || result?.status?.completeness || 'partial';
      lastReason = result?.status?.reason || null;
      nextOffset = result?.page?.next ?? null;
      paint();
    } catch (error) {
      if (!disposed && !isAbort(error, signal)) host.replaceChildren(currentQueryError(error));
    } finally {
      loading = false;
    }
  };

  loadNextPage();
  return {
    root:s.root,
    getState:() => ({ loaded:claims.length }),
    dispose:() => {
      disposed = true;
      virtual?.dispose();
      fallbackController?.abort('product-results-route-disposed');
    },
  };
}

export function renderProductResultsRoute(app, router, route, routeContext = {}) {
  if (route?.route?.id === 'finding' || route?.params?.id != null) {
    return renderClaimDetail(app, router, route, routeContext);
  }
  return renderClaimList(app, router, routeContext);
}
