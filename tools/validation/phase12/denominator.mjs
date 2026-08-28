import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as packageEnvelope from '../../../js/phase12/package-envelope.js';
import * as recognition from '../../../js/knowledge/phase12-recognition.js';
import * as rules from '../../../js/knowledge/phase12-rules.js';
import * as patterns from '../../../js/pattern/index.js';
import * as collaboration from '../../../js/collaboration/index.js';
import * as remote from '../../../js/collaboration/remote-authority.js';
import { phase12Maturity } from '../../../js/platform/capability-maturity.js';
import { stableStringify } from '../../../js/core/identity/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../../..');
export const DEFAULT_INVENTORY_PATH = path.join(HERE, 'denominator-inventory.json');
export const PHASE12_DENOMINATOR_SCHEMA = 'phase12-denominator-inventory/v2';
export const PHASE12_DENOMINATOR_REPORT_SCHEMA = 'phase12-denominator-report/v2';

export const PHASE12_DENOMINATOR_CATEGORIES = Object.freeze([
  'knowledge',
  'rules',
  'patterns',
  'remote-collaboration',
]);

const MODULES = Object.freeze({
  'js/phase12/package-envelope.js': packageEnvelope,
  'js/knowledge/phase12-recognition.js': recognition,
  'js/knowledge/phase12-rules.js': rules,
  'js/pattern/index.js': patterns,
  'js/collaboration/index.js': collaboration,
  'js/collaboration/remote-authority.js': remote,
  'js/platform/capability-maturity.js': { phase12Maturity },
});

const REQUIRED_UNITS = Object.freeze({
  knowledge: Object.freeze([
    'knowledge.package-envelope.format-version',
    'knowledge.package-envelope.manifest-version',
    'knowledge.package-envelope.provider-output-schema',
    'knowledge.package-envelope.input-byte-budget',
    'knowledge.package-envelope.default-limits',
    'knowledge.package-envelope.required-envelope-fields',
    'knowledge.package-envelope.dependency-identity',
    'knowledge.package-envelope.dependency-canonical-order',
    'knowledge.package-envelope.legacy-knowledge-compatibility',
    'knowledge.provider-output.entry-fallback',
    'knowledge.provider-output.completeness-classes',
    'knowledge.provider-output.provenance-and-identity',
    'knowledge.recognition.algorithm-version',
    'knowledge.recognition.match-tiers',
    'knowledge.recognition.package-kinds',
    'knowledge.recognition.outcome-classes',
    'knowledge.recognition.unique-claim-gate',
    'knowledge.recognition.explicit-local-promotion',
    'knowledge.behavior.dependency-pinning',
    'knowledge.behavior.provider-output',
    'knowledge.behavior.recognition-outcomes',
    'knowledge.external-confirmation-authority',
  ]),
  rules: Object.freeze([
    'rules.language-version',
    'rules.scope-registry',
    'rules.expression-operators',
    'rules.default-scope',
    'rules.default-version',
    'rules.package-kinds',
    'rules.package-payload-fallback',
    'rules.result-verdict-classes',
    'rules.result-dependency-classes',
    'rules.result-completeness-classes',
    'rules.behavior-result-classes',
    'rules.behavior-dependency-order-and-cycle',
    'rules.ai-capability-minting',
  ]),
  patterns: Object.freeze([
    'patterns.language-version',
    'patterns.primitive-registry',
    'patterns.expression-operators',
    'patterns.grammar-type-kinds',
    'patterns.value-type-kinds',
    'patterns.textual-struct-grammar',
    'patterns.textual-pointer-fallback',
    'patterns.textual-address-space-fallback',
    'patterns.evaluator-result-classes',
    'patterns.value-provenance',
    'patterns.snapshot-binding',
    'patterns.behavior-value-classes',
    'patterns.support-truth',
    'patterns.mutation',
    'patterns.network-and-arbitrary-javascript',
  ]),
  'remote-collaboration': Object.freeze([
    'remote.operation.schema-version',
    'remote.checkpoint.schema-version',
    'remote.envelope.schema-version',
    'remote.gate.schema-version',
    'remote.operation.envelope-fields',
    'remote.operation.action-classes',
    'remote.operation.meaningful-fact-classes',
    'remote.operation-result-classes',
    'remote.conflict-classes',
    'remote.gate.supported-schema-fallbacks',
    'remote.security.transport-proof-classes',
    'remote.security.egress-classes',
    'remote.security.rejection-classes',
    'remote.delivery-result-classes',
    'remote.behavior.operation-and-conflict-classes',
    'remote.behavior.security-gate',
    'remote.remote-canonical-transport',
    'remote.derived-analysis-egress',
  ]),
});

