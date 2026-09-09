import assert from 'node:assert/strict';
import { createCapstoneX86Session } from '../phase5/helpers/capstone-session.mjs';
import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { dispatchX86MachineEffects, liftX86MachineEffects, liftX86DecodedMachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import { closeTrustedX86Partial } from '../../js/targets/architecture/x86_64/effects/trusted-decoder-terminal.js';

// Producer regression for the missing #6910 flag-domain contribution. These
// parser checks do not claim receiver authority or execute x87 instructions.
const session = await createCapstoneX86Session();
try {
  for (const [bytes, family, domain] of [
    [[0xd9, 0xfa], 'fsqrt', 'fpu-flags'],
    [[0xd9, 0xfe], 'fsin', 'fpu-flags'],
    [[0xdd, 0xd8], 'fstp', 'fpu-flags'],
    [[0xd9, 0xe5], 'fxam', 'fpu-flags'],
    [[0xd9, 0xc9], 'fxch', 'fpu-flags'],
    [[0xd9, 0xf4], 'fxtract', 'fpu-flags'],
    [[0x9b], 'wait', 'fpu-flags'],
    [[0xdf, 0xe9], 'fucompi', 'eflags'],
    [[0xdf, 0xf1], 'fcompi', 'eflags'],
    [[0xdb, 0xe9], 'fucomi', 'eflags'],
    [[0xdb, 0xf1], 'fcomi', 'eflags'],
    [[0xda, 0xd1], 'fcmovbe', 'eflags'],
    [[0x01, 0xd8], 'add', 'eflags'],
    [[0x0f, 0xc7, 0xf0], 'rdrand', 'eflags'],
    [[0x0f, 0x0e], 'femms', 'eflags'],
  ]) {
    const [raw] = session.decode(bytes, 0x1000n);
    assert.equal(raw.instructionFamily, family);
    assert.equal(raw.detail.flagsKind, domain, family);
    const decoded = createX86DecodedInstruction(raw);
    assert.equal(decoded.detail.flagsKind, domain, `${family}: normalized domain`);
    assert.equal(decoded.detail.eflags, raw.detail.eflags, `${family}: union bits preserved`);
    if (['fcomi', 'fcompi', 'fucomi', 'fucompi'].includes(family)) {
      // Unit-test the summary projection directly; public dispatch must still
      // refuse unbranded rows. The native oracle and QEMU hardware report
      // distinguish six arithmetic-flag outputs from preserved x87 C flags.
      const partial = dispatchX86MachineEffects(decoded, { instructionId: 'flag-domain:compare' });
      assert.equal(partial.result.completeness, 'partial');
      const bundle = closeTrustedX86Partial(decoded, partial.ownerId, partial.result);
      const summary = bundle.operations[0].effectSummary;
      for (const flag of ['cf', 'pf', 'zf', 'of', 'sf', 'af']) {
        assert.ok(summary.registersWritten.includes(`rflags.${flag}`), `${family}: ${flag} output`);
      }
      assert.ok(!summary.registersRead.some((name) => name === 'rflags' || name.startsWith('rflags.')),
        `${family}: comparison must not consume prior arithmetic flags`);
      for (const flag of ['c0', 'c1', 'c2', 'c3']) assert.ok(!summary.registersWritten.includes(`fpsw.${flag}`));
    }
    if (family === 'fsqrt') {
      for (const row of [raw, decoded, structuredClone(raw)]) {
        assert.equal(liftX86MachineEffects(row, { instructionId: 'flag-domain:fsqrt' }).completeness,
          'partial', 'a correct flag tag must not mint receiver-revalidated authority');
        const rebound = liftX86DecodedMachineEffects(row, { instructionId: 'flag-domain:canonical' });
        assert.equal(rebound.instructionId, 'flag-domain:canonical');
        assert.equal(rebound.completeness, 'partial', 'metadata rebinding cannot mint receiver authority');
      }
    }
  }
} finally {
  session.close();
}
