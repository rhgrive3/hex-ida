from pathlib import Path

# ArtifactStore: validate authority IDs before they become Map/backend keys.
p = Path('js/core/artifacts/store.js')
s = p.read_text()
anchor = "function isAbort(error, signal) {\n  return error?.name === 'AbortError' || !!signal?.aborted;\n}\n"
helper = anchor + "\nfunction requireArtifactId(value) {\n  if (typeof value !== 'string' || !value) throw new TypeError('artifact-id-required');\n  return value;\n}\n"
if 'function requireArtifactId(value)' not in s:
    if anchor not in s: raise SystemExit('store helper anchor drift')
    s = s.replace(anchor, helper, 1)
repls = [
("return this.epochs.get(String(artifactId)) || 0;", "return this.epochs.get(requireArtifactId(artifactId)) || 0;"),
("const id = String(artifactId);\n    this.epochs.set(id, this.#epoch(id) + 1);", "const id = requireArtifactId(artifactId);\n    this.epochs.set(id, this.#epoch(id) + 1);"),
("const active = this.mutations.get(String(artifactId));", "const active = this.mutations.get(requireArtifactId(artifactId));"),
("const id = String(artifactId);\n    const previous = this.mutations.get(id);", "const id = requireArtifactId(artifactId);\n    const previous = this.mutations.get(id);"),
("const artifactId = String(descriptor?.artifactId ?? descriptorOrId ?? '');\n    if (!artifactId) throw new TypeError('artifact-id-required');", "const artifactId = requireArtifactId(descriptor?.artifactId ?? descriptorOrId);"),
("const currentId = String(record.artifactId);", "const currentId = requireArtifactId(record.artifactId);"),
("const artifactId = String(descriptor.artifactId);", "const artifactId = requireArtifactId(descriptor.artifactId);"),
("const id = String(artifactId ?? '');\n    if (!id) throw new TypeError('artifact-id-required');", "const id = requireArtifactId(artifactId);"),
("    this.#bumpEpoch(artifactId);\n    this.hotCache.delete(artifactId, true);\n    this.#bumpEpoch(artifactId);", "    const id = requireArtifactId(artifactId);\n    this.#bumpEpoch(id);\n    this.hotCache.delete(id, true);\n    this.#bumpEpoch(id);"),
]
for old,new in repls:
    if old in s: s=s.replace(old,new,1)
    elif new not in s: raise SystemExit(f'store anchor drift: {old[:80]}')
p.write_text(s)

# Backends: every public storage key and stored row must be an explicit string.
p = Path('js/core/artifacts/backends.js')
s = p.read_text()
anchor = "function abortError(signal) {\n  return signal?.reason ?? new DOMException('Aborted', 'AbortError');\n}\n"
helper = anchor + "\nfunction requireArtifactId(value) {\n  if (typeof value !== 'string' || !value) throw new TypeError('artifact-id-required');\n  return value;\n}\n"
if 'function requireArtifactId(value)' not in s:
    if anchor not in s: raise SystemExit('backend helper anchor drift')
    s=s.replace(anchor,helper,1)
repls = [
("artifactId:String(record.artifactId),", "artifactId:requireArtifactId(record.artifactId),"),
("this.entries.get(String(artifactId))", "this.entries.get(requireArtifactId(artifactId))"),
("const id = String(record.artifactId);", "const id = requireArtifactId(record.artifactId);"),
("const id = String(artifactId);", "const id = requireArtifactId(artifactId);"),
("return this.entries.has(String(artifactId));", "return this.entries.has(requireArtifactId(artifactId));"),
("tx.objectStore('artifacts').get(String(artifactId))", "tx.objectStore('artifacts').get(requireArtifactId(artifactId))"),
("tx.objectStore('artifacts').getKey(String(artifactId))", "tx.objectStore('artifacts').getKey(requireArtifactId(artifactId))"),
]
# Some `const id` anchors appear in both backend classes; replace all of those.
for old,new in repls:
    if old.startswith('const id = String(artifactId);'):
        s=s.replace(old,new)
    elif old in s:
        s=s.replace(old,new)
    elif new not in s:
        raise SystemExit(f'backend anchor drift: {old[:80]}')
