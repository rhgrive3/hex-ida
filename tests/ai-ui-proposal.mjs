/*
 * Proposal approval.
 *
 * Reading is free; changing project state is not. This covers the whole gate:
 * a proposal is only ever a card until the user presses Apply, Apply performs
 * the real mutation, Reject settles it, and a proposal whose target moved
 * underneath it fails loudly instead of writing the wrong thing.
 */
import { openApp, reporter, run, stubEngine, ask } from './ai-ui-support.mjs';

await run(async ({ browser }) => {
  const { check, state } = reporter();
  const { context, page, errors } = await openApp(browser, { width: 1440, height: 900, sample: true });

  const target = await page.evaluate(() => '0x' + window.__app.codeRegion().vmAddr.toString(16));
  /* `before` is what the workbench holds right now; the apply path re-reads it
     and refuses when the two disagree. */
  const currentName = await page.evaluate(() => window.__app.symbols.nameAt(BigInt(window.__app.codeRegion().vmAddr)) || null);

  /* Use the runtime-owned stores so this exercises the real approval authority. */
  await page.evaluate(async () => {
    const runtime = await window.__hexAi.engine.runtime();
    window.__hexProposals = runtime.proposalStore;
    for (const id of ['ev_a', 'ev_b', 'ev_c']) {
      runtime.evidenceStore.add({
        id, kind: 'ui-test', status: 'supported', sourceTool: 'ui-test', title: id,
        summary: 'bounded proposal approval evidence',
      });
    }
  });
  await page.evaluate(({ target: address, current }) => {
    window.__hexProposals.create({
      id: 'proposal_1', kind: 'rename', target: address, before: current, after: 'updateExperience',
      reason: '報酬計算のあとに XP フィールドへ書き込んでいるため。', evidenceIds: ['ev_a', 'ev_b', 'ev_c'],
    });
  }, { target, current: currentName });

  await stubEngine(page, {
    answer: '名前を付けておくと後の調査が楽になります。',
    actions: [{ kind: 'review-proposal', target: 'proposal_1', label: '変更案を確認' }],
  });

  await page.click('#ai-launcher');
  await page.waitForTimeout(150);
  await ask(page, 'この関数に名前を提案して');
  await page.waitForTimeout(300);

  const card = await page.evaluate(() => {
    const node = document.querySelector('.ai-proposal');
    if (!node) return null;
    return {
      status: node.dataset.status,
      title: node.querySelector('.ai-block-title')?.textContent,
      before: node.querySelectorAll('.ai-proposal-diff dd')[0]?.textContent,
      liveName: window.__app.symbols.nameAt(BigInt(window.__app.codeRegion().vmAddr)),
      after: node.querySelectorAll('.ai-proposal-diff dd')[1]?.textContent,
      reason: node.querySelector('.ai-proposal-reason')?.textContent,
      evidence: node.querySelector('.ai-proposal-evidence')?.textContent,
      buttons: [...node.querySelectorAll('.ai-proposal-actions .ai-chip')].map((n) => n.textContent),
      applied: window.__app.symbols.nameAt(BigInt(window.__app.codeRegion().vmAddr)),
    };
  });
  check('a proposal renders as a before/after card', !!card && /名前の変更/.test(card.title || ''), JSON.stringify(card && card.title));
  const displayedCurrentName = card?.liveName == null ? '—' : card.liveName;
  check('the card states current, proposed, reason and evidence count',
    card && card.before === displayedCurrentName && card.after === 'updateExperience' && /報酬計算/.test(card.reason) && /3/.test(card.evidence), JSON.stringify(card));
  check('the card offers exactly one apply and one reject', card && card.buttons.length === 2, JSON.stringify(card && card.buttons));
  check('nothing is applied before the user acts', card && card.status === 'pending' && card.applied !== 'updateExperience', String(card && card.applied));

  const applied = await page.evaluate(async () => {
    const node = document.querySelector('.ai-proposal');
    node.querySelectorAll('.ai-proposal-actions .ai-chip')[0].click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const addr = BigInt(window.__app.codeRegion().vmAddr);
    return {
      status: node.dataset.status,
      message: node.querySelector('.ai-proposal-status')?.textContent,
      disabled: [...node.querySelectorAll('.ai-proposal-actions .ai-chip')].every((n) => n.disabled),
      symbolName: window.__app.symbols.nameAt(addr),
      noteName: window.__app.notes.nameOf(addr),
      audit: window.__hexProposals.audit.map(({ type, proposalId }) => `${type}:${proposalId}`),
    };
  });
  check('Apply approves and then performs the real rename',
    applied.status === 'applied' && applied.symbolName === 'updateExperience' && applied.noteName === 'updateExperience',
    JSON.stringify(applied));
  check('the approval is auditable and ordered', applied.audit.join(',') === [
    'proposal-created:proposal_1', 'proposal-approved:proposal_1',
    'proposal-applying:proposal_1', 'proposal-applied:proposal_1',
  ].join(','), applied.audit.join(','));
  check('an applied card cannot be applied twice', applied.disabled && /適用しました|Applied/.test(applied.message || ''), applied.message);

  /* Reject leaves project state alone. */
  await page.evaluate(({ target: address }) => {
    window.__hexProposals.create({
      id: 'proposal_2', kind: 'comment', target: address, before: null, after: 'XP をここで書く',
      reason: 'メモ', evidenceIds: ['ev_a'],
    });
  }, { target });
  await stubEngine(page, {
    answer: 'メモを残しますか。',
    actions: [{ kind: 'review-proposal', target: 'proposal_2', label: '変更案を確認' }],
  });
  await ask(page, 'メモを提案して');
  await page.waitForTimeout(300);
  const rejected = await page.evaluate(async () => {
    const node = [...document.querySelectorAll('.ai-proposal')].pop();
    node.querySelectorAll('.ai-proposal-actions .ai-chip')[1].click();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const addr = BigInt(window.__app.codeRegion().vmAddr);
    return {
      status: node.dataset.status,
      comment: window.__app.notes.comment(addr),
      audit: (() => {
        const entry = window.__hexProposals.audit.at(-1);
        return entry ? `${entry.type}:${entry.proposalId}` : null;
      })(),
    };
  });
  check('Reject settles the card and writes nothing',
    rejected.status === 'rejected' && !rejected.comment && rejected.audit === 'proposal-rejected:proposal_2', JSON.stringify(rejected));

  /* A stale proposal must fail rather than overwrite newer work. */
  await page.evaluate(({ target: address }) => {
    window.__hexProposals.create({
      id: 'proposal_3', kind: 'rename', target: address, before: 'oldName', after: 'newName',
      reason: '古い前提', evidenceIds: ['ev_a'],
    });
  }, { target });
  await stubEngine(page, {
    answer: '別の名前も提案します。',
    actions: [{ kind: 'review-proposal', target: 'proposal_3', label: '変更案を確認' }],
  });
  await ask(page, 'もう一度名前を提案して');
  await page.waitForTimeout(300);
  const stale = await page.evaluate(async () => {
    const node = [...document.querySelectorAll('.ai-proposal')].pop();
    node.querySelectorAll('.ai-proposal-actions .ai-chip')[0].click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const addr = BigInt(window.__app.codeRegion().vmAddr);
    return {
      status: node.dataset.status,
      message: node.querySelector('.ai-proposal-status')?.textContent || '',
      symbolName: window.__app.symbols.nameAt(addr),
      audit: (() => {
        const entry = window.__hexProposals.audit.at(-1);
        return entry ? `${entry.type}:${entry.proposalId}` : null;
      })(),
    };
  });
  check('a proposal whose target moved fails instead of overwriting',
    stale.status === 'failed' && stale.symbolName === 'updateExperience' && /適用できません|Could not apply/.test(stale.message),
    JSON.stringify(stale));
  check('the stale attempt is recorded', stale.audit === 'proposal-stale:proposal_3', String(stale.audit));

  check('no page errors during the approval flow', errors.length === 0, errors.slice(0, 3).join(' | '));
  await context.close();
  return state.failures;
});
