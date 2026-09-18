import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GNU_PROPERTY_AARCH64_FEATURE_1_AND,
  GNU_PROPERTY_AARCH64_FEATURE_1_BTI,
  GNU_PROPERTY_AARCH64_FEATURE_1_GCS,
  GNU_PROPERTY_AARCH64_FEATURE_1_PAC,
  NT_GNU_PROPERTY_TYPE_0,
  PT_GNU_PROPERTY,
  parseAarch64GnuProperty,
} from '../../js/binary/elf-gnu-property.js';
import { parseELF } from '../../js/binary/elf-loader.js';
import { ARM64_ARCHITECTURE, ARM64E_ARCHITECTURE } from '../../js/targets/architecture/index.js';
import { buildSemanticV2CompatibilityPipeline } from '../../js/semantics/compat/index.js';

const ELF_SIZE = 0x300;
const PHOFF = 0x40;
const PHENTSIZE = 56;
const PROPERTY_OFFSET = 0x100;

function makeElf(featureBits, { propertyType = GNU_PROPERTY_AARCH64_FEATURE_1_AND, filesz = 32 } = {}) {
  const bytes = new Uint8Array(ELF_SIZE);
  const view = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  view.setUint16(16, 2, true);
  view.setUint16(18, 183, true); // EM_AARCH64
  view.setUint32(20, 1, true);
  view.setBigUint64(32, BigInt(PHOFF), true);
  view.setUint16(52, 64, true);
  view.setUint16(54, PHENTSIZE, true);
  view.setUint16(56, 1, true);
  view.setUint32(PHOFF, PT_GNU_PROPERTY, true);
  view.setBigUint64(PHOFF + 8, BigInt(PROPERTY_OFFSET), true);
  view.setBigUint64(PHOFF + 32, BigInt(filesz), true);
  view.setBigUint64(PHOFF + 48, 8n, true);

  view.setUint32(PROPERTY_OFFSET, 4, true);
  view.setUint32(PROPERTY_OFFSET + 4, 16, true);
  view.setUint32(PROPERTY_OFFSET + 8, NT_GNU_PROPERTY_TYPE_0, true);
  bytes.set([0x47, 0x4e, 0x55, 0x00], PROPERTY_OFFSET + 12);
  view.setUint32(PROPERTY_OFFSET + 16, propertyType, true);
  view.setUint32(PROPERTY_OFFSET + 20, 4, true);
  view.setUint32(PROPERTY_OFFSET + 24, featureBits, true);
  return bytes;
}

test('#8617 Acceptance Criterion 1: parseELF publishes security feature evidence with arch=arm64', () => {
  const elfBytes = makeElf(
    GNU_PROPERTY_AARCH64_FEATURE_1_BTI
      | GNU_PROPERTY_AARCH64_FEATURE_1_PAC
      | GNU_PROPERTY_AARCH64_FEATURE_1_GCS,
  );
  const image = parseELF(elfBytes);
  assert.equal(image.arch, 'arm64', 'Architecture must remain arm64 (not darwin arm64e)');
  assert.ok(image.metadata.arm64GnuProperty, 'arm64GnuProperty metadata must be present');
  assert.ok(image.metadata.aarch64SecurityFeatures, 'aarch64SecurityFeatures metadata must be present');
  assert.equal(image.metadata.aarch64SecurityFeatures.pacRequested, true);
  assert.equal(image.metadata.aarch64SecurityFeatures.gcsRequested, true);
  assert.equal(image.metadata.aarch64SecurityFeatures.btiRequested, true);
  assert.equal(image.metadata.arm64Bti.pacRequested, true);
});

