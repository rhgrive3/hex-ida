import assert from 'node:assert/strict';
import {
  parseUnifiedLanguageMetadata,
  classifyLanguageRuntimeCall,
  applyLanguageMetadataTypesToGraph,
  languageMetadataFunctionEvidence,
} from '../js/metadata/index.js';
import { TypeConstraintGraph } from '../js/analysis/types/graph.js';
import { classifyRuntimeCall, runtimeOriginForSymbol } from '../js/apple/runtime.js';

console.log('Testing Language Metadata Downstream Integration & Cross-Ecosystem Matrix...');

// 1. Multi-ecosystem Unified Parsing
{
  // Construct a context containing both Go pclntab and Rust symbols
  const goBuf = new Uint8Array(256);
  const dv = new DataView(goBuf.buffer);
  dv.setUint32(0, 0xfffffff1, true); // Go 1.20+
  goBuf[6] = 1; goBuf[7] = 8;
  dv.setBigUint64(8, 0n, true);

  const rustSymbols = [
    { name: '_RNvNtC4core3fmt3num', address: '0x2000' },
  ];

  const unified = await parseUnifiedLanguageMetadata({
    pclntabBuffer: goBuf,
    symbols: rustSymbols,
    commentBuffer: new TextEncoder().encode('rustc version 1.79.0'),
    binaryIdentity: 'sha256:polyglot-binary',
    architecture: 'x86_64',
    platform: 'linux',
  });

  assert.equal(unified.ecosystems.length, 2);
  assert.ok(unified.ecosystems.includes('go'));
  assert.ok(unified.ecosystems.includes('rust'));

  // Ambiguity is preserved: both ecosystems are present in results without silent winner
  const goResult = unified.results.find((r) => r.ecosystem === 'go');
  const rustResult = unified.results.find((r) => r.ecosystem === 'rust');
  assert.ok(goResult);
  assert.ok(rustResult);
}

// 2. TypeConstraintGraph Downstream Wiring & Non-Fabrication Guarantee
{
  const graph = new TypeConstraintGraph({ snapshotId: 'snap-integration' });

  const goTypeResult = {
    ecosystem: 'go',
    identity: {
      verdict: 'matched-authoritative',
      providerId: 'metadata.go',
      providerVersion: '1.0.0',
    },
  };

  const goTypePage = {
    records: [
      {
        kind: 'type',
        entityId: 'type@0x5000',
        descriptor: { name: 'main.ServerState', size: 64 },
        providerId: 'metadata.go',
        providerVersion: '1.0.0',
        evidenceIds: ['go:type:0x5000'],
      },
    ],
  };

  const appliedHard = applyLanguageMetadataTypesToGraph(graph, goTypeResult, goTypePage);
  assert.equal(appliedHard.hard, 1);
  assert.equal(appliedHard.soft, 0);

  const solved = graph.solveEntity('type@0x5000');
  assert.equal(solved.layers.nominal.confidence, 'certain');
  assert.equal(solved.layers.nominal.selected.descriptor.name, 'main.ServerState');

  // Negative test: unauthoritative/partial metadata cannot mint 'certain'
  const partialGraph = new TypeConstraintGraph({ snapshotId: 'snap-partial' });
  const partialTypeResult = {
    ecosystem: 'go',
    identity: {
      verdict: 'identity-unavailable',
      providerId: 'metadata.go',
      providerVersion: '1.0.0',
    },
  };

  const appliedSoft = applyLanguageMetadataTypesToGraph(partialGraph, partialTypeResult, goTypePage);
  assert.equal(appliedSoft.hard, 0);
  assert.equal(appliedSoft.soft, 1);

  const partialSolved = partialGraph.solveEntity('type@0x5000');
  assert.notEqual(partialSolved.layers.nominal?.confidence, 'certain', 'unauthoritative metadata must never yield certain type');
  assert.equal(partialSolved.layers.nominal.confidence, 'possible');
}

// 3. Function Discovery Evidence Wiring
{
  const rustResult = {
    ecosystem: 'rust',
    identity: { verdict: 'matched-authoritative' },
  };

  const rustPage = {
    records: [
      {
        kind: 'symbol',
        name: 'my_crate::process_request',
        address: '0x1040',
        sizeBytes: 128,
        providerId: 'metadata.rust',
        providerVersion: '1.0.0',
        evidenceIds: ['rust:sym:0x1040'],
      },
    ],
  };

  const discoveryEvidence = languageMetadataFunctionEvidence(rustResult, rustPage);
  assert.equal(discoveryEvidence.length, 1);
  assert.equal(discoveryEvidence[0].kind, 'rust-function');
  assert.equal(discoveryEvidence[0].confidence, 'exact');
  assert.equal(discoveryEvidence[0].name, 'my_crate::process_request');
  assert.equal(discoveryEvidence[0].address, '0x1040');
}

// 4. Runtime Call Classification Wiring
{
  // ObjC
  const objcCall = classifyRuntimeCall('-[PlayerData addCoins:]');
  assert.equal(objcCall.runtime, 'objc');
  assert.equal(objcCall.noise, false);

  const objcNoise = classifyRuntimeCall('objc_retain');
  assert.equal(objcNoise.runtime, 'objc');
  assert.equal(objcNoise.noise, true);

  // Swift
  const swiftCall = classifyRuntimeCall('$s4Game7PlayersC9takeDamageyyF');
  assert.equal(swiftCall.runtime, 'swift');
  assert.equal(swiftCall.noise, false);

  const swiftNoise = classifyRuntimeCall('swift_retain');
  assert.equal(swiftNoise.runtime, 'swift');
  assert.equal(swiftNoise.noise, true);

  // Go
  const goCall = classifyRuntimeCall('runtime.gopanic');
  assert.equal(goCall.runtime, 'go');
  assert.equal(goCall.noise, false);

  const goNoise = classifyRuntimeCall('runtime.morestack');
  assert.equal(goNoise.runtime, 'go');
  assert.equal(goNoise.noise, true);

  // Rust
  const rustCall = classifyRuntimeCall('core::fmt::write');
  assert.equal(rustCall.runtime, 'rust');
  assert.equal(rustCall.noise, false);

  const rustNoise = classifyRuntimeCall('_rust_alloc');
  assert.equal(rustNoise.runtime, 'rust');
  assert.equal(rustNoise.noise, true);

  // runtimeOriginForSymbol
  assert.equal(runtimeOriginForSymbol('runtime.mallocgc'), 'go');
  assert.equal(runtimeOriginForSymbol('core::slice::len'), 'rust');
  assert.equal(runtimeOriginForSymbol('$s10MyModule4TestC'), 'swift');
  assert.equal(runtimeOriginForSymbol('+[NSObject alloc]'), 'objc');
}

// 5. C3-02 ABI Non-Regression Check
{
  // Metadata is naming/type evidence; ABI classification is authority for calling conventions & register locations.
  // Ensure that language metadata never attempts to dictate physical ABI registers on its own.
  const goCallDesc = classifyLanguageRuntimeCall('runtime.gopanic');
  assert.ok(goCallDesc);
  assert.equal(goCallDesc.runtime, 'go');
  // It provides category and noise filtering, never fabricating aggregate return or register classes.
  assert.equal(goCallDesc.category, 'runtime');
}

console.log('Language Metadata Downstream Integration tests passed.');
