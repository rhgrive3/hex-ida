import assert from 'node:assert/strict';
import { MemoryByteSource } from '../../js/binary/source.js';
import { clearMachOSourceCache, parseMachOSource } from '../../js/binary/macho-source-cache.js';
import { makeFatMachOFixture } from '../universal-binary.mjs';

const source = new MemoryByteSource(makeFatMachOFixture());
let reads = 0;
const read = source.read.bind(source);
source.read = async (...args) => { reads++; return read(...args); };
const options = {
  sliceIndex: 0,
  ranges: { pageSize: 128, maxPageSize: 2048, maxCachedBytes: 2 * 1024 * 1024 },
};

clearMachOSourceCache(source);
try {
  const [first, second] = await Promise.all([
    parseMachOSource(source, options),
    parseMachOSource(source, options),
  ]);

  assert.notEqual(first, second, 'each cache consumer must receive its own BinaryImage object');
  assert.notEqual(first.metadata, second.metadata, 'metadata must not be shared between consumers');
  assert.notEqual(first.warnings, second.warnings, 'warnings must not be shared between consumers');
  assert.notEqual(first.functions, second.functions, 'function arrays must not be shared between consumers');
  assert.notEqual(first.symbols, second.symbols, 'symbol arrays must not be shared between consumers');
  assert.equal(typeof first.summary, 'function', 'detached images must retain BinaryImage methods');
  assert.equal(first.source, second.source, 'source capability may remain shared while image state is detached');
  const readsAfterSingleFlight = reads;
  assert.ok(readsAfterSingleFlight > 0, 'the producer must read the source at least once');

  first.warnings.push('__consumer_A_warning__');
  first.metadata.consumerA = { nested: true };
  first.functions.push({ address: 0xdeadn, source: 'consumer-test' });
  first.symbols.push({ address: 0xbeefn, name: 'consumer-test' });
  first.metadata.fat.consumerA = { nested: true };

  assert.equal(second.warnings.includes('__consumer_A_warning__'), false, 'warning mutation must not leak');
  assert.equal(second.metadata.consumerA, undefined, 'metadata mutation must not leak');
  assert.equal(second.functions.some((item) => item.address === 0xdeadn), false, 'function mutation must not leak');
  assert.equal(second.symbols.some((item) => item.address === 0xbeefn), false, 'symbol mutation must not leak');
  assert.equal(second.metadata.fat.consumerA, undefined, 'nested metadata mutation must not leak');

  const third = await parseMachOSource(source, options);
  assert.equal(reads, readsAfterSingleFlight, 'later cache hits must not re-run the producer');
  assert.equal(third.warnings.includes('__consumer_A_warning__'), false, 'later cache hits must remain pristine');
  assert.equal(third.metadata.consumerA, undefined, 'later metadata must remain pristine');
  assert.equal(third.functions.some((item) => item.address === 0xdeadn), false, 'later functions must remain pristine');
  assert.equal(third.symbols.some((item) => item.address === 0xbeefn), false, 'later symbols must remain pristine');

  clearMachOSourceCache(source);
  const reparsed = await parseMachOSource(source, options);
  assert.ok(reads > readsAfterSingleFlight, 'cache clear must allow a fresh producer parse');
  assert.notEqual(reparsed, third, 'cache clear must still force an independent parse');
  assert.equal(reparsed.metadata.consumerA, undefined, 'cache clear must not preserve consumer annotations');
} finally {
  clearMachOSourceCache(source);
}

console.log('issue #4510 Mach-O source cache result ownership: PASS');
