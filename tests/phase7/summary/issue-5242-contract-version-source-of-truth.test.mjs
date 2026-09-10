import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FUNCTION_SUMMARY_CONTRACT_VERSION,
  createFunctionSummary,
  summaryIdentityMatches,
} from '../../../js/analysis/summary/contract.js';
import * as core from '../../../js/analysis/summary/contract-core.js';

const STATUS = { snapshotId: 'snapshot-a', analyzerId: 'a2-local', analyzerVersion: '1', completeness: 'complete' };
const ROOT_PROVENANCE = {
  kind: 'root', returnIndex: 0, rootEntityId: 'root-1', offset: '0', addressSpace: 'memory',
};

test('#5242 contract version has one source of truth at the public boundary', () => {
  assert.equal(FUNCTION_SUMMARY_CONTRACT_VERSION, core.FUNCTION_SUMMARY_CONTRACT_VERSION);
  assert.equal(FUNCTION_SUMMARY_CONTRACT_VERSION, '1.4.0');
});

test('#5242 the public wrapper stamps the current 1.4 wire version', () => {
  const summary = createFunctionSummary({
    functionId: 'fn-a',
    returnProvenance: [ROOT_PROVENANCE],
    unknownCallEffects: [],
    memoryReadRegions: [],
    memoryWriteRegions: [],
    status: STATUS,
  });
  assert.equal(summary.contractVersion, '1.4.0');
  assert.equal(summaryIdentityMatches(summary), true);
});

test('#5242 a legacy 1.2 root/allocation summary without address-space identity fails current validation', () => {
  const legacy = {
    functionId: 'fn-a',
    returnProvenance: [{ kind: 'root', returnIndex: 0, rootEntityId: 'root-1', offset: '0' }],
    unknownCallEffects: [],
    memoryReadRegions: [],
    memoryWriteRegions: [],
    status: STATUS,
    schemaVersion: core.FUNCTION_SUMMARY_SCHEMA_VERSION,
    contractVersion: '1.2.0',
  };
  // The address-space-less root fact is no longer canonical (#5242).
  assert.equal(summaryIdentityMatches(legacy), false);
});

test('#5242 a 1.2 stamp on a valid 1.3 payload cannot pass identity validation', () => {
  // Version-keyed consumers must be able to distinguish the incompatible
  // envelope even when the payload itself is canonical.
  const summary = createFunctionSummary({
    functionId: 'fn-a',
    returnProvenance: [ROOT_PROVENANCE],
    unknownCallEffects: [],
    memoryReadRegions: [],
    memoryWriteRegions: [],
    status: STATUS,
  });
  assert.equal(summaryIdentityMatches({ ...summary, contractVersion: '1.2.0' }), false);
});
