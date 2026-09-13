import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { classifySemanticMemoryRegion } from '../../../js/analysis/alias/regions-v2.js';

function fixture() {
  return {
    functionId: 'function_4187',
    origin: { instructionIds: ['fn_4187'] },
    blocks: [{ id: 'entry', nodeIds: ['load_4187'], origin: { instructionIds: ['fn_4187'] } }],
    nodes: [{
      id: 'load_4187',
      kind: 'load',
      blockId: 'entry',
      inputs: ['addr_4187'],
      outputs: ['value_4187'],
      memory: {
        widthBits: 64,
        addressSpace: 'memory',
        addressExpr: { valueId: 'addr_4187' },
      },
      origin: { instructionIds: ['load_4187'] },
    }],
    values: [
      {
        id: 'addr_4187',
        kind: 'entry',
        machineType: { kind: 'address', widthBits: 64, addressSpace: 'memory' },
        origin: { instructionIds: ['addr_4187'] },
      },
      {
        id: 'value_4187',
        kind: 'definition',
        definitionNodeId: 'load_4187',
        machineType: { kind: 'bitvector', widthBits: 64 },
        origin: { instructionIds: ['load_4187'] },
      },
    ],
  };
}

function withoutNodeProcess(callback) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'process');
  assert.ok(descriptor?.configurable, 'test environment must permit a browser-like missing process global');
  delete globalThis.process;
  try {
    return callback();
  } finally {
    Object.defineProperty(globalThis, 'process', descriptor);
  }
}

test('#4187 descriptor fallback is browser-safe when globalThis.process is absent', () => {
  const region = withoutNodeProcess(() => classifySemanticMemoryRegion(fixture(), 'load_4187', {
    binaryId: 'binary_4187',
  }));
  assert.equal(region.kind, 'unknown');
  assert.equal(region.uncertaintyIdentity?.reason, 'missing-region-provenance');
});

test('#4187 explicit region evidence keeps the existing precise path', () => {
  const region = withoutNodeProcess(() => classifySemanticMemoryRegion(fixture(), 'load_4187', {
    binaryId: 'binary_4187',
    regionEvidence: { kind: 'global-absolute', address: '4096' },
  }));
  assert.equal(region.kind, 'global-absolute');
  assert.equal(region.address, '0x1000');
});

test('#4187 production alias module contains no Node-only debug environment dependency', () => {
  const source = fs.readFileSync(new URL('../../../js/analysis/alias/regions-v2.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bprocess\s*\.(?:env|stderr)\b/);
  assert.doesNotMatch(source, /HEX_DEBUG_C2_POINTER/);
});
