import assert from 'node:assert/strict';
import fs from 'node:fs';

const facade = fs.readFileSync('js/analysis/alias/index-v2.js', 'utf8');
const source = fs.readFileSync('js/analysis/alias/regions-v2-indexed.js', 'utf8');

assert.match(facade, /export \{ classifySemanticMemoryRegion \} from '\.\/regions-v2-indexed\.js';/,
  'semantic-v2 consumers must use the indexed canonical region classifier');
assert.match(source, /classifySemanticMemoryRegion as classifySemanticMemoryRegionBase/,
  'indexed classifier must retain the historical classifier as its authority\/fallback');
assert.match(source, /const firstPassByIr = new WeakMap\(\)/,
  'first-pass canonical results must be cached only by immutable IR identity');
assert.match(source, /const pointerIndexMemo = new WeakMap\(\)/,
  'canonical pointer lookup tables must be indexed once per MemorySSA artifact');
assert.match(source, /isCanonicalMemorySsaProducerArtifact\(memorySsa\)/,
  'indexed refinement must retain the private producer-brand gate');
assert.match(source, /memorySsa\.identity\?\.semanticIrDigest[^\n]*irDigest\(ir\)/,
  'indexed refinement must retain exact Semantic IR digest binding');

const fastStart = source.indexOf('function fastPointerRegion(');
const fastEnd = source.indexOf('\nexport function classifySemanticMemoryRegion', fastStart);
assert.ok(fastStart >= 0 && fastEnd > fastStart, 'indexed pointer resolver must exist');
const fast = source.slice(fastStart, fastEnd);
assert.doesNotMatch(fast, /ssa\.uses\.filter\(/,
  'pointer refinement must not rescan all scalar SSA uses per memory access');
assert.doesNotMatch(fast, /ssa\.definitions\.find\(/,
  'pointer refinement must not rescan all scalar SSA definitions per memory access');
assert.doesNotMatch(fast, /memorySsa\.uses\.filter\(/,
  'pointer refinement must not rescan all MemorySSA uses per memory access');
assert.doesNotMatch(fast, /memorySsa\.definitions\.find\(/,
  'pointer refinement must not rescan all MemorySSA definitions per memory access');
assert.doesNotMatch(fast, /accessMetadata\.find\(/,
  'pointer refinement must not rescan all access metadata per memory access');

const publicStart = source.indexOf('export function classifySemanticMemoryRegion(');
const publicBody = source.slice(publicStart);
assert.match(publicBody, /if \(!first\) return classifySemanticMemoryRegionBase/,
  'unknown call shapes must fall back to historical classification');
assert.match(publicBody, /first\.result\?\.metadata\?\.reason !== 'missing-region-provenance'/,
  'only the historical pointer-through-stack missing-provenance case may refine');
assert.match(publicBody, /if \(!indexes\) return classifySemanticMemoryRegionBase/,
  'failed producer\/digest\/index preconditions must fail back to historical authority');
assert.match(publicBody, /if \(!descriptor\) return first\.result/,
  'an unproven pointer refinement must preserve the exact first-pass result');

console.log('semantic-v2 indexed region-classification hot-path regression passed');
