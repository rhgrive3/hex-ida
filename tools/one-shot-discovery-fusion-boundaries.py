from pathlib import Path

p=Path('js/analysis/discovery/fusion.js')
s=p.read_text()
old="""  register(producer) {
    if (typeof producer?.produce !== 'function') throw new TypeError('discovery-producer-must-implement-produce');
    const id = String(producer.id ?? '');
    if (!id) throw new TypeError('discovery-producer-id-required');
    this.producers.set(id, producer);
    return this;
  }"""
new="""  register(producer) {
    if (typeof producer?.produce !== 'function') throw new TypeError('discovery-producer-must-implement-produce');
    if (typeof producer.id !== 'string' || !producer.id.trim()) throw new TypeError('discovery-producer-id-required');
    this.producers.set(producer.id, producer);
    return this;
  }"""
if old not in s: raise SystemExit('producer register anchor drift')
s=s.replace(old,new,1)
anchor="""export const DISCOVERY_DEFAULT_BUDGET = Object.freeze({
  maxCandidates: 200000,
  maxEvidencePerCandidate: 64,
});
"""
helper=anchor+"""
function normalizeDiscoveryBudget(value) {
  if (value == null) return DISCOVERY_DEFAULT_BUDGET;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('discovery-budget-invalid');
  const out = { ...DISCOVERY_DEFAULT_BUDGET };
  for (const key of ['maxCandidates', 'maxEvidencePerCandidate']) {
    if (value[key] == null) continue;
    if (typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || value[key] < 1) {
      throw new TypeError(`discovery-budget-${key}-invalid`);
    }
    out[key] = value[key];
  }
  return Object.freeze(out);
}
"""
if 'function normalizeDiscoveryBudget(value)' not in s:
    if anchor not in s: raise SystemExit('budget helper anchor drift')
    s=s.replace(anchor,helper,1)
old="const budget = { ...DISCOVERY_DEFAULT_BUDGET, ...(options.budget ?? {}) };"
new="const budget = normalizeDiscoveryBudget(options.budget);"
if old not in s: raise SystemExit('budget use anchor drift')
s=s.replace(old,new,1)
p.write_text(s)

Path('tests/phase7/discovery/fusion-strict-boundaries-3052-3053.test.mjs').write_text(r'''import assert from 'node:assert/strict';
import { DiscoveryProducerRegistry, fuseFunctionCandidates } from '../../../js/analysis/discovery/fusion.js';

for (const id of [['p1'], 1, true, { toString(){ return 'p1'; } }, '']) {
  const registry = new DiscoveryProducerRegistry();
  assert.throws(() => registry.register({ id, produce(){ return []; } }), /discovery-producer-id-required/);
}
const registry = new DiscoveryProducerRegistry();
registry.register({ id:'p1', architectureId:null, produce(){ return []; } });
assert.deepEqual(registry.collect({}, 'arm64').producerIds, ['p1']);

for (const malformed of ['1', ['1'], true, 1.5, 0, -1, Infinity]) {
  assert.throws(() => fuseFunctionCandidates([], { budget:{ maxCandidates:malformed } }), /discovery-budget-maxCandidates-invalid/);
  assert.throws(() => fuseFunctionCandidates([], { budget:{ maxEvidencePerCandidate:malformed } }), /discovery-budget-maxEvidencePerCandidate-invalid/);
}
assert.throws(() => fuseFunctionCandidates([], { budget:['bad'] }), /discovery-budget-invalid/);
const ok = fuseFunctionCandidates([], { budget:{ maxCandidates:1, maxEvidencePerCandidate:1 }, snapshotId:'s' });
assert.equal(ok.status.completeness, 'complete');
console.log('discovery fusion strict boundaries 3052/3053: PASS');
''')