const REQUIRED_NORMATIVE_EXCLUSIONS = Object.freeze(new Set([
  'knowledge.external-confirmation-authority',
  'rules.ai-capability-minting',
  'patterns.mutation',
  'patterns.network-and-arbitrary-javascript',
  'remote.derived-analysis-egress',
]));

const REQUIRED_BLOCKING_GAPS = Object.freeze(new Set());

const EXPECTED_TRUTH = Object.freeze({
  knowledgePackages: Object.freeze({
    status: 'partial',
    authority: 'suggestion-only',
    limitations: Object.freeze(['legacy-v2-compatibility-adapter', 'package-derived-facts-require-local-promotion']),
  }),
  capabilityRules: Object.freeze({
    status: 'partial',
    authority: 'deterministic-evidence-only',
    limitations: Object.freeze(['partial-upstream-propagates', 'no-ai-capability-minting']),
  }),
  collaboration: Object.freeze({
    status: 'partial',
    authority: 'local-canonical-only',
    limitations: Object.freeze(['remote-security-gate-required', 'derived-analysis-excluded']),
  }),
  patterns: Object.freeze({
    status: 'partial',
    authority: 'read-only-bounded',
    limitations: Object.freeze(['no-arbitrary-javascript', 'no-loader-semantic-mutation']),
  }),
});

function equal(left, right) {
  try { return stableStringify(left) === stableStringify(right); } catch { return false; }
}

function sorted(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(String))].sort();
}

