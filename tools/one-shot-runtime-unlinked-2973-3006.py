from pathlib import Path

# #3003: canonical runtime authority numerics are number-only.
p=Path('js/runtime/authority.js'); s=p.read_text()
old="""function numericPrimitive(value, code) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  throw new TypeError(code);
}"""
new="""function numericPrimitive(value, code) {
  if (typeof value !== 'number') throw new TypeError(code);
  return value;
}"""
if old not in s: raise SystemExit('authority numeric anchor drift')
p.write_text(s.replace(old,new,1))

# #2975: RuntimeEvidenceBridge must not launder authority fields.
p=Path('js/runtime/evidence-bridge.js'); s=p.read_text()
old="""function completeness(value, fallback = 'partial') {
  const normalized = String(value ?? fallback);
  if (!EVIDENCE_COMPLETENESS.includes(normalized)) throw new DebugAdapterError('runtime-invalid-completeness', `invalid evidence completeness: ${normalized}`);
  return normalized;
}"""
new="""function completeness(value, fallback = 'partial') {
  const normalized = value == null ? fallback : value;
  if (typeof normalized !== 'string' || !EVIDENCE_COMPLETENESS.includes(normalized)) {
    throw new DebugAdapterError('runtime-invalid-completeness', 'invalid evidence completeness');
  }
  return normalized;
}"""
if old not in s: raise SystemExit('evidence completeness anchor drift')
s=s.replace(old,new,1)
old="confidence: options.confidence == null ? null : Number(options.confidence),"
new="confidence: options.confidence == null ? null : (typeof options.confidence === 'number' && Number.isFinite(options.confidence) ? options.confidence : (() => { throw new DebugAdapterError('runtime-invalid-confidence', 'runtime evidence confidence must be a finite number'); })()),"
if old not in s: raise SystemExit('evidence confidence anchor drift')
s=s.replace(old,new,1)
old="""  linkClaim(claimId, evidenceId, relation, resolution = null) {
    const type = String(relation);
    if (!RELATIONS.includes(type)) throw new DebugAdapterError('runtime-invalid-evidence-relation', `invalid runtime evidence relation: ${type}`);"""
new="""  linkClaim(claimId, evidenceId, relation, resolution = null) {
    if (typeof relation !== 'string' || !RELATIONS.includes(relation)) {
      throw new DebugAdapterError('runtime-invalid-evidence-relation', 'invalid runtime evidence relation');
    }
    const type = relation;"""
if old not in s: raise SystemExit('evidence relation anchor drift')
s=s.replace(old,new,1)
p.write_text(s)

# #2973: a non-empty array is not identity proof unless every ID is canonical.
p=Path('js/runtime/trace-provider.js'); s=p.read_text()
old="""      const identityEvidenceIds = Array.isArray(module.identityEvidenceIds) ? module.identityEvidenceIds : [];
      const hasProvenStaticIdentity = module.binaryId != null && (module.identityState === 'exact' || module.identityState === 'resolved' || identityEvidenceIds.length > 0);"""
new="""      const identityEvidenceIds = Array.isArray(module.identityEvidenceIds) ? module.identityEvidenceIds : [];
      const hasValidIdentityEvidence = identityEvidenceIds.length > 0
        && identityEvidenceIds.every((id) => typeof id === 'string' && id.trim().length > 0);
      const hasProvenStaticIdentity = module.binaryId != null
        && (module.identityState === 'exact' || module.identityState === 'resolved' || hasValidIdentityEvidence);"""
if old not in s: raise SystemExit('trace proof anchor drift')
p.write_text(s.replace(old,new,1))

