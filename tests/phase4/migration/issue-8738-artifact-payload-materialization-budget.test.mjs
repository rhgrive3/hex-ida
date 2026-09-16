import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { ArtifactStore, MemoryArtifactBackend } from '../../../js/core/artifacts/index.js';
import { artifactPayloadChecksum, encodeArtifactPayload } from '../../../js/core/artifacts/contracts.js';
import { stableDigest, stableStringify } from '../../../js/core/identity/index.js';
import {
  ArtifactAnalysisOrchestrator,
  createWorkerAnalysisArtifactDescriptor,
} from '../../../js/cache/artifact-orchestration.js';

const BINARY_ID = `bin_sha256_${'23'.repeat(32)}`;
const TEXT_ENCODER = new TextEncoder();

function makeBytes(length) {
  const bytes = new Uint8Array(length);
  let x = 0x9e3779b9;
  for (let i = 0; i < length; i += 1) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    bytes[i] = (x >>> 13) & 255;
  }
  return bytes;
}

function descriptorFor(label) {
  return createWorkerAnalysisArtifactDescriptor({
    binaryId:BINARY_ID,
    sliceIndex:0,
    architecture:'arm64',
    producerVersion:'producer-v1',
    loaderVersion:'loader-v1',
    architectureSemanticVersion:'arch-v1',
    abiSemanticVersion:'abi-v1',
    semanticSchemaVersion:'semantic-v1',
    config:{ fixture:label },
  });
}

function runtime(label) {
  return new ArtifactAnalysisOrchestrator({
    store:new ArtifactStore({ backend:new MemoryArtifactBackend({ reason:`explicit-${label}` }) }),
  });
}

// 1. Canonical-identity equivalence: the non-boxing splice path must return the
//    EXACT legacy bytes for payloads containing large views anywhere outside
//    sorted (Map key/value, Set member) positions.
{
  const big = makeBytes(100_000);
  const shapes = [
    big,
    { codec:'hex-worker-analysis-payload-v2', root:{ t:'typed-array', i:0, c:'Uint8Array', v:big } },
    { t:'object', i:3, n:false, v:[['k', { t:'array-buffer', i:4, v:makeBytes(70_000).fill(254) }], ['m', 7]] },
    { a:'x'.repeat(70_000) },
    { list:[1, { sub:new Uint8Array(65_536).fill(7) }, 'unicode \u{1F600} \u0001 " \\ {\"hexArtifactViewRef\":\"9-0000000000000000\"}'] },
    { two:[new Uint8Array(70_000).fill(0), new Uint8Array(70_000).fill(255)] },
  ];
  for (const [index, shape] of shapes.entries()) {
    const expected = TEXT_ENCODER.encode(stableStringify(shape));
    const actual = encodeArtifactPayload(shape);
    assert.equal(actual.length, expected.length, `encode length mismatch for shape ${index}`);
    assert.deepEqual([...actual], [...expected], `encode bytes mismatch for shape ${index}`);
  }
}

// 2. Checksum equivalence: streaming digest must equal the legacy boxed digest.
{
  for (const length of [0, 1, 255, 65_537]) {
    const bytes = makeBytes(length);
    assert.equal(artifactPayloadChecksum(bytes), stableDigest(Array.from(bytes)));
  }
}

// 3. Publish/read round trip through the canonical store with a large payload.
{
  const request = runtime('publish');
  const payload = makeBytes(2_000_000);
  const published = await request.request({
    descriptor:descriptorFor('publish'),
    budget:{ residentBytes:64 * 1024 * 1024 },
    produce:async ({ budget }) => {
      budget.consume('residentBytes', payload.byteLength);
      return payload;
    },
  });
  assert.equal(published.status, 'published');
  // The warm re-read below recomputes `artifactPayloadChecksum` over the stored
  // bytes and must match the record published above; a corrupt/changed canonical
  // encoding would surface there as ArtifactCorruptionError.
  const warm = await request.request({
    descriptor:descriptorFor('publish'),
    budget:{ residentBytes:64 * 1024 * 1024 },
    produce:async () => { throw new Error('must not re-run the producer for a warm artifact'); },
  });
  assert.equal(warm.reused, true);
  const warmBytes = warm.payload;
  assert.ok(warmBytes instanceof Uint8Array);
  assert.equal(warmBytes.byteLength, payload.byteLength);
  for (let index = 0; index < payload.byteLength; index += 1) {
    if (warmBytes[index] !== payload[index]) throw new Error(`warm payload byte ${index} diverged`);
  }
}

