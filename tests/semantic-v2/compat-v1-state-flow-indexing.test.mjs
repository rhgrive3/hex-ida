import assert from 'node:assert/strict';
import test from 'node:test';

import { finalizeLegacyProjection } from '../../js/semantics/compat/semantic-ir-v2-to-v1-finalize.js';

test('legacy state compaction indexes address/call and MOV flow once', () => {
  const count = 128;
  const values = [];
  let addressReads = 0;
  const instructions = [];

  for (let index = 0; index < count; index += 1) {
    const source = {
      id: `s${index}`,
      kind: 'def',
      reg: `r${index}`,
      bits: 64,
      uses: [],
      def: null,
      version: 0,
    };
    const shadow = {
      id: `d${index}`,
      kind: 'def',
      reg: `r${index}`,
      bits: 64,
      uses: [],
      def: null,
      version: 1,
      stateKey: `r${index}`,
    };
    values.push(source, shadow);

    const instruction = {
      id: index,
      op: 'mov',
      dst: shadow,
      args: [{ value: source }],
      extra: { stateWrite: true, publicStateIdentity: `r${index}` },
      block: 0,
      row: index,
    };
    Object.defineProperty(instruction, 'addr', {
      enumerable: true,
      configurable: true,
      get() {
        addressReads += 1;
        return null;
      },
    });
    instructions.push(instruction);
  }

  finalizeLegacyProjection({ instructions, values, locations: new Map() });

  assert.ok(
    addressReads <= count * 8,
    `state compaction repeated a whole instruction scan: ${addressReads}`,
  );
});