# #3006: refresh equality must preserve canonical types instead of String-coercing malformed updates.
p=Path('js/runtime/debugger-provider.js'); s=p.read_text()
old="""function sameModuleBinding(current, next) {
  if (!current || !next) return false;
  const scalar = (value) => value == null ? null : String(value);
  const currentEvidence = current.identityEvidenceIds ?? [];
  const nextEvidence = next.identityEvidenceIds ?? [];
  return scalar(current.runtimeBase) === scalar(next.runtimeBase)
    && scalar(current.runtimeSize) === scalar(next.runtimeSize)
    && scalar(current.staticBase) === scalar(next.staticBase)
    && scalar(current.pathHint) === scalar(next.pathHint)
    && scalar(current.binaryId) === scalar(next.binaryId)
    && scalar(current.sliceId) === scalar(next.sliceId)
    && scalar(current.imageId) === scalar(next.imageId)
    && scalar(current.identityState) === scalar(next.identityState)
    && sameStructuredIdentity(current.buildIdentity, next.buildIdentity)
    && currentEvidence.length === nextEvidence.length
    && currentEvidence.every((value, index) => value === nextEvidence[index]);
}"""
new="""function sameModuleBinding(current, next) {
  if (!current || !next) return false;
  const currentEvidence = current.identityEvidenceIds ?? [];
  const nextEvidence = next.identityEvidenceIds ?? [];
  return Object.is(current.runtimeBase, next.runtimeBase)
    && Object.is(current.runtimeSize, next.runtimeSize)
    && Object.is(current.staticBase, next.staticBase)
    && Object.is(current.pathHint, next.pathHint)
    && Object.is(current.binaryId, next.binaryId)
    && Object.is(current.sliceId, next.sliceId)
    && Object.is(current.imageId, next.imageId)
    && Object.is(current.identityState, next.identityState)
    && sameStructuredIdentity(current.buildIdentity, next.buildIdentity)
    && currentEvidence.length === nextEvidence.length
    && currentEvidence.every((value, index) => value === nextEvidence[index]);
}"""
if old not in s: raise SystemExit('debugger binding equality anchor drift')
p.write_text(s.replace(old,new,1))

Path('tests/phase10/runtime-unlinked-strict-2973-3006.test.mjs').write_text(r'''import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRuntimeAuthorityBinding, createRuntimeObservation } from '../../js/runtime/authority.js';
import { conservativeCompleteness } from '../../js/runtime/evidence-bridge.js';

const bindingInput = {
  providerIdentity:'p', runtimeInstanceIdentity:'r', targetIdentity:'t', binaryIdentity:'b',
  moduleIdentity:'m', loadMappingIdentity:'l', sessionIdentity:'s', capabilityVersion:'1', epoch:1,
};
const binding = createRuntimeAuthorityBinding(bindingInput);
assert.equal(binding.epoch, 1);
assert.throws(() => createRuntimeAuthorityBinding({ ...bindingInput, epoch:'1' }), TypeError);
assert.throws(() => createRuntimeObservation({ binding, sequence:'2', observedAt:'now', kind:'trace-marker', payload:{} }), TypeError);
assert.throws(() => conservativeCompleteness(['complete']), /runtime-invalid-completeness/);
assert.equal(conservativeCompleteness('complete','bounded'), 'bounded');

const bridgeSource = fs.readFileSync(new URL('../../js/runtime/evidence-bridge.js', import.meta.url), 'utf8');
assert.ok(!bridgeSource.includes('confidence: options.confidence == null ? null : Number(options.confidence)'));
assert.ok(!bridgeSource.includes('const type = String(relation)'));
const traceSource = fs.readFileSync(new URL('../../js/runtime/trace-provider.js', import.meta.url), 'utf8');
assert.ok(traceSource.includes("identityEvidenceIds.every((id) => typeof id === 'string' && id.trim().length > 0)"));
assert.ok(!traceSource.includes('|| identityEvidenceIds.length > 0'));
const debuggerSource = fs.readFileSync(new URL('../../js/runtime/debugger-provider.js', import.meta.url), 'utf8');
assert.ok(!debuggerSource.includes("const scalar = (value) => value == null ? null : String(value)"));
assert.ok(debuggerSource.includes('Object.is(current.binaryId, next.binaryId)'));

console.log('runtime unlinked strict #2973/#2975/#3003/#3006: PASS');
''')
