import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversation, createConversationStore, STORAGE_KEY } from '../../../js/ai/ui/conversations.js';

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

test('issue #3788 - custom clear removes its own index without touching the default store', () => {
  const storage = memoryStorage();
  const customKey = 'test.ai.conversations';
  const defaultStore = createConversationStore({ storage, namespace: () => 'default-bin' });
  const customStore = createConversationStore({ storage, key: customKey, namespace: () => 'custom-bin' });

  assert.equal(defaultStore.save([persistedConversation('default-chat')]), true);
  assert.equal(customStore.save([persistedConversation('custom-chat')]), true);

  const defaultIndexKey = `${STORAGE_KEY}.index`;
  const customIndexKey = `${customKey}.index`;
  assert.ok(storage.getItem(defaultIndexKey));
  assert.ok(storage.getItem(customIndexKey));
  assert.ok(storage.getItem(`${STORAGE_KEY}.default-bin`));
  assert.ok(storage.getItem(`${customKey}.custom-bin`));

  customStore.clear();

  assert.equal(storage.getItem(customIndexKey), null);
  assert.equal(storage.getItem(`${customKey}.custom-bin`), null);
  assert.ok(storage.getItem(defaultIndexKey), 'custom clear must not delete the default index');
  assert.ok(storage.getItem(`${STORAGE_KEY}.default-bin`), 'custom clear must not delete default buckets');
  assert.deepEqual(customStore.load(), []);
  assert.equal(defaultStore.load().length, 1);

  defaultStore.clear();
  assert.equal(storage.getItem(defaultIndexKey), null);
  assert.equal(storage.getItem(`${STORAGE_KEY}.default-bin`), null);
});
