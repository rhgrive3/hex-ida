import assert from 'node:assert/strict';
import { descriptor, scheduler } from './helpers.mjs';

const quietStore = {
  async get(descriptor, { signal } = {}) {
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    return { status: 'miss', source: 'memory', artifactId: descriptor.artifactId };
  },
  async publish(descriptor, payload, { signal } = {}) {
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    return { status: 'published', artifactId: descriptor.artifactId, payload };
  },
};

// Quiescent schedulers retain only a bounded amount of terminal graph/state
// metadata instead of growing with every unique artifact ever requested.
{
  const limit = 32;
  const { scheduler: s } = scheduler({ store: quietStore, terminalHistoryLimit: limit, maxConcurrency: 8 });
  let firstId = null;
  let lastId = null;
  for (let i = 0; i < 512; i++) {
    const item = descriptor(`terminal-history-independent-${i}`);
    if (i === 0) firstId = item.artifactId;
    lastId = item.artifactId;
    await s.request({ descriptor: item, produce: async () => ({ i }) });
  }
  const stats = s.stats();
  assert.equal(stats.inflight, 0);
  assert.equal(stats.queued, 0);
  assert.equal(stats.running, 0);
  assert.equal(stats.terminalHistoryLimit, limit);
  assert.ok(stats.terminalHistoryNodes <= limit, JSON.stringify(stats));
  assert.ok(stats.dagNodes <= limit, JSON.stringify(stats));
  assert.equal(s.state(firstId), 'unknown');
  assert.equal(s.state(lastId), 'completed');
}

// Active dependency metadata is never evicted, even when the terminal-history
// budget is zero. Once the active root settles, the now-terminal chain can be
// compacted completely.
{
  let releaseLeaf;
  const leafGate = new Promise((resolve) => { releaseLeaf = resolve; });
  const leaf = descriptor('terminal-history-active-leaf');
  const root = descriptor('terminal-history-active-root', [leaf]);
  const { scheduler: s } = scheduler({ store: quietStore, terminalHistoryLimit: 0, maxConcurrency: 2 });
  const pending = s.request({
    descriptor: root,
    dependencies: [{ descriptor: leaf, produce: () => leafGate }],
    produce: async () => ({ root: true }),
  });
  for (let turn = 0; turn < 1000 && s.state(leaf.artifactId) !== 'running'; turn++) await Promise.resolve();
  assert.equal(s.state(leaf.artifactId), 'running');
  assert.equal(s.state(root.artifactId), 'waiting-dependency');
  assert.equal(s.stats().dagNodes, 2);
  releaseLeaf({ leaf: true });
  await pending;
  assert.equal(s.stats().inflight, 0);
  assert.equal(s.stats().dagNodes, 0);
  assert.equal(s.stats().dagEdges, 0);
  assert.equal(s.state(root.artifactId), 'unknown');
  assert.deepEqual(s.dependencyIds(root.artifactId), []);
}

// A deep completed chain compacts from terminal roots toward dependencies
// without leaving dangling retained edges or exceeding the configured bound.
{
  const limit = 16;
  const count = 96;
  const descriptors = [];
  for (let i = 0; i < count; i++) descriptors.push(descriptor(`terminal-history-chain-${i}`, i ? [descriptors[i - 1]] : []));
  let request = { descriptor: descriptors[0], produce: async () => ({ index: 0 }) };
  for (let i = 1; i < count; i++) {
    const dependency = request;
    request = { descriptor: descriptors[i], dependencies: [dependency], produce: async () => ({ index: i }) };
  }
  const { scheduler: s } = scheduler({ store: quietStore, terminalHistoryLimit: limit, maxConcurrency: 8 });
  const result = await s.request(request);
  assert.equal(result.payload.index, count - 1);
  const stats = s.stats();
  assert.ok(stats.terminalHistoryNodes <= limit, JSON.stringify(stats));
  assert.ok(stats.dagNodes <= limit, JSON.stringify(stats));
  assert.ok(stats.dagEdges <= Math.max(0, stats.dagNodes - 1), JSON.stringify(stats));
}

// Terminal diagnostic states remain queryable while retained, then become the
// explicit public "unknown" sentinel after normal bounded-history eviction.
{
  const { scheduler: s } = scheduler({ store: quietStore, terminalHistoryLimit: 2 });
  const failed = descriptor('terminal-history-failed');
  await assert.rejects(s.request({ descriptor: failed, produce: async () => { throw new Error('boom'); } }), /boom/);
  assert.equal(s.state(failed.artifactId), 'failed');
  for (let i = 0; i < 3; i++) {
    const item = descriptor(`terminal-history-evict-${i}`);
    await s.request({ descriptor: item, produce: async () => ({ i }) });
  }
  assert.equal(s.state(failed.artifactId), 'unknown');
}

// Repeated warm-cache requests for the same identity refresh one history entry;
// they do not repopulate history per request.
{
  const { scheduler: s, store } = scheduler({ terminalHistoryLimit: 4 });
  const item = descriptor('terminal-history-warm-cache');
  await s.request({ descriptor: item, produce: async () => ({ value: 1 }) });
  for (let i = 0; i < 32; i++) {
    const result = await s.request({ descriptor: item, produce: async () => ({ value: 2 }) });
    assert.equal(result.reused, true);
  }
  assert.equal(store.publishes, 1);
  assert.equal(s.stats().terminalHistoryNodes, 1);
  assert.equal(s.stats().dagNodes, 1);
}

console.log('phase4 scheduler issue #5928 terminal history bound: PASS');
