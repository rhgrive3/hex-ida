import assert from 'node:assert/strict';
import { JvmFrontend } from '../../../js/managed/jvm/frontend.js';
import { parseJvm } from '../../../js/managed/jvm/parser.js';
import { buildMinimalJvmClass } from './jvm-parser.test.mjs';

console.log('[phase11] running JVM verifier authority #3899 tests...');

function codeOffsetOf(bytes) {
  return parseJvm(bytes).methods[0].code.offset;
}

function mutateCode(mutator) {
  const bytes = Uint8Array.from(buildMinimalJvmClass());
  const codeOffset = codeOffsetOf(bytes);
  mutator(bytes, codeOffset);
  return bytes;
}

async function validate(bytes, { withImageContext = false } = {}) {
  const frontend = new JvmFrontend();
  const image = await frontend.open(bytes);
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  const decoded = await frontend.decodeMethod(methods[0], { image });
  return frontend.validateMethod(decoded, withImageContext ? { image } : {});
}

// Existing minimal, fully-supported straight-line method remains verifier-valid.
{
  const report = await validate(buildMinimalJvmClass());
  assert.equal(report.status, 'valid');
  assert.equal(report.completeness.specValidation, 'valid');
}

// Issue counterexample: pop on an empty operand stack must not become spec-valid.
{
  const report = await validate(mutateCode((bytes, code) => {
    bytes.set([0x57, 0xb1, 0xb1, 0xb1, 0xb1, 0xb1], code);
  }));
  assert.equal(report.status, 'invalid');
  assert.equal(report.completeness.specValidation, 'failed');
  assert.ok(report.errors.some((error) => error.code === 'jvm-stack-underflow'));
}

// Local category/width must stay inside max_locals.
{
  const bytes = mutateCode((bytes, code) => {
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(code - 6, 1, false);
  });
  const report = await validate(bytes);
  assert.equal(report.status, 'invalid');
  assert.ok(report.errors.some((error) => error.code === 'jvm-local-index-out-of-range'));
}

// Branches may only target decoded instruction starts inside the Code array.
{
  const report = await validate(mutateCode((bytes, code) => {
    bytes.set([0xa7, 0x00, 0x01, 0xb1, 0xb1, 0xb1], code);
  }));
  assert.equal(report.status, 'invalid');
  assert.ok(report.errors.some((error) => error.code === 'jvm-invalid-branch-target'));
}

// Declared max_stack is an authority boundary, not a hint.
{
  const bytes = mutateCode((bytes, code) => {
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(code - 8, 0, false);
  });
  const report = await validate(bytes);
  assert.equal(report.status, 'invalid');
  assert.ok(report.errors.some((error) => error.code === 'jvm-max-stack-exceeded'));
}

// Return opcode must agree with the method descriptor.
{
  const bytes = Uint8Array.from(buildMinimalJvmClass());
  const needle = new TextEncoder().encode('()V');
  let at = -1;
  outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    at = i;
    break;
  }
  assert.notEqual(at, -1);
  bytes[at + 2] = 'I'.charCodeAt(0);
  const report = await validate(bytes);
  assert.equal(report.status, 'invalid');
  assert.ok(report.errors.some((error) => error.code === 'jvm-return-type-mismatch'));
}

// Reference-sensitive throw verification stays partial until Throwable assignability is proven.
{
  const report = await validate(mutateCode((bytes, code) => {
    bytes.set([0x01, 0xbf, 0xb1, 0xb1, 0xb1, 0xb1], code); // aconst_null; athrow
  }));
  assert.equal(report.status, 'partial');
  assert.equal(report.completeness.specValidation, 'partial');
}

// Unsupported semantic/verifier coverage stays explicit partial, never fake valid.
{
  const report = await validate(mutateCode((bytes, code) => {
    bytes.set([0xc8, 0x00, 0x00, 0x00, 0x05, 0xb1], code); // goto_w +5; unsupported lifter semantics
  }));
  assert.equal(report.status, 'partial');
  assert.equal(report.completeness.specValidation, 'partial');
}

console.log('  ok JVM verifier authority #3899 tests passed');
