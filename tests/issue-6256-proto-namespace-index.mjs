// #6256 — prototype-sensitive namespace names (`__proto__`, `constructor`,
// `prototype`) must be recorded in the conversation index as own data
// properties, so their buckets stay inside clear() and MAX_NAMESPACES
// eviction accounting instead of becoming unmanaged storage orphans.
import assert from 'node:assert/strict';
import test from 'node:test';

test('#6256 __proto__ namespace is indexed, cleared, and evicted', async () => {
  const { createConversationStore, MAX_CONVERSATIONS } = await import('../js/ai/ui/conversations.js');

  const map = new Map();
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
  const conversation = () => ({
    id: 'c1', title: '', createdAt: 1, updatedAt: 1,
    mode: 'chat', style: 'beginner', scope: 'auto',
    provider: null, model: null, reasoning: null,
    turns: [{ role: 'user', text: 'hello', mode: 'chat', style: 'beginner', scope: 'auto' }],
  });

  const store = createConversationStore({ namespace: () => '__proto__', storage });
  assert.equal(store.save([conversation()]), true);

  const bucketKey = `${store.key}`;
  assert.ok(map.has(bucketKey), 'bucket payload saved');

  const indexRaw = storage.getItem('hex.ai.conversations.v2.index');
  const index = JSON.parse(indexRaw);
  assert.ok(Object.prototype.hasOwnProperty.call(index, '__proto__'), 'index records __proto__ as own property');

  // Re-read through the store: the index survives a JSON round trip.
  store.save([conversation()]);
  const index2 = JSON.parse(storage.getItem('hex.ai.conversations.v2.index'));
  assert.ok(Object.prototype.hasOwnProperty.call(index2, '__proto__'));

  // The restored index must keep enumerating the namespace for eviction.
  const spaces = Object.keys(JSON.parse(storage.getItem('hex.ai.conversations.v2.index')));
  assert.ok(spaces.includes('__proto__'));

  // clear() must remove the __proto__ bucket.
  store.clear();
  assert.ok(!map.has(bucketKey), '__proto__ bucket removed by clear()');
  assert.equal(map.get('hex.ai.conversations.v2.index'), undefined);

  // Eviction accounting: fill MAX_NAMESPACES + 1 namespaces, the oldest must go.
  const map2 = new Map();
  const storage2 = {
    getItem: (k) => (map2.has(k) ? map2.get(k) : null),
    setItem: (k, v) => map2.set(k, String(v)),
    removeItem: (k) => map2.delete(k),
  };
  const store2 = createConversationStore({ namespace: () => 'keeper', storage: storage2 });
  for (let i = 0; i < 6; i++) {
    const evictStore = createConversationStore({ namespace: () => `bin-${i}`, storage: storage2 });
    const list = [conversation()];
    list[0].updatedAt = 100 + i;
    evictStore.save(list);
  }
  const protoStore = createConversationStore({ namespace: () => '__proto__', storage: storage2 });
  protoStore.save([conversation()]);
  const indexAfter = JSON.parse(storage2.getItem('hex.ai.conversations.v2.index'));
  const spacesAfter = Object.keys(indexAfter);
  assert.equal(spacesAfter.length, 6, 'MAX_NAMESPACES respected with __proto__ counted');
  assert.ok(spacesAfter.includes('__proto__'), '__proto__ survives as the most recent');
  assert.ok(!spacesAfter.includes('bin-0'), 'oldest namespace evicted');
  assert.ok(!map2.has(`${store2.key.replace(/keeper$/, '')}bin-0`), 'evicted bucket removed');
  assert.ok(map2.has(`${protoStore.key}`));
  assert.equal(Object.keys(indexAfter).length <= 6 + MAX_CONVERSATIONS, true);
});

test('#6256 constructor/prototype namespaces and normal namespace keep working', async () => {
  const { createConversationStore } = await import('../js/ai/ui/conversations.js');

  for (const space of ['constructor', 'prototype', 'normal']) {
    const map = new Map();
    const storage = {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
    };
    const store = createConversationStore({ namespace: () => space, storage });
    const list = [{
      id: 'c9', title: 't', createdAt: 1, updatedAt: 2,
      mode: 'chat', style: 'beginner', scope: 'auto',
      provider: null, model: null, reasoning: null,
      turns: [{ role: 'user', text: 'q', mode: 'chat', style: 'beginner', scope: 'auto' }],
    }];
    store.save(list);
    const index = JSON.parse(storage.getItem('hex.ai.conversations.v2.index'));
    assert.ok(Object.prototype.hasOwnProperty.call(index, space), `index records ${space}`);
    assert.equal(store.load().length, 1, `${space} bucket loads back`);
    store.save([]); // empty save removes bucket and index entry
    const indexAfter = JSON.parse(storage.getItem('hex.ai.conversations.v2.index'));
    assert.ok(!Object.prototype.hasOwnProperty.call(indexAfter, space), `${space} entry dropped on empty save`);
    store.clear();
    assert.ok(!map.has(`${store.key}`), `${space} bucket removed by clear()`);
  }
});

test('#6256 legacy migration records __proto__ namespace in the index', async () => {
  const { createConversationStore, LEGACY_STORAGE_KEY } = await import('../js/ai/ui/conversations.js');

  const map = new Map();
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
  // Build the legacy payload textually: a JS object literal would route
  // `__proto__` through the prototype setter instead of an own key.
  map.set(LEGACY_STORAGE_KEY, '{"__proto__":[{"id":"l1","title":"","createdAt":1,"updatedAt":5,"turns":[{"role":"user","text":"x"}]}]}');
  const store = createConversationStore({ namespace: () => '__proto__', storage });
  const loaded = store.load();
  assert.equal(loaded.length, 1, 'legacy __proto__ conversations revive');
  assert.ok(map.has(store.key), 'legacy payload migrated to bucket');
  const index = JSON.parse(storage.getItem('hex.ai.conversations.v2.index'));
  assert.ok(Object.prototype.hasOwnProperty.call(index, '__proto__'), 'migrated namespace indexed');
  assert.equal(map.has(LEGACY_STORAGE_KEY), false, 'legacy key removed');
});
