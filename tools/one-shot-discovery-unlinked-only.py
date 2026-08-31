from pathlib import Path


def edit(path, replacements):
    p = Path(path)
    s = p.read_text()
    for old, new, label in replacements:
        if old not in s:
            raise SystemExit(f'{path}: anchor drift: {label}')
        s = s.replace(old, new, 1)
    p.write_text(s)


p = Path('js/analysis/discovery/fusion.js')
s = p.read_text()
anchor = """export const DISCOVERY_DEFAULT_BUDGET = Object.freeze({
  maxCandidates: 200000,
  maxEvidencePerCandidate: 64,
});
"""
helper = anchor + """
function normalizeDiscoveryBudget(value) {
  if (value == null) return DISCOVERY_DEFAULT_BUDGET;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('discovery-budget-invalid');
  const out = { ...DISCOVERY_DEFAULT_BUDGET };
  for (const key of ['maxCandidates', 'maxEvidencePerCandidate']) {
    if (!Object.hasOwn(value, key) || value[key] == null) continue;
    if (typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || value[key] < 1) {
      throw new TypeError(`discovery-budget-${key}-invalid`);
    }
    out[key] = value[key];
  }
  return Object.freeze(out);
}
"""
if anchor not in s:
    raise SystemExit('fusion: budget anchor drift')
s = s.replace(anchor, helper, 1)
p.write_text(s)

edit('js/analysis/discovery/fusion.js', [
    ("""  constructor() {
    this.producers = new Map();
  }

  register(producer) {
    if (typeof producer?.produce !== 'function') throw new TypeError('discovery-producer-must-implement-produce');
    const id = String(producer.id ?? '');
    if (!id) throw new TypeError('discovery-producer-id-required');
    this.producers.set(id, producer);
    return this;
  }""",
     """  constructor() {
    this.producers = new Map();
    this.producerIds = new WeakMap();
  }

  register(producer) {
    if (typeof producer?.produce !== 'function') throw new TypeError('discovery-producer-must-implement-produce');
    if (typeof producer.id !== 'string' || producer.id.trim().length === 0) throw new TypeError('discovery-producer-id-required');
    const id = producer.id;
    this.producers.set(id, producer);
    this.producerIds.set(producer, id);
    return this;
  }""", 'producer registration authority'),
    ("""    return [...this.producers.values()]
      .filter((producer) => producer.architectureId == null || producer.architectureId === architectureId)
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));""",
     """    return [...this.producers.values()]
      .filter((producer) => producer.architectureId == null || producer.architectureId === architectureId)
      .sort((left, right) => this.producerIds.get(left).localeCompare(this.producerIds.get(right)));""", 'producer ordering authority'),
    ("""    for (const producer of this.for(architectureId)) {
      if (options.signal?.aborted) break;
      const produced = producer.produce(input, options) ?? [];
      for (const item of produced) evidence.push({ ...item, producerId: producer.id, architectureId: producer.architectureId ?? null });
      producerIds.push(producer.id);
    }""",
     """    for (const producer of this.for(architectureId)) {
      if (options.signal?.aborted) break;
      const producerId = this.producerIds.get(producer);
      const produced = producer.produce(input, options) ?? [];
      for (const item of produced) evidence.push({ ...item, producerId, architectureId: producer.architectureId ?? null });
      producerIds.push(producerId);
    }""", 'producer collection authority'),
    ("""export function fuseFunctionCandidates(evidence, options = {}) {
  const budget = { ...DISCOVERY_DEFAULT_BUDGET, ...(options.budget ?? {}) };""",
     """export function fuseFunctionCandidates(evidence, options = {}) {
  const budget = normalizeDiscoveryBudget(options.budget);""", 'discovery budget boundary'),
])

Path('tests/phase7/discovery-unlinked-strict-boundaries.test.mjs').write_text(r'''import assert from 'node:assert/strict';
import { DiscoveryProducerRegistry, fuseFunctionCandidates } from '../../js/analysis/discovery/fusion.js';

const evidence=(start='4096')=>({kind:'reference',authority:'corroborating',start,extentRole:'complete',regions:[]});

// #3052: only explicit non-empty string IDs enter registry identity, and the
// registration-time identity remains authoritative even if the producer object
// is mutated afterwards.
for (const bad of [["p1"],1,true,{},null,'','   ']) {
  const registry=new DiscoveryProducerRegistry();
  assert.throws(()=>registry.register({id:bad,architectureId:null,produce(){return [evidence()];}}),/discovery-producer-id-required/);
}
const first={id:'p1',architectureId:null,produce(){return [evidence()];}};
const second={id:'p2',architectureId:null,produce(){return [evidence()];}};
const registry=new DiscoveryProducerRegistry();
registry.register(second).register(first);
first.id=['mutated'];
second.id={toString(){return 'aaa';}};
assert.deepEqual(registry.for('arm64'),[first,second],'deterministic order uses registered canonical IDs');
const collected=registry.collect({},'arm64');
assert.deepEqual(collected.producerIds,['p1','p2']);
assert.deepEqual(collected.evidence.map((item)=>item.producerId),['p1','p2']);
const fused=fuseFunctionCandidates(collected.evidence);
assert.equal(fused.candidates[0].startState,'probable','independence proof uses canonical registered provenance');

// #3053: budget fields are typed finite positive safe integers. Coercible or
// malformed structured values cannot silently redefine truncation authority.
const valid=fuseFunctionCandidates([evidence()],{budget:{maxCandidates:1,maxEvidencePerCandidate:1}});
assert.equal(valid.candidates.length,1);
for (const bad of [
  '1', true, [],
  {maxCandidates:'1'}, {maxCandidates:0}, {maxCandidates:-1}, {maxCandidates:1.5}, {maxCandidates:Infinity},
  {maxEvidencePerCandidate:'1'}, {maxEvidencePerCandidate:0}, {maxEvidencePerCandidate:-1},
  {maxEvidencePerCandidate:1.5}, {maxEvidencePerCandidate:NaN},
]) assert.throws(()=>fuseFunctionCandidates([evidence()],{budget:bad}),/discovery-budget/);

console.log('discovery unlinked strict boundaries #3052/#3053: PASS');
''')
