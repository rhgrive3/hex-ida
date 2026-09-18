import assert from 'node:assert/strict';

import { buildManagedMethodSummary, lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { liftCilMethod } from '../../../js/managed/cil/lifter.js';
import { parseWasm } from '../../../js/managed/wasm/parser.js';
import { liftWasmFunction } from '../../../js/managed/wasm/lifter.js';
import { buildCil } from '../fixtures/medium-cil.mjs';

const REASON = 'managed-possible-exception-control-unrepresented';

function assertCanonicalMayThrow(lowered, kind, condition = null) {
  assert.equal(lowered.semanticIr.completeness, 'partial');
  assert.ok(lowered.semanticIr.unknowns.some((entry) =>
    entry.reason === REASON && entry.categories?.includes('exceptions')));
  const summary = buildManagedMethodSummary(lowered);
  assert.equal(summary.completeness, 'partial');
  assert.equal(summary.summary.mayThrow, true);
  const exception = summary.thrownExceptions.find((entry) => entry.kind === kind);
  assert.ok(exception, `missing ${kind} summary authority`);
  assert.equal(exception.possible, true);
  if (condition != null) assert.equal(exception.condition, condition);
  assert.ok(summary.summary.semanticFacts.some((fact) =>
    fact.kind === 'managed-possible-exception' && fact.exceptionKind === kind));
}

// CIL producer authority must become canonical summary-level may-throw authority,
// not remain inert metadata on an otherwise-complete function.
{
  const token = [0x01, 0x00, 0x00, 0x04];
  const { bytes } = buildCil({
    methods: [{
      name: 'FieldAccess',
      body: [0x02, 0x7b, ...token, 0x26, 0x2a],
      flags: 0x0006,
      signature: [0x20, 0x00, 0x01],
    }],
    fields: [{ name: 'Value' }],
  });
  const effects = liftCilMethod(0, parseCil(bytes));
  const lowered = lowerVMEffectsToSemanticIr(effects);
  assertCanonicalMayThrow(lowered, 'null-reference', 'obj==null');
}

const wasm = (...sections) => Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0, 0, 0, ...sections.flat()]);
const section = (id, payload) => [id, payload.length, ...payload];
const typePayload = () => [0x01, 0x60, 0x00, 0x00];
const uleb = (value) => {
  const out = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value) byte |= 0x80;
    out.push(byte);
  } while (value);
  return out;
};
function singleWasmFunction(instructions, extraSections = []) {
  return wasm(
    section(1, typePayload()),
    section(3, [0x01, 0x00]),
    ...extraSections,
    section(10, [0x01, ...uleb(1 + instructions.length), 0x00, ...instructions]),
  );
}

// Wasm arithmetic trap authority follows the same shared contract.
{
  const image = parseWasm(singleWasmFunction([0x41, 0x01, 0x41, 0x00, 0x6e, 0x1a, 0x0b]));
  const lowered = lowerVMEffectsToSemanticIr(liftWasmFunction(0, image));
  assertCanonicalMayThrow(lowered, 'integer-divide-by-zero');
}

// Wasm linear-memory OOB authority is likewise represented in the summary.
{
  const memory = section(5, [0x01, 0x00, 0x01]);
  const image = parseWasm(singleWasmFunction([0x41, 0x00, 0x28, 0x02, 0x00, 0x1a, 0x0b], [memory]));
  const lowered = lowerVMEffectsToSemanticIr(liftWasmFunction(0, image));
  assertCanonicalMayThrow(lowered, 'linear-memory-oob');
}

console.log('[phase11] managed possibleExceptions summary regression #8857 passed');
