/** Post-B case/toolchain denominator, reusing the competitive protocol/matrix.
 * This is metadata admission, not source/binary or competition qualification.
 */
import { snapshotContractData, recordFields, exactString, exactInteger, sha256Text, contractFail } from '../../core/identity/structured.js';
import { deepFreeze, stableDigest } from '../../core/identity/index.js';
import { createCompetitiveProtocol, normalizeCompetitiveMeasurement, PARTICIPANTS, REQUIRED_METRICS } from './competitive-protocol.js';
import { createCompetitiveMetricMatrix } from './competitive-matrix.js';
const LANGUAGES = ['c', 'cpp', 'objc', 'swift', 'rust', 'go'];
const MANIFESTS = new WeakSet();
const relative = value => typeof value === 'string' && /^[a-zA-Z0-9_.\/-]+$/.test(value)
  && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..');
export function normalizePostBManifest(raw) {
  const value = snapshotContractData(raw, { maxBytes: 262144, maxNodes: 8192 });
  recordFields(value, ['schema', 'version', 'campaign', 'sourceBaseline', 'cases', 'recipes', 'toolchainSlots', 'metrics', 'adapterContract', 'policies'], 'post-b-manifest-fields');
  if (value.schema !== 'scpa-post-b-manifest/v1' || value.version !== '1.0.0' || !/^[a-f0-9]{40}$/.test(value.sourceBaseline)) contractFail('post-b-manifest-version');
  exactString(value.campaign, 'post-b-campaign');
  if (!Array.isArray(value.recipes) || value.recipes.length !== 6 || !Array.isArray(value.cases) || value.cases.length !== 12
    || !Array.isArray(value.toolchainSlots) || value.toolchainSlots.length !== 2 || !Array.isArray(value.metrics)
    || value.metrics.length !== REQUIRED_METRICS.length) contractFail('post-b-full-denominator-required');
  const recipes = new Map(), languages = new Set(), cases = new Set(), slots = new Set(), metrics = new Set();
  for (const row of value.recipes) {
    recordFields(row, ['id', 'language', 'source', 'sourceSha256', 'compiler', 'argv', 'targetTriple', 'platform', 'requirements', 'outputRole'], 'post-b-recipe-fields');
    exactString(row.id, 'post-b-recipe-id');
    if (recipes.has(row.id) || languages.has(row.language) || !LANGUAGES.includes(row.language) || !relative(row.source)
      || !Array.isArray(row.argv) || row.argv.length > 32 || !['linux', 'darwin'].includes(row.platform)) contractFail('post-b-recipe');
    for (const arg of row.argv) exactString(arg, 'post-b-compiler-argument', 2048);
    for (const key of ['compiler', 'targetTriple', 'outputRole']) exactString(row[key], `post-b-recipe-${key}`);
    if (!row.argv.includes('{source}') || !row.argv.includes('{output}') || !Array.isArray(row.requirements) || row.requirements.length > 32) contractFail('post-b-recipe-output');
    row.requirements.forEach(reason => exactString(reason, 'post-b-build-requirement'));
    sha256Text(row.sourceSha256); recipes.set(row.id, row); languages.add(row.language);
  }
  for (const row of value.cases) {
    recordFields(row, ['id', 'recipeId', 'symbol', 'stratum', 'oracleId', 'closureObligations'], 'post-b-case-fields');
    for (const key of ['id', 'recipeId', 'symbol', 'stratum', 'oracleId']) exactString(row[key], `post-b-case-${key}`);
    if (row.id.includes('@') || cases.has(row.id) || !recipes.has(row.recipeId) || !Array.isArray(row.closureObligations) || row.closureObligations.length > 32) contractFail('post-b-case-denominator');
    row.closureObligations.forEach(reason => exactString(reason, 'post-b-closure-obligation')); cases.add(row.id);
  }
  for (const row of value.toolchainSlots) {
    recordFields(row, ['id', 'versions'], 'post-b-toolchain-slot-fields');
    exactString(row.id, 'post-b-toolchain-slot'); exactString(row.versions, 'post-b-toolchain-versions');
    if (row.id.includes('@') || slots.has(row.id)) contractFail('post-b-toolchain-slot-duplicate'); slots.add(row.id);
  }
  for (const row of value.metrics) {
    recordFields(row, ['id', 'unit', 'direction', 'cacheStates', 'definition'], 'post-b-metric-fields');
    if (!REQUIRED_METRICS.includes(row.id) || metrics.has(row.id) || !['higher-better', 'lower-better', 'descriptive-only'].includes(row.direction)
      || !Array.isArray(row.cacheStates) || !row.cacheStates.length || row.cacheStates.length > 2
      || row.cacheStates.some(state => !['cold', 'warm', 'not-applicable'].includes(state))
      || new Set(row.cacheStates).size !== row.cacheStates.length
      || row.cacheStates.includes('not-applicable') && row.cacheStates.length !== 1) contractFail('post-b-metric-definition');
    exactString(row.unit, 'post-b-metric-unit'); exactString(row.definition, 'post-b-metric-definition', 4096); metrics.add(row.id);
  }
  const contract = value.adapterContract;
  recordFields(contract, ['schema', 'participants', 'methods', 'maximumRequestBytes', 'maximumResponseBytes', 'timeoutMs', 'available', 'groundTruth'], 'post-b-adapter-fields');
  if (contract.schema !== 'scpa-native-best-adapter/v1' || !Array.isArray(contract.participants)
    || [...contract.participants].sort().join('|') !== [...PARTICIPANTS].sort().join('|')
    || !Array.isArray(contract.methods) || [...contract.methods].sort().join('|') !== ['cancel', 'capabilities', 'explain', 'query'].join('|')) contractFail('post-b-adapter-contract');
  exactInteger(contract.timeoutMs, 'post-b-adapter-deadline', { min: 1, max: 120000 });
  exactInteger(contract.maximumRequestBytes, 'post-b-adapter-request', { min: 1, max: 65536 });
  exactInteger(contract.maximumResponseBytes, 'post-b-adapter-response', { min: 1, max: 4194304 });
  exactString(contract.available, 'post-b-adapter-availability'); exactString(contract.groundTruth, 'post-b-oracle-policy');
  recordFields(value.policies, ['denominator', 'twins', 'cold', 'warm', 'sameAstra', 'victory'], 'post-b-policies');
  Object.values(value.policies).forEach(policy => exactString(policy, 'post-b-policy', 4096));
  const result = deepFreeze({ ...value, id: stableDigest(value), qualification: 'declaration-only' }); MANIFESTS.add(result); return result;
}
export function postBCells(manifest, repetitions = 1) {
  if (!MANIFESTS.has(manifest)) contractFail('post-b-owned-manifest');
  exactInteger(repetitions, 'post-b-repetitions', { min: 1, max: 10 });
  const cells = [];
  for (const sample of manifest.cases) for (const slot of manifest.toolchainSlots) for (const participantId of PARTICIPANTS)
    for (const metric of manifest.metrics) for (const cacheState of metric.cacheStates) for (let repetition = 0; repetition < repetitions; repetition++)
      cells.push({ caseId: `${sample.id}@${slot.id}`, microcaseId: sample.id, toolchainSlot: slot.id, participantId, metric: metric.id,
        cacheState, repetition, unit: metric.unit, state: 'UNMEASURED', value: null, reason: 'no-bound-execution-and-independent-oracle-receipts' });
  return deepFreeze(cells);
}
/** Pinned binaries/tool/model/settings must come from real bindings. Missing
 * data is rejected rather than replaced with dummy hashes or version strings.
 */
