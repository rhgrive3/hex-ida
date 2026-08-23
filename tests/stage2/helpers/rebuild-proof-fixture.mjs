import { stableDigest } from '../../../js/core/identity/index.js';
import {
  INDEPENDENT_ORACLE_RESULT_SCHEMA,
  createRebuildTransaction,
  materializeRebuildTransaction,
  publishRebuildTransaction,
  rebuildProfileSupport,
  validateRebuildTransaction,
} from '../../../js/rebuild/transaction-v2.js';

const source = Uint8Array.of(1, 2, 3, 4);
const digest = (bytes) => `bytes:${stableDigest(Array.from(bytes))}`;

export async function validatedRebuildSupportFixture(format, profileProof) {
  const transaction = createRebuildTransaction({
    binaryId: `binary:${format}:capability-test`, sourceHash: digest(source), format,
    architecture: format === 'pe' ? 'x86_64' : 'arm64', loaderVersion: `loader:${format}:capability-test`,
    operations: [{ id: 'grow', offset: 1, before: [2], after: [9, 8], provenance: { source: 'test' } }],
    impact: { layoutMoving: true, relocations: true, branchRanges: true, unwind: true, importsExports: true, signature: true },
    requireIndependentOracle: true,
  });
  const materialized = await materializeRebuildTransaction(transaction, source, { maxOutputBytes: 1024 });
  if (materialized.status !== 'materialized') throw new Error(`fixture materialization failed: ${JSON.stringify(materialized)}`);
  const validators = Object.fromEntries(['layout', 'relocations', 'branch-ranges', 'unwind', 'imports-exports', 'signature-consequence'].map((name) => [name, () => ({ ok: true })]));
  const validation = await validateRebuildTransaction(transaction, materialized, {
    original: source,
    loaderReparse: () => ({ ok: true }),
    independentOracle: ({ output }) => ({
      schemaVersion: INDEPENDENT_ORACLE_RESULT_SCHEMA, ok: true, status: 'passed',
      oracleIdentity: 'external:test-reparser', oracleVersion: '1', oracleSource: 'tests/stage2/helpers/rebuild-proof-fixture.mjs',
      sourceDigest: digest(source), outputDigest: digest(output),
    }),
    validators,
  });
  if (validation.status !== 'valid') throw new Error(`fixture validation failed: ${JSON.stringify(validation)}`);
  const publication = await publishRebuildTransaction(materialized, validation, {
    atomicPromote: async () => ({ atomic: true, committed: true, protocol: 'transactional-store', publicationIdentity: `artifact:${format}:capability-test` }),
  });
  if (publication.status !== 'published') throw new Error(`fixture publication failed: ${JSON.stringify(publication)}`);
  return rebuildProfileSupport({
    transaction, validation, publication,
    proof: { exactHead: true, negativeValidatorTest: true, staleIdentityTest: true, formatSpecificValidatorTests: true, atomicInterruptionTest: true, realFixture: true },
    profileProof, expectedCommitSha: 'a'.repeat(40), expectedTreeSha: 'b'.repeat(40),
  });
}
