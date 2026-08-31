from pathlib import Path

# #3052/#3053: producer registry identity and fusion budget authority.
p = Path('js/analysis/discovery/fusion.js')
s = p.read_text()
old = """  register(producer) {
    if (typeof producer?.produce !== 'function') throw new TypeError('discovery-producer-must-implement-produce');
    const id = String(producer.id ?? '');
    if (!id) throw new TypeError('discovery-producer-id-required');
    this.producers.set(id, producer);
    return this;
  }"""
new = """  register(producer) {
    if (typeof producer?.produce !== 'function') throw new TypeError('discovery-producer-must-implement-produce');
    if (typeof producer.id !== 'string' || !producer.id.trim()) throw new TypeError('discovery-producer-id-required');
    this.producers.set(producer.id, producer);
    return this;
  }"""
if old not in s:
    raise SystemExit('producer register anchor drift')
s = s.replace(old, new, 1)
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
    if anchor not in s:
        raise SystemExit('budget helper anchor drift')
    s = s.replace(anchor, helper, 1)
old = "const budget = { ...DISCOVERY_DEFAULT_BUDGET, ...(options.budget ?? {}) };"
new = "const budget = normalizeDiscoveryBudget(options.budget);"
if old not in s:
    raise SystemExit('budget use anchor drift')
s = s.replace(old, new, 1)
p.write_text(s)

# #3080/#3081: pattern identity and byte/mask evidence must remain typed.
p = Path('js/analysis/discovery/producers.js')
s = p.read_text()
anchor = """/**
 * A declarative byte-pattern producer.
"""
helpers = """function requiredPatternIdentity(value, code) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(code);
  return value;
}

function optionalPatternArchitecture(value) {
  if (value == null) return null;
  return requiredPatternIdentity(value, 'discovery-pattern-invalid-architecture-id');
}

function patternIdentity(value) {
  return value == null ? 'pattern' : requiredPatternIdentity(value, 'discovery-pattern-invalid-id');
}

function canonicalPatternBytes(value, code) {
  if (value instanceof Uint8Array) {
    if (value.length === 0) throw new TypeError(code);
    return Uint8Array.from(value);
  }
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(code);
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 0 || item > 0xff) throw new TypeError(code);
  }
  return Uint8Array.from(value);
}

""" + anchor
if 'function canonicalPatternBytes(value, code)' not in s:
    if anchor not in s:
        raise SystemExit('pattern helper anchor drift')
    s = s.replace(anchor, helpers, 1)
old = """  const compiled = patterns.map((pattern) => {
    if (!pattern || (!Array.isArray(pattern.bytes) && !(pattern.bytes instanceof Uint8Array)) || pattern.bytes.length === 0) {
      throw new TypeError('discovery-pattern-invalid-bytes');
    }
    const bytes = Uint8Array.from(pattern.bytes);
    let mask = null;
    if (pattern.mask) {
      if (pattern.mask.length !== bytes.length) {
        throw new TypeError('discovery-pattern-mask-length-mismatch');
      }
      mask = Uint8Array.from(pattern.mask);
    }
    return {
      id: String(pattern.id ?? 'pattern'),
      bytes,
      mask,
    };
  });
  return Object.freeze({
    id: String(id),
    architectureId: architectureId == null ? null : String(architectureId),"""
new = """  const producerId = requiredPatternIdentity(id, 'discovery-pattern-producer-id-required');
  const producerArchitectureId = optionalPatternArchitecture(architectureId);
  const compiled = patterns.map((pattern) => {
    if (!pattern || typeof pattern !== 'object' || Array.isArray(pattern)) {
      throw new TypeError('discovery-pattern-invalid-bytes');
    }
    const bytes = canonicalPatternBytes(pattern.bytes, 'discovery-pattern-invalid-bytes');
    let mask = null;
    if (pattern.mask != null) {
      mask = canonicalPatternBytes(pattern.mask, 'discovery-pattern-invalid-mask');
      if (mask.length !== bytes.length) {
        throw new TypeError('discovery-pattern-mask-length-mismatch');
      }
    }
    return {
      id: patternIdentity(pattern.id),
      bytes,
      mask,
    };
  });
  return Object.freeze({
    id: producerId,
    architectureId: producerArchitectureId,"""
if old not in s:
    raise SystemExit('pattern compile anchor drift')
s = s.replace(old, new, 1)
p.write_text(s)

Path('tests/phase7/discovery/strict-boundaries-3052-3081.test.mjs').write_text(r'''import assert from 'node:assert/strict';
import test from 'node:test';
import { DiscoveryProducerRegistry, fuseFunctionCandidates } from '../../../js/analysis/discovery/fusion.js';
import { createPatternProducer } from '../../../js/analysis/discovery/producers.js';

const malformedIds = [['p1'], 1, true, { toString(){ return 'p1'; } }, ''];
for (const id of malformedIds) {
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
assert.equal(fuseFunctionCandidates([], { budget:{ maxCandidates:1, maxEvidencePerCandidate:1 }, snapshotId:'s' }).status.completeness, 'complete');

test('pattern producer identity fields are string-only', () => {
  for (const bad of [['p'], 1, true, { toString(){ return 'p'; } }, '']) {
    assert.throws(() => createPatternProducer({ id:bad, architectureId:'arm64', patterns:[{ bytes:[0xaa] }] }), /producer-id-required/);
  }
  for (const bad of [['arm64'], 1, true, { toString(){ return 'arm64'; } }, '']) {
    assert.throws(() => createPatternProducer({ id:'p', architectureId:bad, patterns:[{ bytes:[0xaa] }] }), /architecture-id/);
  }
  for (const bad of [['sig'], 1, true, { toString(){ return 'sig'; } }, '']) {
    assert.throws(() => createPatternProducer({ id:'p', architectureId:'arm64', patterns:[{ id:bad, bytes:[0xaa] }] }), /invalid-id/);
  }
  const valid = createPatternProducer({ id:'p', architectureId:'arm64', patterns:[{ bytes:[0xaa] }] });
  assert.equal(valid.id, 'p');
  assert.equal(valid.architectureId, 'arm64');
});

test('pattern bytes and masks never coerce malformed elements', () => {
  const badValues = [256, -1, '170', true, 1.5, NaN, Infinity, [170], { valueOf(){ return 170; } }];
  for (const value of badValues) {
    assert.throws(() => createPatternProducer({ id:'p', architectureId:'arm64', patterns:[{ bytes:[value] }] }), /invalid-bytes/);
    assert.throws(() => createPatternProducer({ id:'p', architectureId:'arm64', patterns:[{ bytes:[0xaa], mask:[value] }] }), /invalid-mask/);
  }
  const validArray = createPatternProducer({ id:'p', architectureId:'arm64', patterns:[{ id:'sig', bytes:[0xaa], mask:[0xff] }], alignment:1 });
  assert.equal(validArray.produce({ image:{ code:Uint8Array.of(0xaa), codeBaseAddress:'4096' } }).length, 1);
  const validTyped = createPatternProducer({ id:'q', architectureId:null, patterns:[{ bytes:Uint8Array.of(0xbb), mask:Uint8Array.of(0xff) }], alignment:1 });
  assert.equal(validTyped.produce({ image:{ code:Uint8Array.of(0xbb), codeBaseAddress:'8192' } }).length, 1);
  assert.throws(() => createPatternProducer({ id:'wild', architectureId:'arm64', patterns:[{ bytes:[0xaa], mask:[256] }] }), /invalid-mask/);
});

console.log('discovery strict boundaries #3052/#3053/#3080/#3081: PASS');
''')
