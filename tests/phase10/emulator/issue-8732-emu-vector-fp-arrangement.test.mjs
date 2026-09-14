// Regression for #8732: the floating-point dispatch routed on the mnemonic alone,
// so an AdvSIMD vector form such as `FADD V1.2S, ...` ran as one binary64 scalar
// operation and silently produced a corrupt vector. Scalar and vector forms are
// separated by operand shape, and each named element is computed independently.
import assert from 'node:assert/strict';
import { Emulator } from '../../../js/emu.js';

const OPERAND_A = 0x2000n;
const OPERAND_B = 0x2100n;
const RESULT = 0x2200n;
const PAGE_END = 0x2300n;

function float32Bytes(values) {
  const view = new DataView(new ArrayBuffer(16));
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return new Uint8Array(view.buffer);
}

function float64Bytes(values) {
  const view = new DataView(new ArrayBuffer(16));
  values.forEach((value, index) => view.setFloat64(index * 8, value, true));
  return new Uint8Array(view.buffer);
}

function readFloat32(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [0, 4, 8, 12].map((offset) => view.getFloat32(offset, true));
}

function readFloat64(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [0, 8].map((offset) => view.getFloat64(offset, true));
}

// Executes one vector operation through the same public entry points real code
// uses: memory operands in, register arithmetic, memory store out.
async function vectorOperation({ mnemonic, arrangement, operands, unary = false }) {
  const lines = [
    'ldr q0, [x1]',
    'ldr q1, [x2]',
    unary
      ? `${mnemonic} v2.${arrangement}, v0.${arrangement}`
      : `${mnemonic} v2.${arrangement}, v0.${arrangement}, v1.${arrangement}`,
    'str q2, [x3]',
  ];
  const emu = new Emulator({ fetch: async (pc) => {
    const line = lines[Number((pc - 0x1000n) / 4n)];
    const pos = line.indexOf(' ');
    return { mn: line.slice(0, pos), ops: line.slice(pos + 1) };
  } });
  await emu.mapZero(OPERAND_A, Number(PAGE_END - OPERAND_A));
  await emu.store(OPERAND_A, 16, operands.a);
  await emu.store(OPERAND_B, 16, operands.b);
  emu.setup(0x1000n, [0n]);
  emu.set('x1', OPERAND_A);
  emu.set('x2', OPERAND_B);
  emu.set('x3', RESULT);
  for (const _ of lines) {
    const step = await emu.step();
    assert.equal(step.ok, true, `${lines.join(' ; ')} -> ${JSON.stringify(step)}`);
  }
  return emu.dump(RESULT, 16);
}

// The counterexample from the report: [1.0f, 2.0f] doubled element-wise.
{
  const bytes = await vectorOperation({
    mnemonic: 'fadd', arrangement: '2s', unary: false,
    operands: { a: float32Bytes([1, 2, 0, 0]), b: float32Bytes([1, 2, 0, 0]) },
  });
  assert.deepEqual(readFloat32(bytes).slice(0, 2), [2, 4], '.2S FADD doubles each element');
  assert.deepEqual(Array.from(bytes.slice(8)), [0, 0, 0, 0, 0, 0, 0, 0], '.2S zeroes the bits above the named elements');
}

// Full-width arrangements.
{
  const bytes = await vectorOperation({
    mnemonic: 'fadd', arrangement: '4s',
    operands: { a: float32Bytes([1, 2, 3, 4]), b: float32Bytes([1, 2, 3, 4]) },
  });
  assert.deepEqual(readFloat32(bytes), [2, 4, 6, 8], '.4S FADD doubles all four elements');
  const wide = await vectorOperation({
    mnemonic: 'fadd', arrangement: '2d',
    operands: { a: float64Bytes([1.5, -2.5]), b: float64Bytes([1.5, -2.5]) },
  });
  assert.deepEqual(readFloat64(wide), [3, -5], '.2D FADD doubles both elements');
}

