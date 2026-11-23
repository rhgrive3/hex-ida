import test from 'node:test';
import assert from 'node:assert/strict';

import { createActionRunner } from '../../js/ai/interaction/actions.js';
import { formatPatchBytes, formatProposalValue } from '../../js/ai/render/proposal.js';
import { actionButtonLabel } from '../../js/ai/render/message.js';
import { TASKS, detectTask, taskHint } from '../../js/ai/prompts/task.js';
import { composeContextBlock } from '../../js/ai/prompts/compose.js';
import { resolveScope } from '../../js/ai/ui/modes.js';
import { createLocalEngine, localChatDependencies } from '../../js/ai/ui/local-engine-base.js';
import { AI_ACTION_KINDS } from '../../js/ai/schema.js';
import { normalizeResponse } from '../../js/ai/render/normalize.js';
import { workbenchContext, stagedPatchesOf } from '../../js/ai/ui/workbench.js';
import { suggestionsFor } from '../../js/ai/ui/assistant.js';

test('Goal 1: emulate-function and open-patch-editor actions wire through app/UI callbacks', async () => {
  const calls = [];
  const actions = {
    map: new Map([
      ['emulate.function', (addr) => calls.push(['emulate.function', addr])],
      ['patch.open', (addr, act) => calls.push(['patch.open', addr, act.kind])],
    ]),
    has(id) { return this.map.has(id); },
    run(id, ...args) { return this.map.get(id)(...args); },
  };
  const run = createActionRunner({}, { ui: { actions } });
  await run({ kind: 'emulate-function', target: '0x1000' });
  await run({ kind: 'open-patch-editor', target: '0x1004' });
  await run({ kind: 'emulate-function', target: null });
  await run({ kind: 'open-patch-editor', target: 'not-an-address' });

  assert.deepEqual(calls, [
    ['emulate.function', 0x1000n],
    ['patch.open', 0x1004n, 'open-patch-editor'],
  ]);

  const routes = [];
  const routerRun = createActionRunner({}, { ui: { router: { navigate: (p) => routes.push(p) } } });
  await routerRun({ kind: 'emulate-function', address: 0x2000n });
  assert.deepEqual(routes, ['/function/8192/runtime']);

  const appCalls = [];
  const appRun = createActionRunner({
    emulateFunction: (addr) => appCalls.push(['app.emulate', addr]),
    openPatchEditor: (addr) => appCalls.push(['app.patch', addr]),
  }, {});
  await appRun({ kind: 'emulate-function', target: '0x3000' });
  await appRun({ kind: 'open-patch-editor', target: '0x3004' });
  assert.deepEqual(appCalls, [
    ['app.emulate', 0x3000n],
    ['app.patch', 0x3004n],
  ]);
});

test('Goal 2: patch proposal bytes format as readable hex strings and Japanese action labels', () => {
  assert.equal(formatPatchBytes([31, 32, 3, 213]), '1F 20 03 D5');
  assert.equal(formatPatchBytes(new Uint8Array([0x1f, 0x20, 0x03, 0xd5])), '1F 20 03 D5');
  assert.equal(formatProposalValue([31, 32, 3, 213], 'patch'), '1F 20 03 D5');
  assert.equal(formatProposalValue({ assembly: 'nop', bytes: [31, 32, 3, 213] }, 'patch'), 'nop (1F 20 03 D5)');
  assert.equal(formatProposalValue(null, 'patch'), '—');

  assert.equal(actionButtonLabel({ kind: 'emulate-function' }), 'この関数を試す');
  assert.equal(actionButtonLabel({ kind: 'open-patch-editor' }), 'ここを書き換える');
  assert.equal(actionButtonLabel({ kind: 'emulate-function', label: 'カスタム' }), 'カスタム');
});

