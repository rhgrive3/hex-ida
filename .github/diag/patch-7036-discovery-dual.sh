#!/usr/bin/env bash
set -euo pipefail

# Preserve the reviewed X03 ambiguity artifact as a compatibility lane while
# retaining current-main T016 v2 as the canonical production/rebuild artifact.
git show "$HEAD_SHA:js/analysis/discovery/artifact.js" > js/analysis/discovery/legacy-artifact.js

python3 - <<'PY'
from pathlib import Path

# Current-main producer identities stay authoritative. Add only the X03 factory
# provenance predicate required by the legacy compatibility lane.
p = Path('js/analysis/discovery/producers.js')
s = p.read_text()
if 'export function isCanonicalDiscoveryProducer' not in s:
    anchor = """export const GENERIC_PRODUCERS = Object.freeze([\n  loaderProducer,\n  exportProducer,\n  symbolTableProducer,\n  referenceProducer,\n  callGraphProducer,\n]);"""
    addition = anchor + """\n\n// Object identity, not producer id text, is the authority boundary used by\n// the X03 compatibility artifact.\nconst CANONICAL_DISCOVERY_PRODUCERS = new WeakSet(GENERIC_PRODUCERS);\n\nexport function isCanonicalDiscoveryProducer(producer) {\n  return !!producer && CANONICAL_DISCOVERY_PRODUCERS.has(producer);\n}"""
    if anchor not in s:
        raise SystemExit('producer anchor missing')
    s = s.replace(anchor, addition, 1)
    p.write_text(s)

# Route artifact operations by factory-issued identity. T016 v2 remains the
# default path; only factory-issued X03 v1 values enter the legacy lane.
p = Path('js/analysis/discovery/artifact.js')
s = p.read_text()
if "import * as legacyDiscoveryArtifact from './legacy-artifact.js';" not in s:
    anchor = "import { canonicalTypedDigest, canonicalTypedString } from './canonical-value.js';\n"
    if anchor not in s:
        raise SystemExit('artifact import anchor missing')
    s = s.replace(anchor, anchor + "import * as legacyDiscoveryArtifact from './legacy-artifact.js';\n", 1)

old = """export function isFactoryIssuedDiscoveryArtifact(artifact) {\n  return artifactIdentityValid(artifact);\n}"""
new = """export function isFactoryIssuedDiscoveryArtifact(artifact) {\n  return artifactIdentityValid(artifact)\n    || legacyDiscoveryArtifact.isFactoryIssuedDiscoveryArtifact(artifact);\n}"""
if old in s:
    s = s.replace(old, new, 1)
elif new not in s:
    raise SystemExit('artifact identity anchor missing')

anchor = "export function discoveryArtifactForRebuild(artifact, expected = {}) {\n"
insert = anchor + "  if (legacyDiscoveryArtifact.isFactoryIssuedDiscoveryArtifact(artifact)) {\n    return legacyDiscoveryArtifact.discoveryArtifactForRebuild(artifact, expected);\n  }\n"
if insert not in s:
    if anchor not in s:
        raise SystemExit('artifact rebuild anchor missing')
    s = s.replace(anchor, insert, 1)

anchor = "export function isFactoryIssuedDiscoveryRebuildBinding(binding) {\n"
insert = anchor + "  if (legacyDiscoveryArtifact.isFactoryIssuedDiscoveryRebuildBinding(binding)) return true;\n"
if insert not in s:
    if anchor not in s:
        raise SystemExit('binding identity anchor missing')
    s = s.replace(anchor, insert, 1)

anchor = "export function verifyDiscoveryReparse(sourceBinding, reparsedArtifact, options = {}) {\n"
insert = anchor + "  if (legacyDiscoveryArtifact.isFactoryIssuedDiscoveryRebuildBinding(sourceBinding)) {\n    return legacyDiscoveryArtifact.verifyDiscoveryReparse(sourceBinding, reparsedArtifact, options);\n  }\n"
if insert not in s:
    if anchor not in s:
        raise SystemExit('verify reparse anchor missing')
    s = s.replace(anchor, insert, 1)

compat = """\n\n// X03 compatibility surface. These factories issue their own v1 identities;\n// v2 production callers continue through createDiscoveryArtifact above.\nexport const normalizeDiscoveryArtifactBudget = (...args) => legacyDiscoveryArtifact.normalizeDiscoveryArtifactBudget(...args);\nexport const discoveryReferencesFromImage = (...args) => legacyDiscoveryArtifact.discoveryReferencesFromImage(...args);\nexport const functionDiscoveryArtifact = (...args) => legacyDiscoveryArtifact.functionDiscoveryArtifact(...args);\n"""
if 'export const functionDiscoveryArtifact =' not in s:
    s += compat
p.write_text(s)
PY

git add js/analysis/discovery/artifact.js js/analysis/discovery/legacy-artifact.js js/analysis/discovery/producers.js