// Every element-wise mnemonic shares one per-element definition.
{
  const a = float32Bytes([6, 8, 10, 12]);
  const b = float32Bytes([2, 4, 5, 6]);
  const cases = [
    ['fadd', [8, 12, 15, 18]],
    ['fsub', [4, 4, 5, 6]],
    ['fmul', [12, 32, 50, 72]],
    ['fdiv', [3, 2, 2, 2]],
    ['fmin', [2, 4, 5, 6]],
    ['fmax', [6, 8, 10, 12]],
    ['fminnm', [2, 4, 5, 6]],
    ['fmaxnm', [6, 8, 10, 12]],
  ];
  for (const [mnemonic, expected] of cases) {
    const bytes = await vectorOperation({ mnemonic, arrangement: '4s', operands: { a, b } });
    assert.deepEqual(readFloat32(bytes), expected, `${mnemonic} .4S applies element-wise`);
  }
  const negated = await vectorOperation({ mnemonic: 'fneg', arrangement: '4s', unary: true, operands: { a, b: float32Bytes([0, 0, 0, 0]) } });
  assert.deepEqual(readFloat32(negated), [-6, -8, -10, -12], 'fneg .4S negates each element');
  const absolute = await vectorOperation({ mnemonic: 'fabs', arrangement: '4s', unary: true, operands: { a: float32Bytes([-6, 8, -10, 12]), b: float32Bytes([0, 0, 0, 0]) } });
  assert.deepEqual(readFloat32(absolute), [6, 8, 10, 12], 'fabs .4S takes the magnitude of each element');
}

// NaN handling stays identical to the scalar definition element-wise.
{
  const nan = float32Bytes([Number.NaN, 2, Number.NaN, 4]);
  const plain = float32Bytes([1, Number.NaN, 3, Number.NaN]);
  const min = await vectorOperation({ mnemonic: 'fmin', arrangement: '4s', operands: { a: nan, b: plain } });
  const minNum = await vectorOperation({ mnemonic: 'fminnm', arrangement: '4s', operands: { a: nan, b: plain } });
  assert.deepEqual(readFloat32(min).map(Number.isNaN), [true, true, true, true], 'fmin propagates a NaN element');
  assert.deepEqual(readFloat32(minNum), [1, 2, 3, 4], 'fminnm returns the numeric element where only one is NaN');
}

// Scalar controls: the same mnemonics through the scalar form are unchanged.
{
  const lines = ['fmov d0, x0', 'fadd d1, d0, d0', 'fmov x0, d1'];
  const emu = new Emulator({ fetch: async (pc) => {
    const line = lines[Number((pc - 0x1000n) / 4n)];
    const pos = line.indexOf(' ');
    return { mn: line.slice(0, pos), ops: line.slice(pos + 1) };
  } });
  emu.setup(0x1000n, [0x3ff8000000000000n]);
  for (const _ of lines) {
    const step = await emu.step();
    assert.equal(step.ok, true, JSON.stringify(step));
  }
  assert.equal(emu.get('x0'), 0x4008000000000000n, 'scalar FADD stays a single binary64 operation');
}

// Arrangements and shapes this emulator does not model fail closed before any
// destination write. .1D is a generally valid register arrangement spelling,
// but it is RESERVED for these AdvSIMD floating-point arithmetic encodings.
for (const [text, code] of [
  ['fadd v2.4h, v0.4h, v1.4h', 'unsupported-arrangement'],
  ['fadd v2.8h, v0.8h, v1.8h', 'unsupported-arrangement'],
  ['fadd v2.16b, v0.16b, v1.16b', 'unsupported-arrangement'],
  ['fadd v2.1d, v0.1d, v1.1d', 'unsupported-arrangement'],
  ['fadd q2.4s, q0.4s, q1.4s', 'unsupported-instruction'],
  ['fadd v2, v0, v1', 'unsupported-arrangement'],
]) {
  const lines = ['fmov d0, x0', text, 'fmov x0, d1'];
  const emu = new Emulator({ fetch: async (pc) => {
    const line = lines[Number((pc - 0x1000n) / 4n)];
    const pos = line.indexOf(' ');
    return { mn: line.slice(0, pos), ops: line.slice(pos + 1) };
  } });
  emu.setup(0x1000n, [0x3ff0000000000000n]);
  const primed = await emu.step();
  assert.equal(primed.ok, true, JSON.stringify(primed));
  const step = await emu.step();
  assert.equal(step.ok, false, `${text} must not execute successfully`);
  assert.equal(step.code, code, `${text} must report ${code}, got ${step.code}`);
  assert.equal(emu.pc, 0x1004n, `${text} must fault before advancing past itself`);
  assert.equal(emu.get('x0'), 0x3ff0000000000000n, `${text} must leave the source register alone`);
}

console.log('issue-8732 emu advsimd element-wise fp: ok');