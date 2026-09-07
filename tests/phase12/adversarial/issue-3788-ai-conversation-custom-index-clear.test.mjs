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

test('issue #3788 - coercible keys are canonicalized once before storage ownership is derived', () => {
  const storage = memoryStorage();
  const customKey = 'test.ai.coercible';
  const defaultStore = createConversationStore({ storage, namespace: () => 'default-bin' });
  assert.equal(defaultStore.save([persistedConversation('default-chat')]), true);

  const boxedStore = createConversationStore({
    storage,
    key: new String(customKey),
    namespace: () => 'boxed-bin',
  });
  assert.equal(boxedStore.save([persistedConversation('boxed-chat')]), true);
  boxedStore.clear();
  assert.ok(storage.getItem(`${STORAGE_KEY}.index`));
  assert.ok(storage.getItem(`${STORAGE_KEY}.default-bin`));
  assert.equal(storage.getItem(`${customKey}.index`), null);
  assert.equal(storage.getItem(`${customKey}.boxed-bin`), null);

  let coercions = 0;
  const statefulKey = {
    [Symbol.toPrimitive]() {
      coercions += 1;
      return coercions === 1 ? customKey : STORAGE_KEY;
    },
  };
  const statefulStore = createConversationStore({
    storage,
    key: statefulKey,
    namespace: () => 'stateful-bin',
  });
  assert.equal(coercions, 1, 'storage key must be snapshotted exactly once');
  assert.equal(statefulStore.save([persistedConversation('stateful-chat')]), true);
  assert.equal(coercions, 1, 'save must reuse the canonical storage key');
  assert.ok(storage.getItem(`${customKey}.index`));
  assert.ok(storage.getItem(`${customKey}.stateful-bin`));

  statefulStore.clear();
  assert.equal(coercions, 1, 'clear must reuse the canonical storage key');
  assert.equal(storage.getItem(`${customKey}.index`), null);
  assert.equal(storage.getItem(`${customKey}.stateful-bin`), null);
  assert.ok(storage.getItem(`${STORAGE_KEY}.index`), 'stateful custom key must not alias the default index');
  assert.ok(storage.getItem(`${STORAGE_KEY}.default-bin`), 'stateful custom key must not alias default buckets');
});

test('issue #3788 - a boxed default key resolves to the same canonical default owner', () => {
  const storage = memoryStorage();
  const boxedDefault = createConversationStore({
    storage,
    key: new String(STORAGE_KEY),
    namespace: () => 'boxed-default-bin',
  });

  assert.equal(boxedDefault.key, `${STORAGE_KEY}.boxed-default-bin`);
  assert.equal(boxedDefault.save([persistedConversation('boxed-default-chat')]), true);
  assert.ok(storage.getItem(`${STORAGE_KEY}.index`));
  assert.ok(storage.getItem(`${STORAGE_KEY}.boxed-default-bin`));

  boxedDefault.clear();
  assert.equal(storage.getItem(`${STORAGE_KEY}.index`), null);
  assert.equal(storage.getItem(`${STORAGE_KEY}.boxed-default-bin`), null);
});