test('#8617 Acceptance Criterion 2 & 3: PACIASP and RETAA retain PAuth effects under ARM64_ARCHITECTURE when PAC is enabled', () => {
  const paciaspWord = 0xd503233f; // paciasp
  const paciaspDecoded = {
    instructionId: 'test:paciasp:1',
    address: 0x1000n,
    mnemonic: 'paciasp',
    opStr: '',
    ops: [],
    word: paciaspWord,
    mode: 'a64',
  };

  // PAC enabled via pacEnabled: true
  const bundlePac = ARM64_ARCHITECTURE.liftExact(paciaspDecoded, {
    pacEnabled: true,
    instructionId: 'test:paciasp:1',
    mode: 'a64',
  });
  assert.ok(bundlePac, 'bundle must not be null');
  assert.equal(bundlePac.architectureId, 'arm64', 'architectureId must remain arm64');
  assert.ok(bundlePac.operations.some((op) => op.kind === 'intrinsic' && op.intrinsicId === 'arm64e.pointer.sign'),
    'PACIASP must contain pointer.sign intrinsic');
  assert.equal(bundlePac.metadata.pauthFeatureExtension, true);

  // RETAA with PAC enabled
  const retaaDecoded = {
    instructionId: 'test:retaa:1',
    address: 0x1004n,
    mnemonic: 'retaa',
    opStr: '',
    ops: [],
    mode: 'a64',
  };
  const bundleRet = ARM64_ARCHITECTURE.liftExact(retaaDecoded, {
    pacEnabled: true,
    instructionId: 'test:retaa:1',
    mode: 'a64',
  });
  assert.ok(bundleRet, 'RETAA bundle must not be null');
  assert.equal(bundleRet.architectureId, 'arm64', 'RETAA architectureId must remain arm64');
  assert.equal(bundleRet.controlEffect.kind, 'return', 'RETAA must retain return control effect');
  assert.ok(bundleRet.operations.some((op) => op.kind === 'intrinsic' && op.intrinsicId === 'arm64e.pointer.authenticate'),
    'RETAA must contain pointer.authenticate intrinsic');
});

test('#8617 Acceptance Criterion 4: GCS runtime enabled BL has GCS push state effects', () => {
  const blDecoded = {
    instructionId: 'test:bl:1',
    address: 0x2000n,
    mnemonic: 'bl',
    opStr: '#0x2100',
    ops: [{ k: 'imm', value: 0x2100n, bits: 64 }],
    callTarget: 0x2100n,
    word: 0x94000040, // bl #0x100
    mode: 'a64',
  };

  const bundle = ARM64_ARCHITECTURE.liftExact(blDecoded, {
    instructionId: 'test:bl:1',
    mode: 'a64',
    gcsEnabled: true,
  });
  assert.ok(bundle);
  assert.equal(bundle.metadata.gcs, true);
  assert.equal(bundle.metadata.gcsEffect, 'push');

  // Verify sys:gcspr_el0 decrement by 8
  const gcsprRead = bundle.operations.find((op) => op.kind === 'register-read' && op.register?.registerId === 'sys:gcspr_el0');
  assert.ok(gcsprRead, 'BL must read sys:gcspr_el0');
  const gcsprSub = bundle.operations.find((op) => op.kind === 'value' && op.opcode === 'sub');
  assert.ok(gcsprSub, 'BL must decrement gcspr_el0');
  const gcsprWrite = bundle.operations.find((op) => op.kind === 'register-write' && op.register?.registerId === 'sys:gcspr_el0');
  assert.ok(gcsprWrite, 'BL must write back sys:gcspr_el0');

  // Verify memory write of return address (PC + 4)
  const memWrite = bundle.operations.find((op) => op.kind === 'memory-write');
  assert.ok(memWrite, 'BL must write return address to GCS shadow stack');
  assert.equal(BigInt(memWrite.value.value), 0x2004n, 'Pushed return address must be PC + 4');

  // Verify GCS data abort fault
  assert.ok(bundle.possibleFaults.some((f) => f.detail?.gcs === true && f.detail?.stage === 'push'));
});

test('#8617 Acceptance Criterion 5: GCS runtime enabled RET has GCS pop/check dependency and mismatch fault', () => {
  const retDecoded = {
    instructionId: 'test:ret:1',
    address: 0x2040n,
    mnemonic: 'ret',
    opStr: '',
    ops: [],
    mode: 'a64',
  };

  const bundle = ARM64_ARCHITECTURE.liftExact(retDecoded, {
    instructionId: 'test:ret:1',
    mode: 'a64',
    gcsEnabled: true,
  });
  assert.ok(bundle);
  assert.equal(bundle.metadata.gcs, true);
  assert.equal(bundle.metadata.gcsEffect, 'pop-check');

  // Verify sys:gcspr_el0 read and pop memory-read
  const gcsprRead = bundle.operations.find((op) => op.kind === 'register-read' && op.register?.registerId === 'sys:gcspr_el0');
  assert.ok(gcsprRead, 'RET must read sys:gcspr_el0');
  const memRead = bundle.operations.find((op) => op.kind === 'memory-read');
  assert.ok(memRead, 'RET must read return address from GCS shadow stack');

  // Verify sys:gcspr_el0 increment by 8
  const gcsprAdd = bundle.operations.find((op) => op.kind === 'value' && op.opcode === 'add');
  assert.ok(gcsprAdd, 'RET must increment gcspr_el0');

  // Verify mismatch fault
  const mismatchFault = bundle.possibleFaults.find((f) => f.kind === 'gcs-mismatch-fault');
  assert.ok(mismatchFault, 'RET must have gcs-mismatch-fault');
  assert.equal(mismatchFault.condition?.kind, 'not-equal');
});

