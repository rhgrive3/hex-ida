import assert from 'node:assert/strict';
import { createConversationStore, STORAGE_KEY, LEGACY_STORAGE_KEY } from '../js/ai/ui/conversations.js';
import { AiSession } from '../js/ai/ui/session.js';
import { ContextBroker } from '../js/ai/context/broker.js';
import { InvestigationSessionStore, createInvestigationSession } from '../js/ai/session-core/index.js';
import { EvidenceStore } from '../js/ai/evidence.js';

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    raw: map,
  };
}

// --- #2609: Namespace-partitioned local storage & lossless migration ---
{
  const storage = memoryStorage();

  // Test lossless migration from legacy v1 storage
  const legacyData = {
    'bin-1': [{ id: 'c1', title: 'Chat 1', turns: [{ role: 'user', text: 'Hello from bin 1' }], updatedAt: 1000 }],
    'bin-2': [{ id: 'c2', title: 'Chat 2', turns: [{ role: 'user', text: 'Hello from bin 2' }], updatedAt: 2000 }],
  };
  storage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(legacyData));

  let currentBinary = 'bin-1';
  const store = createConversationStore({ namespace: () => currentBinary, storage });

  // Loading bin-1 migrates legacy data losslessly
  const bin1Chats = store.load('bin-1');
  assert.equal(bin1Chats.length, 1, '#2609: bin-1 chats must load from migrated data');
  assert.equal(bin1Chats[0].id, 'c1');
  assert.equal(bin1Chats[0].turns[0].text, 'Hello from bin 1');

  const bin2Chats = store.load('bin-2');
  assert.equal(bin2Chats.length, 1, '#2609: bin-2 chats must load from migrated data');
  assert.equal(bin2Chats[0].id, 'c2');

  // Verify that updating bin-1 does NOT serialize bin-2 in the bucket
  const bin1RawBefore = storage.getItem(`${STORAGE_KEY}.bin-1`);
  assert.ok(bin1RawBefore, 'bin-1 bucket exists in v2 storage');
  assert.ok(!bin1RawBefore.includes('Hello from bin 2'), 'bin-1 bucket must not contain bin-2 conversations');

  store.save(bin1Chats, 'bin-1');
  const bin1RawAfter = storage.getItem(`${STORAGE_KEY}.bin-1`);
  assert.ok(bin1RawAfter.includes('Hello from bin 1'), 'bin-1 bucket updated');
  assert.ok(!bin1RawAfter.includes('Hello from bin 2'), 'bin-1 bucket remains isolated');
}

// --- #2613: AI chat deletion propagates to core InvestigationSessionStore ---
{
  const sessionStore = new InvestigationSessionStore();
  const coreSession = createInvestigationSession({
    id: 'conv-delete-test',
    binaryId: 'bin-123',
    goal: 'Test deletion sync',
  });
  sessionStore.register(coreSession);
  assert.ok(await sessionStore.get('conv-delete-test'), 'session registered in core store');

  const engine = {
    runtime: { sessionStore },
    run: async () => ({ answer: 'done' }),
  };

  const aiSession = new AiSession({ engine });
  aiSession.conversations = [
    { id: 'conv-delete-test', title: 'Delete me', turns: [], busy: false },
    { id: 'conv-keep', title: 'Keep me', turns: [], busy: false },
  ];
  aiSession.current = aiSession.conversations[0];

  const deleted = aiSession.deleteConversation('conv-delete-test');
  assert.equal(deleted, true, 'deleteConversation succeeds');
  assert.equal(aiSession.conversations.length, 1);
  assert.equal(aiSession.conversations[0].id, 'conv-keep');

  // Verify core session store no longer contains the deleted session
  const lookup = await sessionStore.get('conv-delete-test');
  assert.equal(lookup, null, '#2613: deleted conversation must be removed from core InvestigationSessionStore');
}

// --- #2612: ContextBroker budget trimming preserves user messages ---
{
  const broker = new ContextBroker();
  const evidenceStore = new EvidenceStore();

  // Populate 32 verified evidence entries
  const entries = [];
  for (let i = 0; i < 32; i++) {
    entries.push({
      id: `ev-${i}`,
      kind: 'xref-call',
      status: 'verified',
      address: 0x1000n + BigInt(i * 4),
      title: `Verified evidence item ${i}`,
      summary: `Detailed summary of verified security finding or xref trace item ${i}. ` + 'A'.repeat(200),
    });
  }
  evidenceStore.restorePersistedConfirmed(entries);

  const session = {
    id: 'sess-budget-test',
    messages: [
      { role: 'user', content: 'What is the vulnerability in sub_1000?' },
    ],
    hypotheses: [
      { id: 'h1', claim: 'Buffer overflow in sub_1000', confidence: 0.9, status: 'open' },
    ],
  };

  // Build context with a tight 8KB budget
  const { context, bytes } = broker.buildModelContext({
    request: { mode: 'chat', style: 'analyst', scope: 'function' },
    session,
    evidenceStore,
    budgetBytes: 8192,
    includeHistory: true,
  });

  assert.ok(bytes <= 8192, `context must fit within 8KB budget (was ${bytes} bytes)`);
  assert.ok(Array.isArray(context.recentMessages), 'recentMessages exists');
  assert.equal(context.recentMessages.length, 1, '#2612: user message must NOT be dropped');
  assert.equal(context.recentMessages[0].content, 'What is the vulnerability in sub_1000?', '#2612: recent user question preserved');
}

// --- #2600: ContextBroker fast binary trimming on 100-item queue ---
{
  const broker = new ContextBroker();
  const evidenceStore = new EvidenceStore();
  const entries = [];
  for (let i = 0; i < 100; i++) {
    entries.push({
      id: `ev-bench-${i}`,
      kind: 'xref-call',
      status: 'verified',
      address: 0x2000n + BigInt(i * 4),
      title: `Bench item ${i}`,
      summary: `Item summary for ${i} with extra text ` + 'B'.repeat(300),
    });
  }
  evidenceStore.restorePersistedConfirmed(entries);

  const start = performance.now();
  const { context, bytes } = broker.buildModelContext({
    request: { mode: 'chat', style: 'analyst', scope: 'function' },
    session: { id: 'bench-sess', messages: [{ role: 'user', content: 'bench question' }] },
    evidenceStore,
    budgetBytes: 4096,
  });
  const elapsed = performance.now() - start;

  assert.ok(bytes <= 4096, '#2600: trimmed context must fit inside 4KB budget');
  assert.ok(elapsed < 50, `#2600: binary trim must complete in <50ms (took ${elapsed.toFixed(2)}ms)`);
}

console.log('Issues #2613, #2612, #2609, #2600 regression tests PASS!');
