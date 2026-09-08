import assert from 'node:assert/strict';
import { stableDigest } from '../js/core/identity/index.js';

const FNV64_PRIME = 0x100000001b3n;
const FNV64_SEEDS = [0xcbf29ce484222325n, 0x84222325cbf29ce4n];

// Independent reference: this deliberately retains the BigInt arithmetic that
// the production implementation is replacing.
function referenceFNV64(text, seed) {
  let hash = BigInt.asUintN(64, seed);
  for (let index = 0; index < text.length; index += 1) {
    hash = BigInt.asUintN(64, hash ^ BigInt(text.charCodeAt(index)));
    hash = BigInt.asUintN(64, hash * FNV64_PRIME);
  }
  return hash.toString(16).padStart(16, '0');
}

function referenceDigest(value) {
  // All fixtures below contain only JSON-safe strings/arrays, so this is an
  // independent serialization oracle for stableDigest's canonical text.
  const text = JSON.stringify(value);
  return FNV64_SEEDS.map((seed) => referenceFNV64(text, seed)).join('');
}

function generatedString(seed, length) {
  let state = seed >>> 0;
  let output = '';
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    output += String.fromCharCode(state & 0xffff);
  }
  return output;
}

const cases = [
  ['empty', ''],
  ['ascii', 'fnv64 stable identity'],
  ['unicode', 'héllö · 東京 · 🦄'],
  ['surrogate pair and unpaired code units', '\ud83d\ude00\ud800\udfff'],
  ['long string', '0123456789abcdef'.repeat(16 * 1024)],
  ['generated strings', Array.from({ length: 64 }, (_, index) => generatedString(index + 1, (index * 37) % 257))],
  ['generated nested arrays', Array.from({ length: 32 }, (_, index) => [
    generatedString(0x1000 + index, index + 3),
    generatedString(0x2000 + index, 257 - index),
  ])],
];

for (const [label, value] of cases) {
  assert.equal(stableDigest(value), referenceDigest(value), `${label} must match the BigInt FNV-64 reference`);
}

console.log(`✔ fnv64 word arithmetic matches BigInt reference for ${cases.length} Unicode/generated cases`);
