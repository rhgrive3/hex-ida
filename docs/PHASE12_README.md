# Knowledge, Collaboration, Pattern, and Rebuild Guide

> **Last Updated:** 2026-11-28  
> **Scope:** `js/phase12/`, `js/knowledge/`, `js/collaboration/`, `js/pattern/`, `js/rebuild/`  
> **Normative Reference:** [`HEX_MASTER_ARCHITECTURE.md`](./HEX_MASTER_ARCHITECTURE.md)

## 1. Unified Facade (`js/phase12/index.js`)

`js/phase12/index.js` exposes the canonical contracts and implementations for knowledge packages, capability rules, deterministic collaboration logs, remote security gates, binary patterns, and format-safe binary rebuilds.

### Shared Foundation (`js/phase12/`)

| Module | Contract / Version | Key Exports |
| :--- | :--- | :--- |
| `js/phase12/identity.js` | Deterministic entity & operation identities | `createProjectIdentity`, `createBinaryIdentity`, `createEntityIdentity`, `createOperationIdentity`, `identityDigest`, `assertIdentityMatch` |
| `js/phase12/resource-budget.js` | `hex-phase12-resource-budget-v1` | `createResourceBudget`, `assertBudgetComplete` |
| `js/phase12/package-envelope.js` | `hex-phase12-package-envelope-v1` (schema `1`, max `32 MiB`), `PHASE12_PROVIDER_OUTPUT_SCHEMA = 'provider-v1'` | `parseBoundedPackageInput`, `packageContentIdentity`, `createPackageEnvelope`, `validatePackageEnvelope`, `importPhase12Package`, `resolvePackageDependencies`, `validateProviderOutput` |
| `js/phase12/provider-boundary.js` | Fail-closed provider output validation | `validatePhase12ProviderResult`, `providerFailure` |

## 2. Knowledge, Recognition & Capability Rules (`js/knowledge/`)

- **Knowledge Store (`js/knowledge/index.js`)**: `KnowledgeDB` (`KNOWLEDGE_SCHEMA_VERSION = 3`, IndexedDB or in-memory Map) stores function fingerprints, names, types, roles, comments, negative rejections, and confirmation levels (`CONFIRMATION_LEVELS`: `user-confirmed`, `debugger-confirmed`, `metadata-confirmed`, `high-confidence-inferred`, `weak-inferred`). Provides `remember`, `reject`, `isRejected`, `findMatches`, `reidentify`, `propagate`, `query`, `page`, `scopedPage` (`scoped-pages.js`), and `scopedIndexedCandidates` (`scoped-index.js`).
- **Recognition (`js/knowledge/phase12-recognition.js`)**: `RECOGNITION_ALGORITHM_VERSION = 'hex-recognition-phase12-v1'`, `MATCH_TIERS = ['exact-content', 'relocation-normalized', 'structural', 'semantic', 'capability']`. Exports `recognizeWithKnowledgeDB`, `recognitionCanClaimUnique`, `configureRecognitionApprovalHost`, `createRecognitionApprovalControl`, `promoteKnowledgeSuggestion`, `importRecognitionPackage`.
- **Capability Rules (`js/knowledge/phase12-rules.js`)**: `CAPABILITY_RULE_LANGUAGE_VERSION = 'hex-capability-rule-language-v1'`, `CAPABILITY_SCOPES = ['instruction', 'basic-block', 'function', 'module', 'runtime']`. Exports `compileCapabilityRule`, `evaluateCapabilityRule`, `compileCapabilityRules`, `evaluateCapabilityRules`, `importCapabilityRulePackage`.

## 3. Collaboration & Remote Security Gate (`js/collaboration/`)

- **Local Deterministic ChangeLog (`js/collaboration/index.js`)**:
  - Schemas: `CHANGELOG_SCHEMA_VERSION = 'hex-project-operation-v1'`, `CHECKPOINT_SCHEMA_VERSION = 'hex-project-checkpoint-v2'`.
  - Operations (`createProjectOperation`) support `set`, `remove`, `resolve`, and `resurrect` actions with immutable canonical payloads (`IMMUTABLE_BYTES_MARKER` etc.) and content-committed `operationId` digests.
  - `ChangeLog` enforces causal parent ordering (`orderOperations`), deterministic ID tie-breaking, explicit meaningful conflicts (`name`, `type`, `struct`, `confirmation`, `patch`), tombstone protection, checkpoint integrity verification (`createCheckpoint` / `restoreCheckpoint`), and bounded pending backlogs (defaults: 512 ops, 128 per actor, 4 MiB; `purgePendingByAuthor()` on actor revocation).
- **Remote Authority & Transport (`remote-authority.js`, `remote-delivery.js`, `remote-transport.js`)**:
  - `RemoteCollaborationGate` / `RemoteCollaborationChannel` (`hex-remote-collaboration-envelope/v1`, `hex-remote-collaboration-gate/v1`, profile `collaboration:remote-security-v1`) enforce authenticated project/binary/actor bindings and fail closed on raw binary byte egress (`containsRawBinaryBytes`) or shared-memory payloads.
  - `applyRemoteEnvelopeQueued` (`remote-delivery.js`) handles queued causal delivery.
  - `RemoteCanonicalHttpTransport` (`remote-transport.js`) provides authenticated encrypted HTTP transport (`oracle:S2-P12-COLLAB-REMOTE:webcrypto-ed25519-aes-gcm-v1`).

## 4. Patterns & Format-Safe Rebuild (`js/pattern/`, `js/rebuild/`)

- **Patterns (`js/pattern/index.js`)**: Read-only bounded pattern compilation and evaluation (`compilePattern`, `evaluatePattern`, `evaluatePatternAsync`).
- **Rebuild (`js/rebuild/index.js`, `transaction-v2.js`, `format-safe.js`)**:
  - `REBUILD_LEVELS = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5']`, `F6_REBUILD_PROFILES = ['macho:64', 'elf:64', 'pe:pe32', 'pe:pe32+']`.
  - `createRebuildPlan`, `adaptPatchSetToRebuildPlan`, `createRebuildTransaction` (`hex-rebuild-transaction-v2`), `createFormatSafeRebuildTransaction` (`hex-format-safe-rebuild/v1`), `validateRebuildTransaction`, and `publishRebuildTransaction` with independent-oracle and atomic-publication provider registration hooks.

## 5. Security & Authority Invariants

- **External Confirmation Is Provenance Only**: External package or collaborator labels (`user-confirmed`, `verified`) never mint local `user-confirmed` or deterministic `verified` state without local approval or verifier proof.
- **Untrusted External Text**: All imported package metadata, rule descriptions, collaborator comments, and ChangeLog payloads are inert data—never instructions or authorization tokens.
- **Validated Provider Boundary**: Provider outputs must pass `validateProviderOutput()` / `validatePhase12ProviderResult()` before persistence or authority promotion.
- **No Raw Binary Upload**: Collaboration channels reject raw analyzed binary bytes (`containsRawBinaryBytes`).
- **Causal Ordering Over Wall Clocks**: Timestamps are provenance hints only; causal parents and deterministic operation IDs govern state convergence.

## 6. Verification Commands

```bash
npm run phase12:test
npm run phase12:verify
npm run platform:test
```
