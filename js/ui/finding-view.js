import { card, emptyState, evidenceBadge, h, listRow, screen, uiButton } from './primitives.js';
import { genericEvidenceStatus } from './evidence-model.js';
import { findFindingById, findingAddress, findingIdentity } from './finding-route.js';
import { addrHex } from '../format.js';
import { uiRoot } from '../ui-root.js';

const ja = () => (uiRoot()?.lang || navigator.language || 'ja').toLowerCase().startsWith('ja');
const text = (j, e) => ja() ? j : e;

function addressText(value) {
  try { return addrHex(typeof value === 'bigint' ? value : BigInt(value)); } catch { return String(value || '—'); }
}

function titleOf(item) {
  return String(item?.title || item?.label || item?.goal?.text || item?.goal || text('解析結果', 'Finding'));
}

function badgeOf(item) {
  return evidenceBadge(item?.confirmed ? 'confirmed' : item?.confidence > 0.7 ? 'likely' : 'unverified');
}

function evidenceTitle(item, index) {
  return String(item?.reason || item?.kind || item?.type || item?.source || item?.family || text(`根拠 ${index + 1}`, `Evidence ${index + 1}`));
}

function evidenceSubtitle(item) {
  const bits = [];
  if (item?.address != null) bits.push(addressText(item.address));
  else if (item?.addr != null) bits.push(addressText(item.addr));
  if (item?.row != null) bits.push('row ' + item.row);
  if (item?.provenance?.group) bits.push(String(item.provenance.group));
  else if (item?.group) bits.push(String(item.group));
  if (item?.detail) bits.push(String(item.detail));
  return bits.join(' · ');
}

export function renderFindingDetail(app, router, route) {
  const report = app.autoReport && app.autoReport.report;
  const findings = report && (report.findings || report.results || report.goals);
  const id = route?.params?.id == null ? null : String(route.params.id);
  const item = findFindingById(Array.isArray(findings) ? findings : [], id);
  const s = screen(item ? titleOf(item) : text('結果が見つかりません', 'Finding not found'), {
    id: 'finding',
    subtitle: item ? text('保存された解析結果の詳細', 'Saved analysis finding detail') : text('指定された結果IDは現在の解析スナップショットにありません。', 'That finding id is not present in the current analysis snapshot.'),
  });
  if (!item) {
    s.body.append(emptyState(
      text('この結果は見つかりません', 'Finding not found'),
      text('一覧へ戻って現在の解析結果を確認してください。別の結果へ黙って置き換えることはしません。', 'Return to Results to inspect the current findings. Hex will not silently substitute another finding.'),
      uiButton(text('結果一覧へ', 'Back to Results'), { cls: 'ui-primary-action', onClick: () => router.navigate('/results') }),
    ));
    return { root: s.root };
  }

  const address = findingAddress(item);
  const summary = item.summary || item.reason || item.why || item.description || '';
  const detail = card(text('解析結果', 'Finding'));
  if (summary) detail.body.append(h('p', 'ui-lead', String(summary)));
  detail.body.append(listRow({ title: text('識別子', 'Finding id'), meta: findingIdentity(item) || '—', mono: true }));
  detail.body.append(listRow({ title: text('状態', 'Status'), badge: badgeOf(item) }));
  if (address != null) detail.body.append(listRow({ title: text('関連アドレス', 'Related address'), meta: addressText(address), mono: true, onClick: () => router.navigate('/function/' + BigInt(address).toString() + '/overview') }));
  const provenance = item.snapshotId ?? item.runId ?? item.provenance?.snapshotId ?? item.provenance?.runId ?? null;
  if (provenance != null) detail.body.append(listRow({ title: text('解析スナップショット', 'Analysis snapshot'), meta: String(provenance), mono: true }));
  s.body.append(detail.root);

  const evidence = Array.isArray(item.evidence) ? item.evidence : [];
  if (evidence.length) {
    const list = h('div', 'ui-evidence-stack');
    evidence.slice(0, 100).forEach((entry, index) => list.append(listRow({
      title: evidenceTitle(entry, index),
      subtitle: evidenceSubtitle(entry),
      badge: evidenceBadge(genericEvidenceStatus(entry)),
    })));
    const evidenceCard = card(text('根拠', 'Evidence'));
    evidenceCard.body.append(list);
    s.body.append(evidenceCard.root);
  }

  const actions = h('div', 'ui-actions');
  if (address != null) actions.append(uiButton(text('関連関数を開く', 'Open related function'), { cls: 'ui-primary-action', onClick: () => router.navigate('/function/' + BigInt(address).toString() + '/overview') }));
  actions.append(uiButton(text('結果一覧へ', 'Back to Results'), { cls: 'ui-secondary-action', onClick: () => router.navigate('/results') }));
  s.body.append(actions);
  return { root: s.root };
}
