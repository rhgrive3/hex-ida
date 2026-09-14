// Regression for #5789: the namespace `index` used to build a bucket key
// identical to the managed index key, so save() overwrote the conversation
// array with the index object and load() returned an empty history. The
// reserved namespace now fails closed at the storage boundary — nothing is
// read from or written to the colliding key, and ordinary namespaces keep
// round-tripping.
import assert from 'node:assert/strict';
import { createConversation, createConversationStore, STORAGE_KEY } from '../js/ai/ui/conversations.js';

const INDEX_METADATA = 'hex.ai.conversations.v2.index';

function makeStorage() {
  const data = new Map();
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
  };
}

function conversation(id) {
  return createConversation({
    id,
    turns: [{ role: 'user', text: 'hello', mode: 'chat', style: 'beginner', scope: 'auto' }],
  });
}

{
  const storage = makeStorage();
  const store = createConversationStore({ namespace: () => 'index', storage });
  assert.equal(store.key, null, 'reserved namespace must not expose the colliding bucket key');
  assert.equal(store.save([conversation('c1')]), false, 'save under the reserved namespace must not persist');
  assert.equal(storage.data.has(INDEX_METADATA), false, 'the managed index key must never receive bucket data');
  assert.deepEqual(store.load('index'), [], 'load under the reserved namespace must not read the metadata key as data');
}

{
  const storage = makeStorage();
  const store = createConversationStore({ namespace: () => 'bin-A', storage });
  store.save([conversation('c2')]);
  assert.equal(store.load('bin-A').length, 1, 'ordinary namespaces keep round-tripping');
  const metadata = JSON.parse(storage.getItem(INDEX_METADATA));
  assert.ok(typeof metadata === 'object' && !Array.isArray(metadata), 'metadata key still holds the managed index object');
  assert.deepEqual(storage.data.get(INDEX_METADATA), storage.data.get(`${STORAGE_KEY}.index`), 'metadata and index derivation stay aligned for the default store');
}
