import assert from 'node:assert/strict';
import { pseudocSamples, pseudocShardSamples } from './accuracy-pseudoc-shard-oracle.mjs';

const starts = [];
let addr = 0x1000;
for (let i = 0; i < 400; i++) {
  starts.push(addr);
  addr += i % 7 === 0 ? 4096 : 64 + (i % 9) * 16;
}

const first = pseudocSamples(starts);
const second = pseudocSamples(starts);
assert.equal(first.length, 120, 'fixture must exercise the same 120-sample cap as accuracy.mjs');
assert.deepEqual(second, first, 'canonical pseudoc sampling must remain deterministic');
for (const [start, end] of first) {
  const bytes = end - start;
  assert.ok(bytes >= 64 && bytes <= 2048, `sample size must remain eligible: ${bytes}`);
}
assert.equal(new Set(first.map(([start]) => start)).size, first.length, 'canonical samples must be unique');
assert.ok(
  first.every(([start], index) => index === 0 || start >= first[index - 1][0]),
  'canonical samples must preserve source-address order for deterministic dynamic scheduling',
);

const shards = Array.from({ length: 4 }, (_, index) => pseudocShardSamples(starts, index, 4));
assert.deepEqual(shards.map((shard) => shard.length), [30, 30, 30, 30],
  'four-way CI sharding must cover the canonical 120 samples evenly');
const rebuilt = [];
for (let sampleIndex = 0; sampleIndex < first.length; sampleIndex++) {
  rebuilt.push(shards[sampleIndex % 4][Math.floor(sampleIndex / 4)]);
}
assert.deepEqual(rebuilt, first, 'pseudoc shards must be disjoint and exhaustive over the canonical sample order');
assert.equal(
  new Set(shards.flat().map(([start]) => start)).size,
  first.length,
  'no canonical pseudoc sample may appear in more than one shard',
);
assert.throws(() => pseudocShardSamples(starts, -1, 4), /invalid pseudoc shard index/);
assert.throws(() => pseudocShardSamples(starts, 4, 4), /invalid pseudoc shard index/);
assert.throws(() => pseudocShardSamples(starts, 0, 0), /invalid pseudoc shard count/);

console.log('accuracy pseudoc canonical sampling/sharding regression passed');
