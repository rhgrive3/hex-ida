import assert from 'node:assert/strict';
import { compilePattern, evaluatePattern } from '../../../js/pattern/index.js';

const snapshotId = 'issue-5002';
const highTarget = (1n << 53n) + 1n;

function encodedPointer(address) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, address, true);
  return bytes;
}

function compileIndirect(kind) {
  return compilePattern({
    kind: 'struct',
    name: 'Root',
    fields: [{
      name: 'p',
      type: {
        kind,
        space: 'file',
        target: { kind: 'primitive', name: 'u8' },
      },
    }],
  }, { snapshotId });
}

function sparseSource(address, targetValue = 0x41) {
  const head = encodedPointer(address);
  const reads = [];
  return {
    reads,
    source: {
      snapshotId,
      size: null,
      read(offset, length, { space } = {}) {
        const at = BigInt(offset);
        reads.push({ rawOffset: offset, offset: at, length, space });
        if (at === 0n && length === 8 && space === 'file') return head;
        if (at === address && length === 1 && space === 'file') return Uint8Array.of(targetValue);
        throw new RangeError(`unexpected sparse read ${space}:${offset}:${length}`);
      },
    },
  };
}

// A BigInt-capable ByteSource must receive the exact 64-bit pointer/offset
// coordinate. The Pattern layer must not narrow it through Number first.
for (const kind of ['pointer', 'offset']) {
  const { reads, source } = sparseSource(highTarget);
  const result = evaluatePattern(compileIndirect(kind), source);
  assert.equal(result.status, 'complete');
  const indirect = result.value.fields.p;
  assert.equal(indirect.value, highTarget);
  assert.equal(indirect.provenance.offset, '0');
  assert.equal(indirect.provenance.length, '8');
  assert.equal(indirect.targetSpace, 'file');

  const target = indirect.dereference();
  assert.equal(target.value, 0x41);
  assert.equal(target.provenance.offset, String(highTarget));
  assert.equal(target.provenance.space, 'file');
  assert.deepEqual(reads.map(({ offset }) => offset), [0n, highTarget]);
  assert.equal(typeof reads[1].rawOffset, 'bigint');
}

// Existing small-address behavior remains unchanged.
{
  const address = 32n;
  const { reads, source } = sparseSource(address, 0x7a);
  const result = evaluatePattern(compileIndirect('pointer'), source);
  assert.equal(result.value.fields.p.dereference().value, 0x7a);
  assert.deepEqual(reads.map(({ offset }) => offset), [0n, address]);
}

// Memory-backed sources retain their own finite JS-index boundary. Passing the
// exact BigInt through the evaluator must not make an in-memory source pretend
// it can address beyond Number's safe range.
{
  const bytes = encodedPointer(highTarget);
  const result = evaluatePattern(compilePattern({
    kind: 'struct',
    name: 'Root',
    fields: [{
      name: 'p',
      type: {
        kind: 'pointer',
        space: 'file',
        target: { kind: 'primitive', name: 'u8' },
      },
    }],
  }), bytes);
  assert.equal(result.value.fields.p.value, highTarget);
  assert.throws(
    () => result.value.fields.p.dereference(),
    (error) => error instanceof RangeError && error.message === 'pattern-read-out-of-range',
  );
}

// Lazy dereference still obeys the existing resource/cancellation boundary.
{
  const budgeted = sparseSource(highTarget);
  const result = evaluatePattern(compileIndirect('pointer'), budgeted.source, { maxBytes: 8 });
  const target = result.value.fields.p.dereference();
  assert.equal(target.status, 'partial');
  assert.equal(target.reason, 'resource-limit-bytes');
  assert.deepEqual(budgeted.reads.map(({ offset }) => offset), [0n]);

  const controller = new AbortController();
  const cancelled = sparseSource(highTarget);
  const cancelledResult = evaluatePattern(compileIndirect('pointer'), cancelled.source, { signal: controller.signal });
  controller.abort('stop');
  const cancelledTarget = cancelledResult.value.fields.p.dereference();
  assert.equal(cancelledTarget.status, 'partial');
  assert.equal(cancelledTarget.reason, 'cancelled');
  assert.deepEqual(cancelled.reads.map(({ offset }) => offset), [0n]);
}

console.log('[phase12] issue #5002 BigInt pointer/offset dereference regressions passed');
