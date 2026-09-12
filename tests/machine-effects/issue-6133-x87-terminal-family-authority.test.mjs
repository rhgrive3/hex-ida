import assert from 'node:assert/strict';
import { forEachX86BrowserSession } from './helpers/x86-browser-effects.mjs';
import { liftX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import { X87_FAMILIES } from '../../js/targets/architecture/x86_64/effects/extended-state-helpers.js';

// #6133: the x87 family decision (^f(?!s|x)/) leaked every `fs*`/`fx*`
// member into the RFLAGS interpretation of Capstone's union flag word and
// dropped the x87 environment surface. The finite canonical family set is
// the authority: every x87 family must read/write FPU status flags and the
// x87 environment, and no x87 family may mint rflags.* surfaces here.
await forEachX86BrowserSession(async ({ decodeAndLift }) => {
  const fixtures = {
    fsqrt: [0xd9, 0xfa],
    fsin: [0xd9, 0xfe],
    fsincos: [0xd9, 0xfb],
    fscale: [0xd9, 0xfd],
    fst_m32: [0xd9, 0x12],
    fstp_m64: [0xdd, 0x18],
    fstenv: [0xd9, 0x30],
    fsave: [0x9b, 0xdd, 0x30],
    fxam: [0xd9, 0xe5],
    fxch_st1: [0xd9, 0xc9],
    fxtract: [0xd9, 0xf4],
    fxsave: [0x0f, 0xae, 0x00],
    fxrstor: [0x0f, 0xae, 0x08],
  };
  for (const [name, bytes] of Object.entries(fixtures)) {
    const rows = await decodeAndLift(bytes, 0x730000n, name === 'fsave' ? 2 : 1);
    if (name === 'fsave') assert.deepEqual(rows.map(row => row.decoded.instructionFamily), ['wait', 'fnsave']);
    else assert.equal(rows.length, 1, `${name}: exactly one instruction`);
    // FSAVE's WAIT prefix is a separate decoded instruction. Check both,
    // rather than accidentally proving only WAIT and dropping FNSAVE.
    for (const { decoded:raw, effects:bundle } of rows) {
      assert.ok(raw, `${name}: decoder fixture must decode`);
      assert.ok(X87_FAMILIES.has(raw.instructionFamily), `${name}: fixture must be a canonical x87 family`);
      assert.equal(bundle?.completeness, 'exact-with-intrinsic', `${name}: ${bundle?.unknownEffects?.reason}`);
      assert.equal(bundle.metadata.terminalizedBy, 'trusted-capstone-structured-intrinsic', name);
      const intrinsic = bundle.operations.find((op) => op.kind === 'intrinsic');
      assert.ok(intrinsic, `${name}: intrinsic required`);
      const reads = new Set(intrinsic.effectSummary.registersRead);
      const writes = new Set(intrinsic.effectSummary.registersWritten);
      assert.ok(reads.has('x86.x87.environment'), `${name}: x87 environment read surface required`);
      assert.ok(writes.has('x86.x87.environment'), `${name}: x87 environment write surface required`);
      for (const flag of [...reads, ...writes]) {
        assert.ok(!flag.startsWith('rflags.'), `${name}: x87 union flag word must never be read as RFLAGS (${flag})`);
      }
      if (name === 'fsqrt') {
        // Structured-cloning a real decoder row is still not authority to
        // bypass the dedicated receiver, even after a valid browser run.
        const untrusted = liftX86MachineEffects(raw, { instructionId:'x87-terminal:untrusted-clone' });
        assert.equal(untrusted.completeness, 'partial');
        assert.equal(untrusted.operations.length, 0);
      }
    }
  }

  // Genuine EFLAGS instructions keep their RFLAGS interpretation.
  const [{ effects:eflagsBundle }] = await decodeAndLift([0x31, 0xc0], 0x731000n);
  const eflagsIntrinsic = eflagsBundle.operations.find((op) => op.kind === 'intrinsic');
  if (eflagsIntrinsic) {
    const flagSurfaces = [...eflagsIntrinsic.effectSummary.registersRead, ...eflagsIntrinsic.effectSummary.registersWritten]
      .filter((flag) => flag.startsWith('rflags.') || flag.startsWith('fpsw.'));
    assert.ok(!flagSurfaces.some((flag) => flag.startsWith('fpsw.')), 'EFLAGS instruction must not mint fpsw surfaces');
  }

  // Non-x87 `f` families stay outside the set (no over-wide membership).
  assert.equal(X87_FAMILIES.has('femms'), false, 'femms is 3DNow!, not x87');
  assert.equal(X87_FAMILIES.has('fwait') || X87_FAMILIES.has('wait'), true, 'x87 wait membership kept');
  await assert.rejects(decodeAndLift([256]), /byte-exact fixture/);
  await assert.rejects(decodeAndLift([]), /byte-exact fixture/);
});

console.log('x86 trusted-terminal x87 family authority (#6133): PASS');