p.write_text(s)

# EvidenceGraph: lookups use the same strict ID contract as node creation.
p = Path('js/core/evidence/index.js')
s = p.read_text()
s = s.replace("  getNode(id) { return this.#nodes.get(String(id)) || null; }\n  hasNode(id) { return this.#nodes.has(String(id)); }", "  getNode(id) { return this.#nodes.get(required(id, 'evidence-id-required')) || null; }\n  hasNode(id) { return this.#nodes.has(required(id, 'evidence-id-required')); }")
old = "  evaluateClaim(id) {\n    const claim = this.getNode(id);\n    if (!claim || claim.family !== 'Claim') {\n      return deepFreeze({ verdict: 'unknown', claimId: String(id), supportingEvidenceIds: [], contradictingEvidenceIds: [], confirmedByEvidenceIds: [], missingEvidenceIds: [String(id)] });\n    }"
new = "  evaluateClaim(id) {\n    const claimId = required(id, 'evidence-id-required');\n    const claim = this.getNode(claimId);\n    if (!claim || claim.family !== 'Claim') {\n      return deepFreeze({ verdict: 'unknown', claimId, supportingEvidenceIds: [], contradictingEvidenceIds: [], confirmedByEvidenceIds: [], missingEvidenceIds: [claimId] });\n    }"
if old in s: s=s.replace(old,new,1)
elif new not in s: raise SystemExit('evidence evaluate anchor drift')
p.write_text(s)

Path('tests/core-artifact-evidence-authority-ids.mjs').write_text(r'''import assert from 'node:assert/strict';
import { ArtifactStore, ArtifactHotCache, MemoryArtifactBackend } from '../js/core/artifacts/index.js';
import { EvidenceGraph } from '../js/core/evidence/index.js';

const backend = new MemoryArtifactBackend();
for (const malformed of [['artifact-A'], 1, true, { toString(){ return 'artifact-A'; } }]) {
  await assert.rejects(() => backend.getRaw(malformed), /artifact-id-required/);
  await assert.rejects(() => backend.delete(malformed), /artifact-id-required/);
  await assert.rejects(() => backend.has(malformed), /artifact-id-required/);
}

const store = new ArtifactStore({ backend, hotCache:new ArtifactHotCache() });
for (const malformed of [['artifact-A'], 1, true, { toString(){ return 'artifact-A'; } }]) {
  await assert.rejects(() => store.get(malformed), /artifact-id-required/);
  await assert.rejects(() => store.delete(malformed), /artifact-id-required/);
  assert.throws(() => store.evictHot(malformed), /artifact-id-required/);
}

const graph = new EvidenceGraph({ nodes:[{
  id:'claim-A', family:'Claim', semanticKind:'test', targetEntityIds:['entity-A'],
}], edges:[] });
assert.equal(graph.hasNode('claim-A'), true);
assert.equal(graph.getNode('claim-A')?.id, 'claim-A');
assert.equal(graph.evaluateClaim('claim-A').claimId, 'claim-A');
for (const malformed of [['claim-A'], 1, true, { toString(){ return 'claim-A'; } }]) {
  assert.throws(() => graph.hasNode(malformed), /evidence-id-required/);
  assert.throws(() => graph.getNode(malformed), /evidence-id-required/);
  assert.throws(() => graph.evaluateClaim(malformed), /evidence-id-required/);
}
assert.equal(graph.evaluateClaim('missing').verdict, 'unknown');
assert.deepEqual(graph.evaluateClaim('missing').missingEvidenceIds, ['missing']);

console.log('core-artifact-evidence-authority-ids: PASS');
''')
