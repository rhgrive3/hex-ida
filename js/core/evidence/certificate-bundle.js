/** Lossless multi-certificate transfer/replay using the canonical codec and
 * replay engine. Detached bundles never establish current bytes or semantics. */
import { createWorldScope, createAssumptionSet } from '../identity/world.js';
import { snapshotContractData, recordFields, exactEnum } from '../identity/structured.js';
import { assertScopedAnalysisWork } from '../budgets/scoped-work.js';
import { stableStringify, deepFreeze } from '../identity/index.js';
import { packEvidenceCertificates, unpackEvidenceCertificates, CERTIFICATE_PACK_LIMITS } from './certificate-pack.js';
import { replayEvidenceCertificate } from './certificate.js';
export const CERTIFICATE_BUNDLE_SCHEMA = 'scpa-certificate-bundle/v1';
export const CERTIFICATE_BUNDLE_BYTES = 12 * 1024 * 1024;
export async function processCertificateBundle(operation, input, { work } = {}) {
  assertScopedAnalysisWork(work); work.checkpoint(); exactEnum(operation, ['pack', 'unpack', 'replay'], 'certificate-bundle-operation');
  const raw = snapshotContractData(input, { maxBytes: CERTIFICATE_BUNDLE_BYTES, maxNodes: 120000, maxDepth: 40 });
  recordFields(raw, ['schema', 'world', 'assumptions', 'certificates', 'certificateTransfer'], 'certificate-bundle-fields');
  if (raw.schema !== CERTIFICATE_BUNDLE_SCHEMA) throw new TypeError('certificate-bundle-schema');
  const world = createWorldScope(raw.world), assumptions = createAssumptionSet(raw.assumptions, world);
  const context = { world, assumptions, work };
  work.charge('residentBytes', stableStringify(raw).length * 2);
  if (operation === 'pack') {
    if (raw.certificateTransfer !== undefined || !Array.isArray(raw.certificates) || !raw.certificates.length
      || raw.certificates.length > CERTIFICATE_PACK_LIMITS.certificates) throw new TypeError('certificate-bundle-pack-shape');
    const certificateTransfer = await packEvidenceCertificates(raw.certificates, context);
    return deepFreeze({ schema: CERTIFICATE_BUNDLE_SCHEMA, world, assumptions, certificateTransfer });
  }
  if (raw.certificates !== undefined || !raw.certificateTransfer) throw new TypeError('certificate-bundle-transfer-required');
  const decoded = await unpackEvidenceCertificates(raw.certificateTransfer, context);
  if (operation === 'unpack') return deepFreeze({ schema: CERTIFICATE_BUNDLE_SCHEMA, world, assumptions, certificates: decoded.certificates });
  const reports = [], counts = { declared: decoded.certificates.length, processed: 0, integrityVerified: 0, rejected: 0, notChecked: 0 };
  for (const [index, certificate] of decoded.certificates.entries()) {
    work.checkpoint(); work.charge('workUnits');
    // No user-selected checker/provider, executable hook, or imported authority.
    const result = await replayEvidenceCertificate(certificate, context);
    const rejected = result.integrity === 'rejected' || result.semantic === 'rejected' || result.status === 'rejected';
    counts.processed++; if (rejected) counts.rejected++;
    else if (result.integrity === 'verified') counts.integrityVerified++; else counts.notChecked++;
    reports.push({ index, certificateId: certificate.id, status: result.status, integrity: result.integrity,
      semantic: result.semantic, byteBinding: result.byteBinding ?? 'not-checked', reason: result.reason ?? null,
      sourceNodeCount: certificate.nodes.length, sourceFrontierCount: certificate.frontier.length,
      sourceContradictionCount: certificate.edges.filter(edge => edge.type === 'contradicts').length,
      semanticProof: false });
    await work.yieldIfNeeded();
  }
  work.checkpoint();
  return deepFreeze({ schema: 'scpa-certificate-bundle-replay/v1', status: counts.rejected ? 'rejected' : 'completed',
    counts, reports, statistics: decoded.statistics, sourceBinding: 'detached-unverified', semanticProof: false,
    releaseQualified: false, remaining: ['current-source-bytes-unverified', 'canonical-owner-and-semantic-checkers-unbound',
      'open-frontiers-and-contradictions-retained; no-denominator-shrinkage'] });
}