test('#8617 Acceptance Criterion 6: GCS requested but runtime state unknown fails closed to partial', () => {
  const blDecoded = {
    instructionId: 'test:bl:2',
    address: 0x3000n,
    mnemonic: 'bl',
    opStr: '#0x3100',
    ops: [{ k: 'imm', value: 0x3100n, bits: 64 }],
    callTarget: 0x3100n,
    word: 0x94000040,
    mode: 'a64',
  };

  const bundle = ARM64_ARCHITECTURE.liftExact(blDecoded, {
    instructionId: 'test:bl:2',
    mode: 'a64',
    gcsRequested: true,
    gcsEnabled: null, // unresolved
  });
  assert.ok(bundle);
  assert.equal(bundle.completeness, 'partial', 'Unresolved GCS state must fail closed to partial');
  assert.equal(bundle.unknownEffects?.reason, 'arm64-gcs-runtime-state-unresolved');
  assert.equal(bundle.metadata.gcsCheck, 'runtime-state-unresolved');
});

test('#8617 Acceptance Criterion 7: PAC unknown fails closed; absent PAC treats HINT as NOP', () => {
  const paciaspDecoded = {
    instructionId: 'test:paciasp:unknown',
    address: 0x4000n,
    mnemonic: 'paciasp',
    opStr: '',
    ops: [],
    mode: 'a64',
  };

  // Unknown PAC runtime state
  const bundleUnknown = ARM64_ARCHITECTURE.liftExact(paciaspDecoded, {
    instructionId: 'test:paciasp:unknown',
    mode: 'a64',
    pacRequested: null,
    pacEnabled: null,
  });
  assert.ok(bundleUnknown);
  assert.equal(bundleUnknown.completeness, 'partial', 'Unknown PAC must fail closed to partial');
  assert.equal(bundleUnknown.unknownEffects?.reason, 'arm64-pac-runtime-state-unresolved');

  // Proven absent PAC: PACIASP is HINT, architecturally NOP
  const bundleAbsent = ARM64_ARCHITECTURE.liftExact(paciaspDecoded, {
    instructionId: 'test:paciasp:absent',
    mode: 'a64',
    pacRequested: false,
    pacEnabled: false,
  });
  assert.ok(bundleAbsent);
  assert.equal(bundleAbsent.completeness, 'exact');
  assert.equal(bundleAbsent.statePreservation?.proven, true);
  assert.equal(bundleAbsent.metadata.pacFeature, 'absent');
});

test('#8617 Acceptance Criterion 10: End-to-end regression through buildSemanticV2CompatibilityPipeline', () => {
  const elfBytes = makeElf(
    GNU_PROPERTY_AARCH64_FEATURE_1_PAC | GNU_PROPERTY_AARCH64_FEATURE_1_GCS,
  );
  const image = parseELF(elfBytes);

  const pipelineResult = buildSemanticV2CompatibilityPipeline({
    architecturePlugin: ARM64_ARCHITECTURE,
    decoderSemanticVersion: 'test-v2',
    binaryId: 'elf_pac_gcs_test',
    sliceId: 'slice_test',
    addressWidthBits: 64,
    entryBlockKey: 'entry',
    machineEffectsContext: {
      pacEnabled: true,
      gcsEnabled: true,
      image,
    },
    blocks: [
      {
        key: 'entry',
        startAddress: 0x1000n,
        instructions: [
          {
            decoded: {
              address: 0x1000n,
              mnemonic: 'paciasp',
              opStr: '',
              ops: [],
              mode: 'a64',
            },
          },
          {
            decoded: {
              address: 0x1004n,
              mnemonic: 'ret',
              opStr: '',
              ops: [],
              mode: 'a64',
            },
          },
        ],
        successors: [],
      },
    ],
  });

  assert.ok(pipelineResult, 'pipeline result must be generated');
  assert.equal(pipelineResult.semanticSchemaVersion, 2);
});
