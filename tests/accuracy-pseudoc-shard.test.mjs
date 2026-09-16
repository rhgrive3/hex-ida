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

console.log('accuracy pseudoc canonical sampling regression passed');

const shards = Array.from({ length:4 }, (_, index) => pseudocShardSamples(starts, index, 4));
assert.deepEqual(shards.map((shard) => shard.length), [30,30,30,30], 'canonical 120 samples must split into four 30-sample shards');
for (let shardIndex=0; shardIndex<4; shardIndex++) {
  assert.deepEqual(shards[shardIndex], first.filter((_, index) => index % 4 === shardIndex), 'pseudoc sharding must be round-robin and deterministic');
}
assert.deepEqual(
  first,
  first.map((_, index) => shards[index % 4][Math.floor(index / 4)]),
  'the four shards must exactly cover the canonical sample without overlap or loss',
);
