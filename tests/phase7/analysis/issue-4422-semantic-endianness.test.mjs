import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeDecodedSemanticFunction,
  analyzeSemanticFunction,
} from '../../../js/analysis/semantic-function.js';
import { parseOperands } from '../../../js/arm64.js';
import { createRiscv64DecodedInstruction } from '../../../js/targets/architecture/riscv64/decoded-instruction.js';
import { createX86DecodedInstruction } from '../../../js/targets/architecture/x86_64/decoded-instruction.js';

const APIs = Object.freeze([
  ['decoded', analyzeDecodedSemanticFunction],
  ['semantic', analyzeSemanticFunction],
]);

function riscvInstruction() {
  return createRiscv64DecodedInstruction({
    address:0x1000n,
    size:4,
    rawBytes:Uint8Array.from([0x83, 0x35, 0x05, 0x00]), // ld a1, 0(a0)
    mode:'rv64imc',
    instructionId:'issue-4422-load',
    origin:{ instructionIds:['issue-4422-load'] },
    decoderSemanticVersion:'issue-4422-riscv-decoder-v1',
  });
}

function baseInput() {
  return {
    architecture:'riscv64',
    platform:'linux',
    abiId:'lp64',
    mode:'rv64imc',
    decoderSemanticVersion:'issue-4422-riscv-decoder-v1',
    binaryId:'issue-4422-binary',
    sliceId:'issue-4422-slice',
    instructions:[riscvInstruction()],
  };
}

function memoryEndian(result) {
  return result.pipeline.machineEffects
    .flatMap((bundle) => bundle.operations || [])
    .find((operation) => operation.kind === 'memory-read' || operation.kind === 'memory-write')
    ?.access?.endian;
}

function arm64Input() {
  return {
    architecture:'arm64',
    platform:'linux',
    abiId:'aapcs64',
    decoderSemanticVersion:'issue-4422-arm64-decoder-v1',
    binaryId:'issue-4422-arm64-binary',
    sliceId:'issue-4422-arm64-slice',
    instructions:[{
      address:0x2000n,
      size:4,
      length:4,
      mode:'a64',
      mnemonic:'ret',
      opStr:'',
      ops:parseOperands(''),
      instructionId:'issue-4422-arm64-ret',
      origin:{ instructionIds:['issue-4422-arm64-ret'] },
    }],
  };
}

function x86Input() {
  return {
    architecture:'x86_64',
    platform:'linux',
    abiId:'sysv-amd64',
    decoderSemanticVersion:'issue-4422-x86-decoder-v1',
    binaryId:'issue-4422-x86-binary',
    sliceId:'issue-4422-x86-slice',
    instructions:[createX86DecodedInstruction({
      address:0x3000n,
      length:1,
      rawBytes:Uint8Array.from([0xc3]),
      mode:'long-64',
      instructionId:'issue-4422-x86-ret',
      instructionCode:2,
      instructionFamily:'ret',
      detailAvailable:true,
      detailStatus:'complete',
      detail:{ operandCount:0, operands:[] },
      mnemonic:'ret',
    })],
  };
}

test('#4422 both semantic entrypoints reject unsupported RV64 memory endianness', () => {
  for (const [name, analyze] of APIs) {
    assert.throws(
      () => analyze({ ...baseInput(), memoryEndianness:'big' }),
      { name:'TypeError', message:'semantic-function-unsupported-memory-endianness:big' },
      name,
    );
  }
});
test('#4422 canonicalizes every memory-endianness alias and preserves precedence', () => {
  const aliases = [
    { memoryEndianness:'little' },
    { dataEndianness:'little' },
    { endianness:'little' },
    { endian:'little' },
  ];
  for (const [name, analyze] of APIs) {
    for (const selector of aliases) {
      const result = analyze({ ...baseInput(), ...selector });
      assert.equal(result.analysisContext.dataEndianness, 'little', `${name}: ${JSON.stringify(selector)}`);
      assert.equal(memoryEndian(result), 'little', `${name}: effect ${JSON.stringify(selector)}`);
    }

    const specificWins = analyze({
      ...baseInput(),
      dataEndianness:'little',
      memoryEndianness:'big',
      instructionEndianness:'little',
      endianness:'big',
      endian:'big',
    });
    assert.equal(specificWins.analysisContext.dataEndianness, 'little', `${name}: dataEndianness precedence`);
    assert.equal(specificWins.analysisContext.instructionEndianness, 'little', `${name}: instructionEndianness precedence`);
    assert.equal(memoryEndian(specificWins), 'little', `${name}: precedence must reach effects`);

    assert.throws(
      () => analyze({ ...baseInput(), memoryEndianness:'little', endianness:'big' }),
      { name:'TypeError', message:'semantic-function-unsupported-instruction-endianness:big' },
      `${name}: shared endianness still selects instruction order`,
    );
  }
});

test('#4422 explicit machine-effects context is validated and cannot erase canonical selectors', () => {
  for (const [name, analyze] of APIs) {
    assert.throws(
      () => analyze({ ...baseInput(), machineEffectsContext:{ dataEndianness:'big' } }),
      { name:'TypeError', message:'semantic-function-unsupported-memory-endianness:big' },
      `${name}: explicit context must not bypass target validation`,
    );

    const result = analyze({
      ...baseInput(),
      memoryEndianness:'little',
      machineEffectsContext:{ dataEndianness:'little', instructionEndianness:'little', marker:'preserved' },
    });
    assert.equal(result.analysisContext.dataEndianness, 'little', `${name}: data context`);
    assert.equal(result.analysisContext.instructionEndianness, 'little', `${name}: instruction context`);
    assert.equal(memoryEndian(result), 'little', `${name}: context effect`);
  }
});

test('#4422 ARM64 bi-endian and x86 little-endian routes remain compatible', () => {
  for (const [name, analyze] of APIs) {
    const arm64 = analyze({ ...arm64Input(), dataEndianness:'big' });
    assert.equal(arm64.analysisContext.dataEndianness, 'big', `${name}: ARM64 big-endian compatibility`);

    const x86Little = analyze({ ...x86Input(), dataEndianness:'little' });
    assert.equal(x86Little.analysisContext.dataEndianness, 'little', `${name}: x86 little-endian compatibility`);
    assert.throws(
      () => analyze({ ...x86Input(), dataEndianness:'big' }),
      { name:'TypeError', message:'semantic-function-unsupported-memory-endianness:big' },
      `${name}: x86 remains little-endian only`,
    );
  }
});
