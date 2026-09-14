import test from 'node:test';
import assert from 'node:assert/strict';
import { globalReferenceStats, clearGlobalReferenceStats } from '../js/analysis/global-ref-stats.js';

const regions = [
  { id:'text', exec:true, section:'__text', vmAddr:0x1000n, size:0x1000n },
  { id:'data', exec:false, section:'__data', name:'__DATA,__data', vmAddr:0x5000n, size:0x1000n },
];

test('global reference aggregation counts data targets once and reuses the completed artifact', async () => {
  let refReads = 0;
  const raw = [0x5100n, 0x5100n, 0x5200n, 0x9000n];
  const refTo = new Proxy(raw, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) refReads++;
      return Reflect.get(target, property, receiver);
    },
  });
  const program = { refCount:raw.length, refTo, graphCompleteness:{ complete:true }, refsCapped:false };

  const first = await globalReferenceStats(program, regions);
  assert.equal(first.complete, true);
  assert.equal(first.counts.get(String(0x5100n)).refs, 2);
  assert.equal(first.counts.get(String(0x5200n)).refs, 1);
  assert.equal(first.counts.has(String(0x9000n)), false);
  assert.equal(refReads, raw.length);

  const second = await globalReferenceStats(program, regions);
  assert.equal(second, first);
  assert.equal(refReads, raw.length, 'cached result must not rescan ProgramIndex refs');
  clearGlobalReferenceStats(program);
});

test('source-capped reference input never becomes exact', async () => {
  const program = {
    refCount:1,
    refTo:[0x5100n],
    graphCompleteness:{ complete:false, reasons:['refs-source-capped'] },
    refsCapped:true,
  };
  const result = await globalReferenceStats(program, regions);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'refs-source-capped');
  clearGlobalReferenceStats(program);
});

test('consumer abort does not manufacture a result', async () => {
  const controller = new AbortController();
  controller.abort('closed');
  const program = { refCount:1, refTo:[0x5100n], graphCompleteness:{ complete:true } };
  await assert.rejects(globalReferenceStats(program, regions, { signal:controller.signal }), (error) => error?.name === 'AbortError');
  clearGlobalReferenceStats(program);
});