function pathValue(value, dottedPath) {
  let current = value;
  for (const part of String(dottedPath || '').split('.').filter(Boolean)) {
    if (current == null || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function readSource(root, relativePath, failures, id) {
  const relative = String(relativePath || '');
  if (!relative || path.isAbsolute(relative) || relative.split('/').includes('..')) {
    failures.push(`${id}:source-path-invalid`);
    return null;
  }
  const absolute = path.resolve(root, relative);
  try { return fs.readFileSync(absolute, 'utf8'); }
  catch { failures.push(`${id}:source-missing:${relative}`); return null; }
}

function checkSourceIncludes(check, root, failures, id) {
  const source = readSource(root, check.path, failures, id);
  if (source == null) return;
  for (const marker of check.markers || []) if (!source.includes(marker)) failures.push(`${id}:source-drift:${marker}`);
}

function checkSourceCollection(check, root, failures, id) {
  const source = readSource(root, check.path, failures, id);
  if (source == null) return;
  let scoped = source;
  if (check.start != null) {
    const start = source.indexOf(check.start);
    if (start < 0) { failures.push(`${id}:source-start-missing:${check.start}`); return; }
    const from = start + check.start.length;
    const end = check.end == null ? source.length : source.indexOf(check.end, from);
    if (end < 0) { failures.push(`${id}:source-end-missing:${check.end}`); return; }
    scoped = source.slice(from, end);
  }
  let matches;
  try { matches = [...scoped.matchAll(new RegExp(check.regex, 'g'))].map((item) => item[1]); }
  catch { failures.push(`${id}:source-regex-invalid`); return; }
  const observed = check.unique === false ? matches : [...new Set(matches)];
  const expected = check.unique === false ? (check.expected || []) : [...new Set(check.expected || [])];
  if (!equal(observed, expected)) failures.push(`${id}:source-collection-drift:${JSON.stringify({ observed, expected })}`);
}

function checkExportValue(check, failures, id) {
  const module = MODULES[check.module];
  if (!module) { failures.push(`${id}:module-unregistered:${check.module}`); return; }
  if (!Object.hasOwn(module, check.export)) { failures.push(`${id}:export-missing:${check.export}`); return; }
  if (!equal(module[check.export], check.expected)) failures.push(`${id}:export-drift:${check.export}`);
}

function checkTruthEntry(check, failures, id) {
  const module = MODULES[check.module];
  if (!module || typeof module[check.export] !== 'function') { failures.push(`${id}:truth-function-missing`); return; }
  const observed = pathValue(module[check.export](), check.path);
  if (!equal(observed, check.expected)) failures.push(`${id}:truth-drift:${check.path}`);
}

function behaviorDependencyPinning() {
  const dependency = packageEnvelope.createPackageEnvelope({ kind: 'knowledge', packageId: 'denominator-dependency', packageVersion: '1', payload: { marker: true } });
  const parent = packageEnvelope.createPackageEnvelope({
    kind: 'mixed', packageId: 'denominator-parent', packageVersion: '1',
    dependencies: [{ packageId: dependency.packageId, packageVersion: dependency.packageVersion, contentHash: dependency.contentHash }],
    payload: {},
  });
  const resolved = packageEnvelope.resolvePackageDependencies(parent, [dependency]);
  const observed = new Set(resolved.length === 1 && resolved[0].contentHash === dependency.contentHash ? ['exact-resolution'] : []);
  const lastHashNibble = dependency.contentHash.at(-1);
  const wrongHash = `${dependency.contentHash.slice(0, -1)}${lastHashNibble === '0' ? '1' : '0'}`;
  try { packageEnvelope.resolvePackageDependencies(parent, [{ ...dependency, contentHash: wrongHash }]); }
  catch (error) { if (error.code === 'package-dependency-not-pinned') observed.add('wrong-hash-rejected'); }
  try { packageEnvelope.resolvePackageDependencies(parent, [{ ...dependency, packageVersion: '2' }]); }
  catch (error) { if (error.code === 'package-dependency-not-pinned') observed.add('wrong-version-rejected'); }
  return observed;
}

function behaviorProviderOutput() {
  const base = { schemaVersion: packageEnvelope.PHASE12_PROVIDER_OUTPUT_SCHEMA, provenance: { source: 'denominator' }, targetIdentity: 'target', completeness: 'complete' };
  const observed = new Set();
  if (packageEnvelope.validateProviderOutput({ ...base, items: [{ id: 'item', targetIdentity: 'target' }] }).ok) observed.add('items');
  if (packageEnvelope.validateProviderOutput({ ...base, results: [{ id: 'item', targetIdentity: 'target' }] }).ok) observed.add('results');
  for (const completeness of ['complete', 'partial', 'truncated']) {
    const checked = packageEnvelope.validateProviderOutput({ ...base, completeness, items: [] });
    if (checked.ok) observed.add(completeness);
  }
  const incompleteUnique = packageEnvelope.validateProviderOutput({ ...base, completeness: 'partial', unique: true, items: [] });
  if (!incompleteUnique.ok && incompleteUnique.code === 'provider-output-incomplete-unique-invalid') observed.add('incomplete-unique-rejected');
  return observed;
}

function behaviorRecognitionOutcomes() {
  const observed = new Set();
  const suggestion = recognition.createMatchResult({ sourceEntityId: 'source', packageEntryId: 'entry', candidates: [{ packageEntryId: 'entry', score: 0.99, tier: 'exact-content' }] });
  if (suggestion.status === 'suggestion') observed.add('suggestion');
  const ambiguous = recognition.createMatchResult({ sourceEntityId: 'source', packageEntryId: 'entry', candidates: [
    { packageEntryId: 'entry', score: 0.94 }, { packageEntryId: 'other', score: 0.93 },
  ] });
  if (ambiguous.status === 'ambiguous') observed.add('ambiguous');
  const truncated = recognition.createMatchResult({ sourceEntityId: 'source', packageEntryId: 'entry', candidateSearchTruncated: true });
  if (truncated.completeness === 'partial') observed.add('truncated-partial');
  if (!recognition.recognitionCanClaimUnique(ambiguous) && !recognition.recognitionCanClaimUnique(truncated)) observed.add('no-unique-claim');
  const fact = recognition.promoteKnowledgeSuggestion(suggestion, { actorId: 'denominator-user', approvalToken: { approved: true, targetMatchId: suggestion.id } });
  if (fact.authority === 'L4-local-canonical' && fact.confirmation === 'user-confirmed') observed.add('local-promotion');
  return observed;
}

function behaviorRulesResultClasses() {
  const rule = rules.compileCapabilityRule({ id: 'denominator-rule', requiredFeatures: ['marker'], when: { op: 'equals', path: 'marker', value: true } });
  const observed = new Set();
  if (rules.evaluateCapabilityRule(rule, { features: { marker: true } }).verdict === 'supported') observed.add('supported');
  if (rules.evaluateCapabilityRule(rule, { features: { marker: false } }).verdict === 'not-detected') observed.add('not-detected');
  if (rules.evaluateCapabilityRule(rule, { features: {}, completeness: 'partial' }).verdict === 'partial') observed.add('partial');
  const missing = rules.evaluateCapabilityRule(rule, { features: {} });
  if (missing.assumptions.includes('required-feature-missing:marker')) observed.add('required-feature-missing');
  const dependency = rules.compileCapabilityRule({ id: 'denominator-dependent', dependencies: ['base'], when: { op: 'exists', path: 'marker' } });
  const missingDependency = rules.evaluateCapabilityRule(dependency, { features: { marker: true } });
  if (missingDependency.assumptions.includes('dependency-missing:base')) observed.add('dependency-missing');
  return observed;
}

function behaviorRulesDependencyOrder() {
  const ordered = rules.compileCapabilityRules([
    { id: 'root', dependencies: ['base'], when: { op: 'exists', path: 'marker' } },
    { id: 'base', when: { op: 'exists', path: 'marker' } },
  ]);
  const observed = new Set(ordered.map((item, index) => index === 0 && item.id === 'base' ? 'dependency-first' : null).filter(Boolean));
  try { rules.compileCapabilityRules([{ id: 'a', dependencies: ['b'], when: { op: 'exists', path: 'x' } }, { id: 'b', dependencies: ['a'], when: { op: 'exists', path: 'x' } }]); }
  catch (error) { if (/cycle/.test(String(error.message))) observed.add('cycle-rejected'); }
  try { rules.compileCapabilityRules([{ id: 'missing', dependencies: ['absent'], when: { op: 'exists', path: 'x' } }]); }
  catch (error) { if (/missing/.test(String(error.message))) observed.add('missing-dependency-rejected'); }
  return observed;
}

function behaviorPatternsValueClasses() {
  const compiled = patterns.compilePattern('struct Header { magic: u32le; count: u8[2]; }', { snapshotId: 'denominator-snapshot' });
  const bytes = Uint8Array.from([0x78, 0x56, 0x34, 0x12, 9, 8]);
  const result = patterns.evaluatePattern(compiled, { snapshotId: 'denominator-snapshot', size: bytes.length, read: (offset, length) => bytes.slice(Number(offset), Number(offset) + length) });
  const observed = new Set();
  if (result.status === 'complete') observed.add('complete');
  if (result.value?.fields?.magic?.type === 'u32le') observed.add('primitive');
  if (result.value?.fields?.count?.lazy === true && typeof result.value.fields.count.expand === 'function') observed.add('array-lazy');
  if (result.value?.fields?.magic?.provenance?.snapshotId === 'denominator-snapshot') observed.add('provenance');
  const partial = patterns.evaluatePattern(compiled, bytes, { maxNodes: 1, snapshotId: 'denominator-snapshot' });
  if (partial.status === 'partial') observed.add('partial');
  try { patterns.evaluatePattern(compiled, bytes, { snapshotId: 'other-snapshot' }); }
  catch (error) { if (/snapshot-mismatch/.test(String(error.message))) observed.add('snapshot-mismatch'); }
  return observed;
}

function behaviorPatternSupportTruth() {
  const truth = patterns.patternSupportTruth();
  const observed = new Set();
  if (truth.parser === 'supported') observed.add('parser-supported');
  if (truth.evaluator === 'bounded') observed.add('evaluator-bounded');
  if (truth.authority === 'L2-evidence') observed.add('authority-l2-evidence');
  return observed;
}

function behaviorRemoteOperationClasses() {
  const log = new collaboration.ChangeLog({ projectIdentity: 'denominator-project' });
  const operation = (operationId, input = {}) => collaboration.createProjectOperation({
    operationId, projectIdentity: 'denominator-project', targetEntityId: 'entity', factKind: 'name', action: 'set', payload: operationId, ...input,
  });
  const observed = new Set();
  if (log.applyOperation(operation('one')).status === 'applied') observed.add('applied');
  if (log.applyOperation(operation('one')).status === 'duplicate') observed.add('duplicate');
  if (log.applyOperation(operation('two')).status === 'conflict') observed.add('conflict');
  const unresolved = log.applyOperation(operation('three', { causalParents: ['missing-parent'] }));
  if (unresolved.status === 'unresolved') observed.add('unresolved');
  const rejected = log.applyOperation(operation('wrong-project', { projectIdentity: 'other-project' }));
  if (rejected.status === 'rejected') observed.add('rejected');
  const tombstoneLog = new collaboration.ChangeLog({ projectIdentity: 'tombstone-project' });
  const remove = collaboration.createProjectOperation({ operationId: 'remove', projectIdentity: 'tombstone-project', targetEntityId: 'entity', factKind: 'name', action: 'remove', payload: null });
  tombstoneLog.applyOperation(remove);
  const protectedResult = tombstoneLog.applyOperation({ operationId: 'protected', projectIdentity: 'tombstone-project', targetEntityId: 'entity', factKind: 'name', action: 'set', payload: 'new' });
  if (protectedResult.status === 'unresolved' && protectedResult.reason === 'tombstone-protects-state') observed.add('tombstone');
  return observed;
}

function secureEnvelope(input = {}) {
  return remote.createRemoteCollaborationEnvelope({
    projectIdentity: 'remote-project', sessionIdentity: 'remote-session', actorIdentity: 'actor', deviceIdentity: 'device',
    messageId: input.messageId || 'message-0', sequence: input.sequence ?? 0,
    operations: [{ targetEntityId: 'entity', factKind: 'name', action: 'set', payload: 'value' }],
    transportProof: { authenticated: true, confidentiality: 'verified', integrity: 'verified', proofIdentity: 'proof' },
    egress: { userAuthorized: true, rawBinaryBytes: input.rawBinaryBytes === true, derivedDataOnly: true },
  });
}

function behaviorRemoteSecurityGate() {
  const gate = new remote.RemoteCollaborationGate({
    projectIdentity: 'remote-project', sessionIdentity: 'remote-session', allowedActors: { actor: ['fact:name', 'action:set'] },
    verifyTransportProof: (proof) => proof.proofIdentity === 'proof',
  });
  const observed = new Set();
  const insecure = remote.createRemoteCollaborationEnvelope({
    projectIdentity: 'remote-project', sessionIdentity: 'remote-session', actorIdentity: 'actor', deviceIdentity: 'device',
    messageId: 'insecure', sequence: 0, operations: [{ targetEntityId: 'entity', factKind: 'name', action: 'set', payload: 'value' }],
  });
  if (gate.validate(insecure).reason === 'remote-transport-security-unverified') observed.add('default-unverified-rejected');
  const secure = secureEnvelope({ messageId: 'secure', sequence: 0 });
  if (gate.validate(secure).ok && gate.accept(secure).status === 'accepted') observed.add('secure-authorized-accepted');
  if (gate.validate(secure).reason === 'remote-replay-or-duplicate') observed.add('replay-rejected');
  const raw = secureEnvelope({ messageId: 'raw', sequence: 1, rawBinaryBytes: true });
  if (gate.validate(raw).reason === 'remote-raw-binary-egress-forbidden') observed.add('raw-egress-rejected');
  return observed;
}

function behaviorRemoteCanonicalTransport() {
  const support = remote.remoteCollaborationSupport();
  const observed = new Set();
  if (support.status === 'unsupported' && support.authority === 'none') observed.add('unsupported-without-profile-proof');
  return observed;
}

const BEHAVIORS = Object.freeze({
  'knowledge-dependency-pinning': behaviorDependencyPinning,
  'knowledge-provider-output': behaviorProviderOutput,
  'knowledge-recognition-outcomes': behaviorRecognitionOutcomes,
  'rules-result-classes': behaviorRulesResultClasses,
  'rules-dependency-order': behaviorRulesDependencyOrder,
  'patterns-value-classes': behaviorPatternsValueClasses,
  'patterns-support-truth': behaviorPatternSupportTruth,
  'remote-operation-classes': behaviorRemoteOperationClasses,
  'remote-security-gate': behaviorRemoteSecurityGate,
  'remote-canonical-transport': behaviorRemoteCanonicalTransport,
});

function checkBehavior(check, failures, id) {
  const behavior = BEHAVIORS[check.id];
  if (!behavior) { failures.push(`${id}:behavior-unregistered:${check.id}`); return; }
  try {
    const observed = sorted([...behavior()]);
    const expected = sorted(check.expected);
    if (!equal(observed, expected)) failures.push(`${id}:behavior-drift:${JSON.stringify({ observed, expected })}`);
  } catch (error) {
    failures.push(`${id}:behavior-error:${error?.message || error}`);
  }
}

function checkUnit(unit, root, failures) {
  const id = unit?.id || '<missing-unit>';
  const check = unit?.check;
  if (!check || typeof check !== 'object' || Array.isArray(check)) { failures.push(`${id}:check-required`); return; }
  if (check.type === 'all') {
    if (!Array.isArray(check.checks) || check.checks.length === 0) failures.push(`${id}:composite-checks-required`);
    else for (const nested of check.checks) checkUnit({ id, check: nested }, root, failures);
  } else if (check.type === 'source-includes') checkSourceIncludes(check, root, failures, id);
  else if (check.type === 'source-collection') checkSourceCollection(check, root, failures, id);
  else if (check.type === 'export-value') checkExportValue(check, failures, id);
  else if (check.type === 'truth-entry') checkTruthEntry(check, failures, id);
  else if (check.type === 'behavior') checkBehavior(check, failures, id);
  else failures.push(`${id}:check-type-unsupported:${check.type}`);
}

function containsBehavior(check) {
  return check?.type === 'behavior' || (check?.type === 'all' && (check.checks || []).some(containsBehavior));
}

export function loadPhase12DenominatorInventory(file = DEFAULT_INVENTORY_PATH) {
  const inventory = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!inventory || inventory.schemaVersion !== PHASE12_DENOMINATOR_SCHEMA) throw new TypeError('phase12-denominator-inventory-schema-invalid');
  return inventory;
}

export function validatePhase12DenominatorInventory(inventory = loadPhase12DenominatorInventory(), { root = ROOT } = {}) {
  const failures = [];
  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)) return { ok: false, reason: 'phase12-denominator-inventory-invalid', failures: ['inventory-object-required'] };
  if (inventory.schemaVersion !== PHASE12_DENOMINATOR_SCHEMA) failures.push('inventory-schema-invalid');
  if (inventory.phase !== 12) failures.push('inventory-phase-invalid');
  if (inventory.baseline?.commit !== 'd6267c43afbec417a471bb058585cc451f7ba089') failures.push('inventory-baseline-commit-invalid');
  if (inventory.baseline?.tree !== 'b4a6fc0c3a8aba7f08a17f4c36061d3ed5179ae7') failures.push('inventory-baseline-tree-invalid');
  if (inventory.promotionPolicy !== 'inventory-records-current-production-truth-and-does-not-promote-support') failures.push('inventory-promotion-policy-invalid');

  const categories = Array.isArray(inventory.categories) ? inventory.categories : [];
  if (!equal(sorted(categories.map((category) => category?.id)), sorted(PHASE12_DENOMINATOR_CATEGORIES))) failures.push('inventory-category-set-invalid');
  const seen = new Set();
  for (const category of categories) {
    const categoryId = category?.id;
    const required = REQUIRED_UNITS[categoryId] || [];
    const units = Array.isArray(category?.units) ? category.units : [];
    if (!equal(sorted(units.map((unit) => unit?.id)), sorted(required))) failures.push(`${categoryId || '<missing-category>'}:unit-set-invalid`);
    for (const unit of units) {
      if (!unit?.id || seen.has(unit.id)) { failures.push(`${unit?.id || '<missing-unit>'}:unit-id-duplicate-or-missing`); continue; }
      seen.add(unit.id);
      const expectedExclusion = REQUIRED_NORMATIVE_EXCLUSIONS.has(unit.id);
      const expectedBlockingGap = REQUIRED_BLOCKING_GAPS.has(unit.id);
      const expectedClassification = expectedBlockingGap
        ? 'BLOCKING_GAP'
        : expectedExclusion ? 'PREEXISTING_NORMATIVE_EXCLUSION' : 'EXACT';
      if (unit.classification !== expectedClassification) failures.push(`${unit.id}:classification-invalid`);
      if (expectedExclusion) {
        if (typeof unit.reason !== 'string' || unit.reason.trim().length < 24) failures.push(`${unit.id}:exclusion-reason-required`);
        if (containsBehavior(unit.check)) failures.push(`${unit.id}:exclusion-cannot-use-behavior-check`);
      }
      if (expectedBlockingGap) {
        if (typeof unit.reason !== 'string' || unit.reason.trim().length < 24) failures.push(`${unit.id}:blocking-gap-reason-required`);
        if (unit.gapKind !== 'PROOF_ABSENCE') failures.push(`${unit.id}:blocking-gap-kind-invalid`);
        if (!Array.isArray(unit.requiredProof) || unit.requiredProof.length === 0) failures.push(`${unit.id}:blocking-gap-proof-requirements-missing`);
      }
      checkUnit(unit, root, failures);
    }
  }
  for (const id of Object.values(REQUIRED_UNITS).flat()) if (!seen.has(id)) failures.push(`${id}:required-unit-missing`);

  const truth = inventory.truth;
  if (!truth || truth.source !== 'js/platform/capability-maturity.js' || truth.function !== 'phase12Maturity') failures.push('inventory-truth-source-invalid');
  else if (!equal(truth.expected, EXPECTED_TRUTH)) failures.push('inventory-truth-expectation-drift');
  else {
    const observedTruth = phase12Maturity();
    for (const [key, expected] of Object.entries(EXPECTED_TRUTH)) {
      if (!equal(observedTruth?.[key], expected)) failures.push(`production-phase12-truth-drift:${key}`);
    }
  }
  const normativeExclusions = categories.flatMap((category) => (category.units || []).filter((unit) => unit.classification === 'PREEXISTING_NORMATIVE_EXCLUSION').map((unit) => unit.id)).sort();
  const blockingGaps = categories.flatMap((category) => (category.units || []).filter((unit) => unit.classification === 'BLOCKING_GAP').map((unit) => unit.id)).sort();
  const remainingGaps = [...normativeExclusions, ...blockingGaps].sort();
  return Object.freeze({
    ok: failures.length === 0,
    reason: failures.length ? 'phase12-denominator-inventory-invalid' : null,
    failures: Object.freeze(failures),
    categoryCount: categories.length,
    unitCount: seen.size,
    exactCount: seen.size - remainingGaps.length,
    exclusionCount: normativeExclusions.length,
    nonExactCount: remainingGaps.length,
    blockingGapCount: blockingGaps.length,
    terminalEligible: failures.length === 0 && blockingGaps.length === 0,
    normativeExclusions: Object.freeze(normativeExclusions),
    blockingGaps: Object.freeze(blockingGaps),
    remainingGaps: Object.freeze(remainingGaps),
    promotion: Object.freeze({ allowed: false, reason: 'inventory-does-not-promote-support' }),
  });
}

export function phase12DenominatorReport(inventory = loadPhase12DenominatorInventory()) {
  const validation = validatePhase12DenominatorInventory(inventory);
  return Object.freeze({
    schemaVersion: PHASE12_DENOMINATOR_REPORT_SCHEMA,
    inventorySchemaVersion: inventory?.schemaVersion || null,
    valid: validation.ok,
    categoryCount: validation.categoryCount,
    unitCount: validation.unitCount,
    exactCount: validation.exactCount,
    exclusionCount: validation.exclusionCount,
    nonExactCount: validation.nonExactCount,
    blockingGapCount: validation.blockingGapCount,
    terminalEligible: validation.terminalEligible,
    normativeExclusions: validation.normativeExclusions,
    blockingGaps: validation.blockingGaps,
    remainingGaps: validation.remainingGaps,
    promotion: validation.promotion,
    failures: validation.failures,
  });
}

export const loadDenominatorInventory = loadPhase12DenominatorInventory;
export const validateDenominatorInventory = validatePhase12DenominatorInventory;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = phase12DenominatorReport(loadPhase12DenominatorInventory(process.argv[2] || DEFAULT_INVENTORY_PATH));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.valid) process.exitCode = 1;
}