test('Goal 3: patch_suggestion task template and function-level auto scope resolution', () => {
  assert.ok(TASKS.includes('patch_suggestion'));
  const hint = taskHint('patch_suggestion');
  assert.ok(hint.includes('name="patch_suggestion"'));
  assert.ok(/matching the user's language/i.test(hint));
  assert.doesNotMatch(hint, /Japanese/i);

  assert.equal(detectTask('書き換える方法を教えて'), 'patch_suggestion');
  assert.equal(detectTask('このチェックをバイパスしたい'), 'patch_suggestion');
  assert.equal(detectTask('How do I bypass this check?'), 'patch_suggestion');
  assert.equal(detectTask('わかりやすく説明して'), 'explain_function');

  const state = { selection: 'instruction', functionAddress: 0x1000n, fileOpen: true };
  assert.equal(resolveScope('auto', { ...state, task: 'patch_suggestion' }), 'function');
  assert.equal(resolveScope('auto', state, { task: 'explain_function' }), 'function');
  assert.equal(resolveScope('auto', state, { task: 'explain' }), 'function');
  assert.equal(resolveScope('auto', state, { task: 'rename_suggestion' }), 'function');
  assert.equal(resolveScope('auto', state, { task: 'rename' }), 'function');
  assert.equal(resolveScope('auto', state, { task: 'comment' }), 'function');
  assert.equal(resolveScope('auto', state), 'selection');
  assert.equal(resolveScope('binary', { ...state, task: 'patch_suggestion' }), 'binary');
});

test('Goal 4: local-engine-base guides user when no function/binary is selected instead of claiming unreachable provider', async () => {
  const engine = createLocalEngine({}, {});
  const res = await engine.run({
    mode: 'chat',
    style: 'beginner',
    scope: 'function',
    question: 'この関数は何をしている？',
    context: {},
    onActivity: () => {},
  });
  assert.match(res.answer, /まずは関数を選択するかバイナリを開いてください/);
  assert.doesNotMatch(res.answer, /接続できない|unreachable/i);
});

test('Goal 5: workbenchContext includes staged patches and assistant.js offers beginner quick prompts', () => {
  const mockApp = {
    store: {
      get(key) {
        if (key === 'fileInfo') return { name: 'game.bin', format: 'Mach-O' };
        if (key === 'architecture') return 'arm64';
        if (key === 'currentRegion') return { section: '__text' };
        return null;
      },
    },
    patches: {
      size: 2,
      list() {
        return [
          { offset: 0x100n, addr: 0x1000n, before: new Uint8Array([0, 0, 0, 0]), after: new Uint8Array([0x1f, 0x20, 0x03, 0xd5]), text: 'nop' },
          { offset: 0x104n, addr: 0x1004n, before: new Uint8Array([0, 0, 0, 0]), after: new Uint8Array([0x20, 0x00, 0x80, 0x52]), label: 'mov w0, #1' },
        ];
      },
    },
  };

  const patches = stagedPatchesOf(mockApp);
  assert.equal(patches.length, 2);
  assert.deepEqual(patches[0], { address: '0x00001000', byteLength: 4, label: 'nop' });
  assert.deepEqual(patches[1], { address: '0x00001004', byteLength: 4, label: 'mov w0, #1' });

  const ctx = workbenchContext(mockApp);
  assert.equal(ctx.patches.length, 2);
  assert.ok(ctx.notes.some((n) => n.includes('staged patches (2): 0x00001000 4B nop, 0x00001004 4B mov w0, #1')));

  const block = composeContextBlock(ctx);
  assert.ok(block.includes('staged patches (2): 0x00001000 4B nop, 0x00001004 4B mov w0, #1'));

  const prompts = suggestionsFor(mockApp);
  assert.ok(prompts.includes('わかりやすく説明して'));
  assert.ok(prompts.includes('書き換える方法を教えて'));
});

test('Review Finding 2: open-patch-editor omits insnArg when cached rowData has null mnemonic', async () => {
  const fs = await import('node:fs/promises');
  const actionsSrc = await fs.readFile(new URL('../../js/ai/interaction/actions.js', import.meta.url), 'utf8');
  assert.match(actionsSrc, /insn && insn\.mnemonic\s*\?\s*\{\s*mnemonic:\s*insn\.mnemonic/);
});

test('Review Finding 3: AI_ACTION_KINDS and normalizeResponse preserve emulate-function and open-patch-editor', () => {
  assert.ok(AI_ACTION_KINDS.includes('emulate-function'));
  assert.ok(AI_ACTION_KINDS.includes('open-patch-editor'));

  const model = normalizeResponse({
    answer: 'done',
    actions: [
      { kind: 'emulate-function', target: '0x1000' },
      { kind: 'open-patch-editor', target: '0x1004' },
    ],
  });
  assert.equal(model.actions.length, 2);
  assert.equal(model.actions[0].kind, 'emulate-function');
  assert.equal(model.actions[0].address, 0x1000n);
  assert.ok(model.actions[0].label.length > 0);
  assert.equal(model.actions[1].kind, 'open-patch-editor');
  assert.equal(model.actions[1].address, 0x1004n);
  assert.ok(model.actions[1].label.length > 0);
});

test('Review Finding 4: progressive/stative Japanese field-writer queries are not stolen by patch_suggestion', () => {
  assert.equal(detectTask('HPを書き換えている場所'), 'find_field_writer');
  assert.equal(detectTask('HPを書き換えていた処理'), 'find_field_writer');
  assert.equal(detectTask('HPを書き換えて'), 'patch_suggestion');
  assert.equal(detectTask('書き換える方法を教えて'), 'patch_suggestion');
});

test('Review Finding 5: local-engine-base treats beginner chips as function-scoped and calls streamGemini instead of falsely returning unreachable', async () => {
  assert.deepEqual(
    localChatDependencies({ question: 'わかりやすく説明して', scope: 'auto', hasFunction: true }),
    { functionContext: true, assembly: false },
  );
  assert.deepEqual(
    localChatDependencies({ question: '書き換える方法を教えて', scope: 'auto', hasFunction: true }),
    { functionContext: true, assembly: false },
  );

  // Intercept global fetch so streamGemini succeeds with a mock SSE response
  const origFetch = globalThis.fetch;
  let capturedBody = null;
  globalThis.fetch = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    const sse = 'data: {"event_type":"step.delta","delta":{"type":"text","text":"これはテスト用のわかりやすい説明です。"}}\n\ndata: [DONE]\n\n';
    const encoder = new TextEncoder();
    const bytes = encoder.encode(sse);
    let sent = false;
    return {
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            async read() {
              if (sent) return { done: true, value: undefined };
              sent = true;
              return { done: false, value: bytes };
            },
            releaseLock() {},
          };
        },
      },
    };
  };

  try {
    const mockApp = {
      store: {
        get(key) {
          if (key === 'currentRegion') return { id: 'text', vmAddr: 0x1000n, size: 0x100n, exec: true };
          return null;
        },
      },
      analysisQueries: {
        async snapshot() { return { snapshotId: 's1' }; },
        async function() {
          return {
            value: {
              startAddress: 0x1000n,
              model: {
                instructions: [
                  { address: 0x1000n, mnemonic: 'mov', operands: 'w0, #1' },
                  { address: 0x1004n, mnemonic: 'ret', operands: '' },
                ],
                blocks: [{ id: 0 }],
              },
            },
            completeness: 'complete',
            status: { completeness: 'complete' },
          };
        },
      },
    };
    const engine = createLocalEngine(mockApp, {});
    const res = await engine.run({
      mode: 'chat',
      style: 'beginner',
      scope: 'auto',
      question: 'わかりやすく説明して',
      context: {
        function: { name: 'sub_1000', address: '0x1000', addressValue: 0x1000n },
      },
      onActivity: () => {},
    });
    assert.equal(res.answer, 'これはテスト用のわかりやすい説明です。');
    assert.ok(capturedBody?.currentFunction?.assembly?.includes('mov w0, #1'));
  } finally {
    globalThis.fetch = origFetch;
  }
});
