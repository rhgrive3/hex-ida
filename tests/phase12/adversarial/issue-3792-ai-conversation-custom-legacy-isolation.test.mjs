import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createConversation,
  createConversationStore,
  LEGACY_STORAGE_KEY,
  STORAGE_KEY,
} from '../../../js/ai/ui/conversations.js';

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

function persistedConversation(id) {
  return createConversation({
    id,
    title: id,
    createdAt: 1,
    updatedAt: 2,
    turns: [{ role: 'user', text: 'x', mode: 'chat', style: 'beginner', scope: 'auto', at: 1 }],
  });
}

function legacyPayload() {
  return JSON.stringify({
    'prod-bin': [{
      id: 'legacy-prod',
      title: 'legacy-prod',
      createdAt: 1,
      updatedAt: 2,
      mode: 'chat',
      style: 'beginner',
      scope: 'auto',
      provider: null,
      model: null,
      reasoning: null,
      lastQuestion: null,
      turns: [{ role: 'user', mode: 'chat', style: 'beginner', scope: 'auto', at: 1, text: 'legacy' }],
    }],
  });
}

test('issue #3792 - custom load does not migrate or read the default legacy store', () => {
  const storage = memoryStorage();
  const customKey = 'test.ai.conversations';
  storage.setItem(LEGACY_STORAGE_KEY, legacyPayload());

  const customStore = createConversationStore({ storage, key: customKey, namespace: () => 'prod-bin' });

  assert.deepEqual(customStore.load(), []);
  assert.ok(storage.getItem(LEGACY_STORAGE_KEY), 'custom load must preserve default legacy history');
  assert.equal(storage.getItem(`${customKey}.prod-bin`), null, 'custom load must not copy legacy history');
  assert.equal(storage.getItem(`${customKey}.index`), null, 'custom load must not index migrated default history');
});

test('issue #3792 - custom save and clear leave the default legacy key untouched', () => {
  const storage = memoryStorage();
  const customKey = 'test.ai.conversations';
  storage.setItem(LEGACY_STORAGE_KEY, legacyPayload());

  const customStore = createConversationStore({ storage, key: customKey, namespace: () => 'custom-bin' });
  assert.equal(customStore.save([persistedConversation('custom-chat')]), true);

  const legacyBeforeClear = storage.getItem(LEGACY_STORAGE_KEY);
  assert.ok(legacyBeforeClear);
  assert.ok(storage.getItem(`${customKey}.custom-bin`));
  assert.equal(storage.getItem(`${customKey}.prod-bin`), null, 'custom save must not import the default legacy bucket');

  customStore.clear();

  assert.equal(storage.getItem(LEGACY_STORAGE_KEY), legacyBeforeClear, 'custom clear must not delete default legacy history');
  assert.equal(storage.getItem(`${customKey}.custom-bin`), null);
  assert.equal(storage.getItem(`${customKey}.index`), null);
});

test('issue #3792 - default store still performs the v1 to v2 migration', () => {
  const storage = memoryStorage();
  storage.setItem(LEGACY_STORAGE_KEY, legacyPayload());

  const defaultStore = createConversationStore({ storage, namespace: () => 'prod-bin' });
  const loaded = defaultStore.load();

  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, 'legacy-prod');
  assert.equal(storage.getItem(LEGACY_STORAGE_KEY), null);
  assert.ok(storage.getItem(`${STORAGE_KEY}.prod-bin`));
  assert.ok(storage.getItem(`${STORAGE_KEY}.index`));
});
