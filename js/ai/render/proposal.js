/*
 * Proposal approval.
 *
 * Reads are free; writes are not. Any change to project state (a name, a
 * comment, a type, a patch) is rendered as a before/after with its reason and
 * evidence, and nothing is applied until the user presses Apply on this card.
 * The card owns its own busy/º result state so an approval cannot be
 * double-submitted by an impatient second tap.
 */
import { h, uiButton } from '../../ui/primitives.js';
import { pick } from '../../i18n.js';

const KIND_LABEL = Object.freeze(Object.assign(Object.create(null), {
  rename: ['名前の変更', 'Rename'],
  comment: ['メモの追加', 'Comment'],
  type: ['型の変更', 'Type change'],
  'struct-field': ['構造体フィールド', 'Struct field'],
  patch: ['命令の書き換え', 'Patch'],
  'project-annotation': ['プロジェクト注釈', 'Project annotation'],
}));

function kindLabel(kind) {
  const item = typeof kind === 'string' && Object.hasOwn(KIND_LABEL, kind) ? KIND_LABEL[kind] : null;
  return item ? pick(item[0], item[1]) : kind;
}

function isByteSequence(value) {
  if (value instanceof Uint8Array) return value.length > 0;
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((item) => typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 255);
}

/**
 * Format a byte array or Uint8Array as a space-separated uppercase hex string
 * (e.g. [31, 32, 3, 213] -> "1F 20 03 D5").
 */
export function formatPatchBytes(bytes) {
  if (!isByteSequence(bytes)) return null;
  return Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

export function formatProposalValue(value, kind) {
  if (value == null) return '—';
  if (typeof value === 'string') return value;
  if (isByteSequence(value)) {
    return formatPatchBytes(value);
  }
  if (kind === 'patch' && typeof value === 'object') {
    const hex = formatPatchBytes(value.bytes ?? value.data ?? value.raw);
    const asm = typeof value.assembly === 'string' && value.assembly.trim()
      ? value.assembly.trim()
      : (typeof value.instruction === 'string' && value.instruction.trim() ? value.instruction.trim() : '');
    if (asm && hex) return `${asm} (${hex})`;
    if (hex) return hex;
    if (asm) return asm;
  }
  try { return JSON.stringify(value); } catch { return String(value); }
}

/**
 * @param {object} proposal core proposal record {id, kind, target, before, after, reason, evidenceIds, status}
 * @param {{onApply: function, onReject: function}} handlers
 */
export function renderProposal(proposal, { onApply, onReject } = {}) {
  const root = h('article', 'ai-proposal');
  root.dataset.proposal = proposal.id;
  root.dataset.status = proposal.status || 'pending';
  root.append(h('h3', 'ai-block-title', pick('変更の提案', 'Proposed change') + ' · ' + kindLabel(proposal.kind)));

  const diff = h('dl', 'ai-proposal-diff');
  diff.append(h('dt', null, pick('いま', 'Current')), h('dd', 'mono', formatProposalValue(proposal.before, proposal.kind)));
  diff.append(h('dt', null, pick('提案', 'Proposed')), h('dd', 'mono strong', formatProposalValue(proposal.after, proposal.kind)));
  root.append(diff);

  if (proposal.reason) root.append(h('p', 'ai-proposal-reason', proposal.reason));
  const evidenceCount = (proposal.evidenceIds || []).length;
  root.append(h('p', 'ai-proposal-evidence', pick(`根拠 ${evidenceCount} 件`, `${evidenceCount} supporting evidence`)));

  const status = h('p', 'ai-proposal-status');
  status.setAttribute('role', 'status');
  const actions = h('div', 'ai-proposal-actions');
  const isPatch = proposal.kind === 'patch';
  const apply = uiButton(
    isPatch ? pick('書き換えを適用', 'Apply patch') : pick('適用する', 'Apply'),
    { cls: 'ai-chip primary' },
  );
  const reject = uiButton(
    isPatch ? pick('取り消す', 'Dismiss') : pick('却下', 'Reject'),
    { cls: 'ai-chip' },
  );

  const settle = (text, state) => {
    root.dataset.status = state;
    apply.disabled = true;
    reject.disabled = true;
    status.textContent = text;
  };

  const initialSettled = proposal.status === 'applied' || proposal.status === 'rejected';
  if (initialSettled) {
    settle(
      proposal.status === 'applied' ? pick('適用しました', 'Applied') : pick('却下しました', 'Rejected'),
      proposal.status,
    );
  }

  apply.addEventListener('click', async () => {
    if (apply.disabled) return;
    apply.disabled = true;
    reject.disabled = true;
    status.textContent = pick('適用しています…', 'Applying…');
    try {
      await onApply(proposal);
      settle(pick('適用しました', 'Applied'), 'applied');
    } catch (error) {
      root.dataset.status = 'failed';
      status.textContent = pick('適用できませんでした: ', 'Could not apply: ') + String((error && error.message) || error);
      reject.disabled = false;
    }
  });
  reject.addEventListener('click', () => {
    if (reject.disabled) return;
    try { if (onReject) onReject(proposal); } catch { /* rejection is local state only */ }
    settle(pick('却下しました', 'Rejected'), 'rejected');
  });

  actions.append(apply, reject);
  root.append(actions, status);
  return root;
}

export default renderProposal;