// 4. A validator still receives the staged (decoded) payload.
{
  const request = runtime('validate');
  let seenLength = -1;
  const published = await request.request({
    descriptor:descriptorFor('validate'),
    budget:{ residentBytes:64 * 1024 * 1024 },
    validate:(staged) => { seenLength = staged instanceof Uint8Array ? staged.byteLength : -1; return staged instanceof Uint8Array; },
    produce:async () => new Uint8Array(1_500_000).fill(3),
  });
  assert.equal(published.status, 'published');
  assert.equal(seenLength, 1_500_000);
}

// 5. Constrained-heap children. Legacy behavior on the documented shape: a
//    10 MiB result peaked at ~497 MiB V8 heap / ~1.8 GiB RSS, and a 30 MiB
//    result aborted the 256 MiB worker with exit 134 before any bounded budget
//    error could surface. After the fix the 10 MiB request completes with the
//    heap delta bounded, and the 30 MiB request is rejected with a bounded
//    BudgetExceededError BEFORE the oversized materializations, so the same
//    256 MiB heap survives.
function childScript(sizeMib, heapLimitMiB) {
  return `
const size = ${sizeMib} * 1024 * 1024;
(async () => {
  const { ArtifactStore, MemoryArtifactBackend } = await import('./js/core/artifacts/index.js');
  const { ArtifactAnalysisOrchestrator, createWorkerAnalysisArtifactDescriptor } = await import('./js/cache/artifact-orchestration.js');
  const descriptor = createWorkerAnalysisArtifactDescriptor({
    binaryId:'bin_sha256_${'25'.repeat(32)}',
    sliceIndex:0, architecture:'arm64',
    producerVersion:'p', loaderVersion:'l',
    architectureSemanticVersion:'a', abiSemanticVersion:'abi', semanticSchemaVersion:'s',
    config:{ fixture:'heap-${sizeMib}-${heapLimitMiB}' },
  });
  const request = new ArtifactAnalysisOrchestrator({
    store:new ArtifactStore({ backend:new MemoryArtifactBackend({ reason:'explicit-heap' }) }),
  });
  global.gc(); global.gc();
  const before = process.memoryUsage().heapUsed;
  try {
    const result = await request.request({
      descriptor,
      budget:{ residentBytes:64 * 1024 * 1024 },
      produce:async ({ budget }) => { budget.consume('residentBytes', size); return new Uint8Array(size); },
    });
    global.gc(); global.gc();
    const delta = process.memoryUsage().heapUsed - before;
    console.log('COMPLETED delta=' + delta);
    if (${heapLimitMiB === 0 ? 'delta > 250 * 1024 * 1024' : 'false'}) { console.error('UNBOUNDED GROWTH'); process.exit(3); }
    if (result.status !== 'published') process.exit(4);
  } catch (error) {
    if (error?.code === 'budget-exhausted') console.log('BOUNDED-BUDGET-ERROR Resource budget exceeded for residentBytes');
    else { console.error('UNEXPECTED ' + ((error && error.stack) || error)); process.exit(5); }
  }
})();
`;
}

const completed = spawnSync(process.execPath, ['--expose-gc', '-e', childScript(10, 0)], {
  cwd:process.cwd(), encoding:'utf8', timeout:180_000,
});
assert.equal(completed.status, 0, `10 MiB default-heap child exited ${completed.status}: ${completed.stderr}`);
assert.match(completed.stdout, /^COMPLETED delta=\d+$/m, completed.stdout + completed.stderr);

const bounded = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=256', '-e', childScript(30, 256)], {
  cwd:process.cwd(), encoding:'utf8', timeout:180_000,
});
assert.equal(bounded.status, 0, `30 MiB constrained-heap child exited ${bounded.status}: ${bounded.stderr}`);
assert.match(bounded.stdout, /^BOUNDED-BUDGET-ERROR Resource budget exceeded for residentBytes/m, bounded.stdout + bounded.stderr);

console.log('issue-8738 artifact payload materialization budget: PASS');
