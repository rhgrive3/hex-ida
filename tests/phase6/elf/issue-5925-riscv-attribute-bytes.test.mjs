import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRiscvAttributes } from '../../../js/binary/riscv-isa.js';

function uleb(n) {
  const out = [];
  do {
    let byte = n & 0x7f;
    n = Math.floor(n / 128);
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return out;
}

function u32le(n) {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

function ntbs(value) {
  return [...Buffer.from(value, 'utf8'), 0];
}

function attributes() {
  const arch = [...uleb(5), ...ntbs('rv64imc')];
  const subsub = [...uleb(1), ...u32le(1 + 4 + arch.length), ...arch];
  const vendor = ntbs('riscv');
  const subsectionLength = 4 + vendor.length + subsub.length;
  return [0x41, ...u32le(subsectionLength), ...vendor, ...subsub];
}

test('5925: valid byte arrays still produce RISC-V attribute evidence', () => {
  const bytes = attributes();
  const arrayResult = parseRiscvAttributes(bytes);
  const typedResult = parseRiscvAttributes(Uint8Array.from(bytes));

  assert.equal(arrayResult?.canonical, 'rv64imc');
  assert.equal(typedResult?.canonical, 'rv64imc');
});

test('5925: array values outside the byte domain cannot wrap into attribute evidence', () => {
  for (const malformed of [
    { value: 0x141, label: 'out-of-range integer' },
    { value: -1, label: 'negative integer' },
    { value: 1.5, label: 'fractional number' },
    { value: '65', label: 'numeric string' },
    { value: true, label: 'boolean' },
    { value: {}, label: 'object' },
  ]) {
    const bytes = attributes();
    bytes[0] = malformed.value;
    assert.equal(parseRiscvAttributes(bytes), null, malformed.label);
  }
});

test('5925: malformed generic iterables fail closed without byte coercion', () => {
  const bytes = attributes();
  const malformed = {
    *[Symbol.iterator]() {
      yield 0x141;
      yield* bytes.slice(1);
    },
  };

  assert.equal(parseRiscvAttributes(malformed), null);
});
