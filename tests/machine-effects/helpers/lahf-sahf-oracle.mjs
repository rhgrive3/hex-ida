import assert from 'node:assert/strict';

export const FLAG_TRANSFER_CASES = ['lahf', 'sahf'].flatMap(family =>
  [null, 0x26, 0x2e, 0x36, 0x3e, ...Array.from({ length:16 }, (_, i) => 0x40 + i)].map(prefix => ({
    family, prefix, bytes:[...(prefix == null ? [] : [prefix]), family === 'lahf' ? 0x9f : 0x9e],
  })));
const POSITIONS = { 'RFLAGS.CF':0n, 'RFLAGS.PF':2n, 'RFLAGS.AF':4n, 'RFLAGS.ZF':6n, 'RFLAGS.SF':7n };
const mask = bits => (1n << BigInt(bits)) - 1n;

// Deliberately instruction-agnostic interpreter for the tiny emitted primitive
// subset. No mnemonic dispatch, host decoder, receiver brand, or intrinsic
// interpretation: unsupported operations make this verifier fail closed.
export function evaluateFlagTransfer(bundle, rax, rflags) {
  const temporaries = new Map();
  const read = value => {
    if (value.kind === 'bitvector' && typeof value.value === 'string' && /^[0-9]+$/.test(value.value)) return BigInt(value.value);
    assert.equal(value.kind, 'temporary');
    assert.ok(temporaries.has(value.temporaryId), `undefined temporary: ${value.temporaryId}`);
    return temporaries.get(value.temporaryId);
  };
  for (const op of bundle.operations) {
    if (op.kind === 'register-read' || op.kind === 'register-write') {
      assert.equal(op.register.registerId, 'rax');
      if (op.kind === 'register-read') temporaries.set(op.value.temporaryId, rax);
      else rax = read(op.value) & mask(64);
    } else if (op.kind === 'flag-read' || op.kind === 'flag-write') {
      assert.ok(Object.hasOwn(POSITIONS, op.flag.flagId), `unexpected flag: ${op.flag.flagId}`);
      const shift = POSITIONS[op.flag.flagId];
      if (op.kind === 'flag-read') temporaries.set(op.value.temporaryId, (rflags >> shift) & 1n);
      else rflags = (rflags & ~(1n << shift)) | ((read(op.value) & 1n) << shift);
    } else {
      assert.equal(op.kind, 'value', `unexpected effect: ${op.kind}`);
      const args = op.inputs.map(read);
      const bits = op.outputs[0].valueType.widthBits;
      let value;
      if (op.opcode === 'extract') value = (args[0] >> BigInt(op.metadata.lsb)) & mask(op.metadata.widthBits);
      else if (op.opcode === 'insert') {
        const field = mask(op.metadata.widthBits), shift = BigInt(op.metadata.lsb);
        value = (args[0] & ~(field << shift)) | ((args[1] & field) << shift);
      } else assert.fail(`unsupported oracle primitive: ${op.opcode}`);
      temporaries.set(op.outputs[0].temporaryId, value & mask(bits));
    }
  }
  return { rax, rflags };
}

export function verifyFlagTransferStructure(bundle, family) {
  assert.equal(bundle.completeness, 'exact');
  assert.equal(bundle.metadata.operation, family);
  assert.equal(bundle.metadata.terminalizedBy, undefined);
  assert.equal(bundle.controlEffect.kind, 'fallthrough');
  assert.equal(bundle.unknownEffects, undefined);
  assert.equal(bundle.possibleFaults.length, 1);
  const fault = bundle.possibleFaults[0];
  assert.equal(fault.kind, 'undefined-opcode');
  assert.equal(fault.condition.feature, 'CPUID.80000001H:ECX[0]');
  assert.equal(fault.condition.requiredValue, 1);
  assert.equal(fault.condition.faultWhen, 'feature-bit-clear');
  assert.equal(fault.detail.fault, '#UD');
  const kinds = bundle.operations.map(op => op.kind);
  assert.ok(!kinds.includes('intrinsic'));
  assert.ok(!kinds.some(kind => kind.startsWith('memory-')));
  const reads = bundle.operations.filter(op => op.kind === 'flag-read').map(op => op.flag.flagId).sort();
  const writes = bundle.operations.filter(op => op.kind === 'flag-write').map(op => op.flag.flagId).sort();
  assert.deepEqual(reads, family === 'lahf' ? Object.keys(POSITIONS).sort() : []);
  assert.deepEqual(writes, family === 'sahf' ? Object.keys(POSITIONS).sort() : []);
  assert.equal(kinds.filter(kind => kind === 'register-write').length, family === 'lahf' ? 1 : 0);
}

// Independent SDM bit-mask reference: all AH values, all LAHF flag combinations,
// and both prior SAHF flag polarities. Both RAX canaries have distinct AL/upper bits.
export function verifyFlagTransferValues(bundle, family) {
  verifyFlagTransferStructure(bundle, family);
  let cases = 0;
  for (const seed of [0x0123456789abcdefn, 0xfedcba9876543210n]) {
    for (let byte = 0n; byte < 256n; byte++) {
      for (const extra of [0n, 0x400n, 0x800n, 0xc00n]) {
        for (const prior of family === 'sahf' ? [0n, 0xd5n] : [byte & 0xd5n]) {
          const rax = (seed & ~0xff00n) | (byte << 8n);
          const rflags = 0x202n | prior | extra;
          const expected = family === 'lahf'
            ? { rax:(rax & ~0xff00n) | (((rflags & 0xd5n) | 2n) << 8n), rflags }
            : { rax, rflags:(rflags & ~0xd5n) | (byte & 0xd5n) };
          assert.deepEqual(evaluateFlagTransfer(bundle, rax, rflags), expected, `${family}:${rax.toString(16)}:${rflags.toString(16)}`);
          cases++;
        }
      }
    }
  }
  return cases;
}
