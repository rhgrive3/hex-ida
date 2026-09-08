import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AnalysisQueryAPI, createAppAnalysisQueryAdapter } from '../../../js/analysis/query/index.js';

const region = Object.freeze({
  id: 'issue-7413-text',
  vmAddr: 0x1000n,
  size: 4n,
  exec: true,
});

function createArm64App() {
  const overlays = [];
  const app = {
    store: {
      get(key) {
        return ({
          architecture: 'arm64',
          canDisassemble: true,
          instructionAlignment: 4,
          currentRegion: region,
          regions: [region],
          sliceIndex: 0,
        })[key] ?? null;
      },
    },
    backend: {
      binaryId: 'issue-7413-arm64',
      gen: 1,
      async fetchChunk(regionId, chunk) {
        assert.equal(regionId, region.id);
        assert.equal(chunk, 0);
        return { mn: ['ret'], ops: [''] };
      },
    },
    symbols: {
      functionCount: 1,
      functionAt(address) {
        return BigInt(address) === region.vmAddr ? { start: region.vmAddr, end: region.vmAddr + 4n } : null;
      },
      nameAt(address) { return BigInt(address) === region.vmAddr ? 'issue_7413_probe' : null; },
      label() { return null; },
    },
    validatedFunctionRange(address) {
      assert.equal(BigInt(address), region.vmAddr);
      return {
        ok: true,
        start: region.vmAddr,
        end: region.vmAddr + 4n,
        region,
        complete: true,
        provenance: 'issue-7413-test-range',
      };
    },
    executableRegionFor(address) {
      const value = BigInt(address);
      return value >= region.vmAddr && value < region.vmAddr + region.size ? region : null;
    },
    viewer: {
      setBlockOverlay(regionId, overlay) { overlays.push({ regionId, overlay }); },
    },
    async analyzeFunctionAt() {
      throw new Error('the routed query path must not call the legacy entry point');
    },
  };
  return { app, overlays };
}

test('#7413 legacy ARM64 query values clone while app-owned block lookup remains available', async () => {
  const { app, overlays } = createArm64App();
  const api = new AnalysisQueryAPI(createAppAnalysisQueryAdapter(app));
  app.analysisQueries = api;

  const result = await app.analyzeFunctionAt(region.vmAddr);
  assert.ok(result?.model, 'the routed legacy ARM64 query must return a model');
  assert.equal(typeof result.model.blockOfRow, 'undefined', 'query values must not publish callbacks');
  assert.equal(Object.prototype.hasOwnProperty.call(result.model, 'blockOfRow'), false);
  assert.equal(Object.isFrozen(result.model), true, 'the public model remains the immutable query projection');
  assert.equal(result.model.instructions.length, 1, 'the real legacy model instruction must survive projection');
  assert.ok(result.model.semantic.length > 0, 'the real legacy semantic block must survive projection');

  const row = result.model.instructions[0].row;
  const expectedBlock = result.model.semantic.find((block) => row >= block.startRow && row <= block.endRow);
  assert.ok(expectedBlock, 'the real legacy model must contain the instruction block');
  assert.equal(app.semantic?.regionId, region.id);
  assert.equal(app.semantic?.model?.blockOfRow?.(row), expectedBlock,
    'presentation consumers must retain block lookup through the app-owned sidecar');
  assert.notEqual(app.semantic.model, result.model, 'the sidecar must stay outside the serialized query value');
  assert.equal(Object.isFrozen(app.semantic.model), true, 'the app-owned presentation sidecar is immutable');
  assert.equal(overlays.length, 1, 'the existing semantic overlay path must remain active');
  assert.equal(overlays[0].regionId, region.id);
});
