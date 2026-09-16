// Child-process target for issue #8969. Runs under a deliberately constrained V8
// heap (spawned by the parent regression with --max-old-space-size). It exercises
// the production rebuild source-identity path on an 8 MiB buffer twice: once on a
// stale source hash (must fail closed with a bounded rejection) and once on the
// correct source hash (must materialize). Before the byte-native fix, hashing the
// whole binary via stableDigest(Array.from(bytes)) boxed the entire buffer into a
// number array + decimal JSON string and process-OOMed here instead of returning a
// bounded result. It must now complete under the constrained heap.
import { createRebuildPlan, materializeRebuildPlan } from '../../../../js/rebuild/index.js';

const N = 8 * 1024 * 1024;
const src = new Uint8Array(N);
for (let i = 0; i < N; i += 1) src[i] = (i & 0xff) ^ ((i >>> 8) & 0xff);

const op = () => ({
  offset: 0,
  before: new Uint8Array([src[0]]),
  after: new Uint8Array([(src[0] + 1) & 0xff]),
});

// 1. Stale source hash: precondition check must reject in bounded memory.
const stale = createRebuildPlan({ binaryId: 'b', sourceHash: 'bytes:probe', operations: [op()] });
const rejected = await materializeRebuildPlan(stale, src, { allowSourceHashMismatch: false });
if (rejected.status !== 'rejected' || rejected.reason !== 'source-identity-mismatch') {
  console.log('FAIL_STALE', rejected.status);
  process.exit(2);
}
console.log('OK_REJECTED');

// 2. Valid source hash (observed from the rejection): a one-byte change must
//    materialize without process-OOMing on source/output identity.
const valid = createRebuildPlan({ binaryId: 'b', sourceHash: rejected.observed, operations: [op()] });
const done = await materializeRebuildPlan(valid, src, { allowSourceHashMismatch: false });
if (done.status !== 'materialized') {
  console.log('FAIL_VALID', done.status);
  process.exit(2);
}
console.log('OK_MATERIALIZED');
