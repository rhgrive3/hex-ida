import assert from 'node:assert/strict';
import test from 'node:test';

import { parseWasm as parseWasmCore } from '../../../js/managed/wasm/parser-core.js';
import { parseWasm } from '../../../js/managed/wasm/parser.js';

// #5278: the Code-section decoder stopped after the local declarations and
// stored the rest of the body as raw `bytecode` without checking the mandatory
// `end` (0x0b) that terminates every function expression (WASM binary grammar:
// `expr := instr* end`). A body consisting of only a local-decl count parsed
// successfully with an empty bytecode and no `end` anywhere.

const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const typeSection = [0x01, 0x04, 0x01, 0x60, 0x00, 0x00];
const funcSection = [0x03, 0x02, 0x01, 0x00];

function module(codeSection) {
  return Uint8Array.from([...header, ...typeSection, ...funcSection, ...codeSection]);
}

test('#5278 a body without its terminating end opcode is rejected at the core layer', () => {
  // Code section, 1 body, body_size = 1, local decl count = 0, no 0x0b.
  const bytes = module([0x0a, 0x03, 0x01, 0x01, 0x00]);
  assert.throws(() => parseWasmCore(bytes), /wasm-function-missing-end/);
  assert.throws(() => parseWasm(bytes), /wasm-function-missing-end/);
});

test('#5278 a truncated instruction stream (end dropped mid-body) is rejected', () => {
  // body: local decls 0, then 0x41 0x2a (i32.const 42) with the outer end cut off.
  const bytes = module([0x0a, 0x05, 0x01, 0x03, 0x00, 0x41, 0x2a]);
  assert.throws(() => parseWasmCore(bytes), /wasm-function-missing-end/);
});

test('#5278 a well-formed body with its outer end still parses', () => {
  const bytes = module([0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b]);
  const image = parseWasmCore(bytes);
  assert.equal(image.codeBodies.length, 1);
  assert.equal(image.codeBodies[0].bytecode.length, 1);
  assert.equal(image.codeBodies[0].bytecode[0], 0x0b);
});
