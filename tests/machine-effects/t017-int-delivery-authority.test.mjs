import assert from 'node:assert/strict';
import test from 'node:test';

import { createCapstoneX86Session } from '../phase5/helpers/capstone-session.mjs';
import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { dispatchX86MachineEffects, liftX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import { liftX86ControlEffects } from '../../js/targets/architecture/x86_64/effects/control.js';
import { closeTrustedX86Partial } from '../../js/targets/architecture/x86_64/effects/trusted-decoder-terminal.js';
import { registerReceiverRevalidatedX86Row } from '../../js/targets/architecture/x86_64/receiver-provenance.js';
import { X86_LONG64_DECODER_WITNESSES } from '../../tools/validation/machine-effects/fixtures/x86-long64-decoder-witnesses.mjs';
import { bytesFromX86Long64WitnessHex } from '../../tools/validation/machine-effects/x86-long64-decoder-denominator.mjs';

test('T017 validation context cannot invent INT delivery state', async () => {
  const witness = X86_LONG64_DECODER_WITNESSES.find(([id]) => id === 238);
  assert.ok(witness, 'INT witness 238 must exist');
  const [id, name, hex] = witness;
  assert.equal(name, 'int');

  const session = await createCapstoneX86Session();
  try {
    const bytes = bytesFromX86Long64WitnessHex(hex);
    const decoded = session.decode(bytes, 0x100000n + BigInt(id) * 0x20n);
    assert.equal(decoded.length, 1);
    const instruction = createX86DecodedInstruction({
      ...decoded[0],
      instructionId:`t017-int-witness:${id}`,
    });

    for (const context of [{}, { closureMatrixTerminal:true }]) {
      const dispatched = dispatchX86MachineEffects(instruction, context);
      assert.equal(dispatched.ownerId, 'control');
      const result = dispatched.result;
      assert.equal(result.completeness, 'partial', 'validation context is not delivery-state authority');
      assert.equal(result.controlEffect?.kind, 'unknown');
      assert.equal(result.unknownEffects?.reason, 'x86-int-delivery-state-unmodelled');
      assert.equal(result.metadata?.terminalizedBy, undefined);
    }
  } finally {
    session.close();
  }
});

test('T017 negative tests: missing architectural state and forged provenance cannot complete INT', async () => {
  const session = await createCapstoneX86Session();
  try {
    const decoded = session.decode(new Uint8Array([0xcd, 0x80]), 0x400000n);
    assert.equal(decoded.length, 1);
    const instruction = createX86DecodedInstruction({
      ...decoded[0],
      instructionId: 't017-int-negative-missing-state',
    });

    // 1. Ordinary public dispatch must remain partial
    const publicResult = dispatchX86MachineEffects(instruction, {}).result;
    assert.equal(publicResult.completeness, 'partial', 'ordinary public dispatch must remain partial');
    assert.equal(publicResult.unknownEffects?.reason, 'x86-int-delivery-state-unmodelled');
    assert.deepEqual(
      new Set(publicResult.unknownEffects?.categories),
      new Set(['control', 'faults', 'registers', 'memory', 'flags']),
    );

    // 2. Closure matrix terminal flag alone must not terminalize
    const matrixResult = dispatchX86MachineEffects(instruction, { closureMatrixTerminal: true }).result;
    assert.equal(matrixResult.completeness, 'partial', 'closure matrix terminal override cannot close INT');
    assert.equal(matrixResult.unknownEffects?.reason, 'x86-int-delivery-state-unmodelled');
    assert.equal(matrixResult.metadata?.terminalizedBy, undefined);

    // 3. Forged receiver brand in a non-receiver realm must fail closed
    const forgedInstruction = {
      ...instruction,
      __brand: 'receiver-revalidated',
    };
    const forgedResult = dispatchX86MachineEffects(forgedInstruction, { closureMatrixTerminal: true }).result;
    assert.equal(forgedResult.completeness, 'partial', 'forged brand cannot close INT');
    assert.equal(forgedResult.unknownEffects?.reason, 'x86-int-delivery-state-unmodelled');
    assert.equal(forgedResult.metadata?.terminalizedBy, undefined);

    // 4. Missing required architectural state in detail must be explicit
    assert.deepEqual(
      publicResult.unknownEffects?.detail?.requiredArchitecturalState,
      ['idtr-idt-gate', 'cpl', 'gate-dpl-present-type', 'target-selector-rip', 'privilege-transition-stack'],
    );
    assert.deepEqual(
      publicResult.unknownEffects?.detail?.possibleOutcomes,
      ['handler-delivery', '#GP', '#NP', '#SS'],
    );
  } finally {
    session.close();
  }
});

test('INT delivery exactness is impossible without architectural delivery state and must remain partial', async () => {
  const session = await createCapstoneX86Session();
  try {
    // 1. Missing architectural delivery state (IDTR, IDT gate, CPL/DPL, stack, etc.)
    // Intel SDM Vol. 3A Chapter 6 & Vol. 2A INT n:
    // INT n requires indexing IDTR.base + vector * 16 (in 64-bit mode), checking gate DPL >= CPL,
    // switching stack via IST or privilege transition (TSS RSPn/ISTn), pushing SS, RSP, RFLAGS, CS, RIP,
    // and loading new CS:RIP. None of this state exists statically at an isolated instruction row.
    const bytes = bytesFromX86Long64WitnessHex('26cd00'); // ES: INT 0
    const decoded = session.decode(bytes, 0x200000n);
    assert.equal(decoded.length, 1);
    const instruction = createX86DecodedInstruction({
      ...decoded[0],
      instructionId: 'int-negative-missing-state:1',
    });

    const direct = liftX86ControlEffects(instruction);
    assert.equal(direct.completeness, 'partial');
    assert.equal(direct.unknownEffects?.reason, 'x86-int-delivery-state-unmodelled');
    assert.deepEqual(
      new Set(direct.unknownEffects?.categories),
      new Set(['control', 'faults', 'registers', 'memory', 'flags']),
    );

    // 2. Forged receiver provenance cannot bypass fail-closed delivery guard
    // Even if an object attempts to register receiver authority or sets closureMatrixTerminal,
    // dispatchWithDecoderSource -> terminalize explicitly refuses to terminalize INT delivery
    // because reason === 'x86-int-delivery-state-unmodelled' is a fail-closed guard.
    const forgedProvenanceRow = registerReceiverRevalidatedX86Row({
      ...instruction,
      instructionId: 'int-negative-forged-provenance:2',
    });
    const forgedDispatch = dispatchX86MachineEffects(forgedProvenanceRow, { closureMatrixTerminal: true });
    assert.equal(forgedDispatch.ownerId, 'control');
    assert.equal(forgedDispatch.result.completeness, 'partial');
    assert.equal(forgedDispatch.result.unknownEffects?.reason, 'x86-int-delivery-state-unmodelled');
    assert.equal(forgedDispatch.result.metadata?.terminalizedBy, undefined);

    // 3. Ordinary public / untrusted invocations must remain partial
    const publicResult = liftX86MachineEffects(instruction);
    assert.equal(publicResult.completeness, 'partial');
    assert.equal(publicResult.unknownEffects?.reason, 'x86-int-delivery-state-unmodelled');
  } finally {
    session.close();
  }
});
