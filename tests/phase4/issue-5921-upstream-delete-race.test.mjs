import assert from 'node:assert/strict';
import { ArtifactStore } from '../../js/core/artifacts/index.js';
import { PersistentMemoryBackend, descriptor } from './store/support.mjs';

// #5921: a backend read can capture pre-mutation upstream bytes while a
// concurrent delete lands. Upstream dependency validation must observe the
// same mutation discipline as the artifact's own reads (wait, capture epoch,
// re-verify after the read) so the stale captured bytes can never validate a
// dependency the store no longer contains.
class UpstreamBlockingBackend extends PersistentMemoryBackend {
  constructor(options, upstreamId) {
    super(options);
    this.upstreamId = upstreamId;
    this.blocked = false;
    this.blockedOnce = false;
    let enterResolve;
    let releaseResolve;
    this.entered = new Promise((resolve) => { enterResolve = resolve; });
    this.release = new Promise((resolve) => { releaseResolve = resolve; });
    this.enterResolve = enterResolve;
    this.releaseResolve = releaseResolve;
  }
  async getRaw(id) {
    const raw = await super.getRaw(id);
    if (id !== this.upstreamId || this.blockedOnce) return raw;
    this.blockedOnce = true;
    this.blocked = true;
    this.enterResolve();
    await this.release;
    return raw;
  }
}

{
  const entries = new Map();
  const upstream = descriptor('upstream-delete-race-child');
  const parent = descriptor('upstream-delete-race-parent', { upstreamArtifactIds:[upstream.artifactId] });
  const backend = new UpstreamBlockingBackend({ entries }, upstream.artifactId);
  const store = new ArtifactStore({ backend });

  await store.publish(upstream, { value:'upstream' });
  await store.publish(parent, { value:'parent' });

  const reading = store.get(parent);
  await backend.entered;

  // The delete completes fully while the parent's dependency validation is
  // still awaiting the blocked upstream read.
  await store.delete(upstream.artifactId);
  assert.equal(entries.has(upstream.artifactId), false);
  backend.releaseResolve();

  // A hit here would be built from captured pre-delete upstream bytes: the
  // required upstream no longer exists, so the read must fail closed instead.
  const result = await reading;
  assert.equal(result.status, 'miss');
  assert.equal(result.reason, 'missing-upstream');
  assert.equal((await store.get(parent)).status, 'miss', 'consistency across reads after the upstream delete');
}

console.log('issue-5921-upstream-delete-race: PASS');

{
  const entries = new Map();
  const upstream = descriptor('upstream-publish-race-child');
  const parent = descriptor('upstream-publish-race-parent', { upstreamArtifactIds:[upstream.artifactId] });
  const backend = new UpstreamBlockingBackend({ entries }, upstream.artifactId);
  const store = new ArtifactStore({ backend });

  // The parent exists while its required upstream is initially absent. The
  // first upstream read captures null and then blocks, allowing a publish to
  // advance the upstream epoch before the read is released.
  await store.publish(parent, { value:'parent' });
  const reading = store.get(parent);
  await backend.entered;

  await store.publish(upstream, { value:'upstream' });
  assert.equal(entries.has(upstream.artifactId), true);
  backend.releaseResolve();

  // The captured null is stale, not evidence of a missing dependency. The
  // epoch mismatch must make the parent read retry and observe the publish.
  const result = await reading;
  assert.equal(result.status, 'hit');
  assert.ok(store.metrics.mutationRetries > 0, 'upstream epoch race must trigger a bounded retry');
}

console.log('issue-5921-upstream-publish-race: PASS');
