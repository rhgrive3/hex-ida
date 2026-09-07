import assert from 'node:assert/strict';
import { run } from './ai-ui-support.mjs';

await run(async ({ browser, baseUrl }) => {
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 }, locale: 'en-US' });
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const counts = await page.evaluate(async () => {
    let available = false;
    let rejectNextStatus = false;
    let capabilityCalls = 0;
    let statusCalls = 0;
    let selectionCalls = 0;
    const engine = {
      async aiCapabilities() {
        capabilityCalls++;
        return { providers: [{ id: 'fake', label: 'Fake', available: false, models: [{ id: 'fake-model' }] }] };
      },
      async aiStatus() {
        statusCalls++;
        if (rejectNextStatus) {
          rejectNextStatus = false;
          throw new Error('temporary status failure');
        }
        return { providers: [{ id: 'fake', available }] };
      },
      async getAISelection() {
        selectionCalls++;
        return null;
      },
    };
    const { createPanel } = await import('/js/ai/ui/panel.js?issue6264');
    const current = { id: 'issue-6264', title: '', provider: null, model: null, reasoning: null, turns: [] };
    const session = {
      engine,
      current,
      mode: 'chat', style: 'beginner', scope: 'auto', busy: false,
      selectionOf: () => ({ provider: current.provider, model: current.model, reasoning: current.reasoning }),
      setSelection(selection) { Object.assign(current, selection); },
      visibleTurns: () => [],
      list: () => [current],
      syncNamespace() {},
      newConversation: () => false,
    };
    const handlers = {
      contextLabel: () => ({ label: '', actionable: false }),
      onContextTap() {}, onAsk() {}, onCancel() {}, onClose() {},
      onMode() {}, onStyle() {}, onScope() {},
    };
    const panel = createPanel({ session, handlers });
    document.body.append(panel.root);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

    // Two immediate renders share one in-flight request.
    panel.update({ stick: false });
    panel.update({ stick: false });
    await settle();
    const initial = {
      capabilityCalls, statusCalls, selectionCalls,
      available: panel.capabilities().providers[0].available,
    };

    available = true;
    panel.update({ stick: false });
    await settle();
    const becameAvailable = { capabilityCalls, statusCalls, available: panel.capabilities().providers[0].available };

    available = false;
    panel.update({ stick: false });
    await settle();
    const becameUnavailable = { capabilityCalls, statusCalls, available: panel.capabilities().providers[0].available };

    rejectNextStatus = true;
    panel.update({ stick: false });
    await settle();
    const afterFailure = { capabilityCalls, statusCalls };

    available = true;
    panel.update({ stick: false });
    await settle();
    const retried = { capabilityCalls, statusCalls, available: panel.capabilities().providers[0].available };
    panel.root.remove();
    return { initial, becameAvailable, becameUnavailable, afterFailure, retried };
  });
  assert.deepEqual(counts.initial, {
    capabilityCalls: 1, statusCalls: 1, selectionCalls: 1, available: false,
  }, 'concurrent panel renders must share one capability/status request');
  assert.deepEqual(counts.becameAvailable, { capabilityCalls: 2, statusCalls: 2, available: true });
  assert.deepEqual(counts.becameUnavailable, { capabilityCalls: 3, statusCalls: 3, available: false });
  assert.deepEqual(counts.afterFailure, { capabilityCalls: 4, statusCalls: 4 }, 'a rejected refresh must settle and not loop');
  assert.deepEqual(counts.retried, { capabilityCalls: 5, statusCalls: 5, available: true }, 'a later update must retry after rejection');
  await context.close();
  console.log('issue-6264-ai-capability-refresh: PASS');
});
