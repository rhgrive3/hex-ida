import assert from 'node:assert/strict';
import { recoverSchemas } from '../js/schema.js';

function fixture() {
  const strings = [{ addr: 1n, text: 'a.csv' }, { addr: 2n, text: 'b.json' }];
  Object.defineProperty(strings, 'complete', { value: true, configurable: true });
  const program = {
    complete: true,
    unsupported: false,
    graphCompleteness: { callsComplete: true, refsComplete: true },
    functionsReferencing(addr) { return [{ addr: addr === 1n ? 0x1000n : 0x2000n }]; },
    functionRange(addr) { return { start: addr, end: addr + 32n }; },
  };
  return { strings, program };
}

{
  const { strings, program } = fixture();
  const out = await recoverSchemas({ strings, program, architecture: 'arm64', limit: 1, read: async () => null });
  assert.equal(out.complete, false);
  assert.match(out.incompleteReason, /schema-recovery-limit/);
}

{
  const { strings, program } = fixture();
  const out = await recoverSchemas({ strings, program, architecture: 'arm64', limit: 300, read: async () => null });
  assert.equal(out.complete, true);
}

console.log('schema recovery limit completeness: PASS');