export function bindPostBProtocol(manifest, input, { manifestSha256, metricSha256 }) {
  if (!MANIFESTS.has(manifest)) contractFail('post-b-owned-manifest');
  sha256Text(manifestSha256);
  const data = snapshotContractData(input, { maxBytes: 1048576, maxNodes: 32768 });
  const expected = manifest.cases.flatMap(sample => manifest.toolchainSlots.map(slot => `${sample.id}@${slot.id}`));
  if (!Array.isArray(data.cases) || data.cases.length !== expected.length || new Set(data.cases.map(row => row.caseId)).size !== expected.length
    || data.cases.some(row => !expected.includes(row.caseId))) contractFail('post-b-bound-cases-incomplete');
  for (const row of data.cases) {
    const sample = manifest.cases.find(item => row.caseId.startsWith(item.id + '@')), recipe = manifest.recipes.find(item => item.id === sample.recipeId);
    if (row.sourceSha256 !== recipe.sourceSha256 || row.language !== recipe.language || row.platform !== (recipe.platform === 'darwin' ? 'apple-macos' : recipe.platform)) contractFail('post-b-bound-source-mismatch');
  }
  const protocol = createCompetitiveProtocol({ ...data, campaign: manifest.campaign, baselineCommit: manifest.sourceBaseline,
    denominatorSha256: manifestSha256, metrics: manifest.metrics.map(row => row.id) });
  const matrix = createCompetitiveMetricMatrix(protocol, { protocolId: protocol.id, definitionSha256: manifestSha256,
    caseStrata: protocol.cases.map(row => ({ caseId: row.caseId, stratumId: manifest.cases.find(sample => row.caseId.startsWith(sample.id + '@')).stratum })),
    metrics: manifest.metrics.map(({ definition: _definition, ...row }) => ({ ...row, definitionSha256: sha256Text(metricSha256[row.id]) })) });
  const cells = postBCells(manifest, protocol.repetitions).map(cell => normalizeCompetitiveMeasurement(protocol, {
    protocolId: protocol.id, caseId: cell.caseId, participantId: cell.participantId, metric: cell.metric, repetition: cell.repetition,
    state: cell.state, cacheState: cell.cacheState, binarySha256: protocol.cases.find(row => row.caseId === cell.caseId).binarySha256,
    value: null, unit: cell.unit, recall: null, unknownRate: null, exactErrors: null, oracleReceiptId: null,
    executionReceiptId: null, correctnessReceiptId: null, sampleTraceSha256: null, reason: cell.reason }));
  return { protocol, matrix, cells, admission: 'independent-existing-protocol-admission-still-required', victoryEstablished: false };
}
