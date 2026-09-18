import assert from 'node:assert/strict';
import { ContextBroker } from '../../../js/ai/context/broker.js';

function projectFunction(activeFunction, options = {}) {
  const broker = new ContextBroker(
    { currentAddress: activeFunction.address ?? 0x1000n, activeFunction },
    { maxBytes: 128 * 1024, maxFunctionLines: 8, ...options },
  );
  return broker.buildModelContext({
    request: { scope: 'function' },
    effectiveScope: 'function',
    includeHistory: false,
  }).context.current.function;
}

// #4570: every local representation cap must be reflected in the function
// completeness signal. The model must never receive clipped decompiler text as
// if the current-function context were complete.
{
  const pseudocode = Array.from({ length: 81 }, (_, index) => `line_${index}`).join('\n');
  const projected = projectFunction({ address: 0x1000n, pseudocode });
  assert.equal(projected.pseudocode.split('\n').length, 80);
  assert.equal(projected.pseudocode.includes('line_80'), false);
  assert.equal(projected.truncated, true, 'pseudocode line clipping must be visible');
}

{
  const projected = projectFunction({ address: 0x1000n, pseudocode: 'p'.repeat(16001) });
  assert.equal(projected.pseudocode.length, 16000);
  assert.equal(projected.truncated, true, 'pseudocode character clipping must be visible');
}

{
  const projected = projectFunction({ address: 0x1000n, assembly: 'a'.repeat(30001) });
  assert.equal(projected.assembly.length, 30000);
  assert.equal(projected.truncated, true, 'assembly character clipping must be visible');
}

// Exact boundaries and ordinary content remain complete.
{
  const pseudocode = Array.from({ length: 80 }, () => 'p'.repeat(199)).join('\n'); // 15,999 chars.
  assert.equal(pseudocode.length, 15999);
  const projected = projectFunction({ address: 0x1000n, pseudocode, assembly: 'a'.repeat(30000) });
  assert.equal(projected.pseudocode.length, 15999);
  assert.equal(projected.assembly.length, 30000);
  assert.equal(projected.truncated, false);
}

// Character limits are inclusive: exact-cap content must not be mislabeled.
{
  const projected = projectFunction({
    address: 0x1000n,
    pseudocode: 'p'.repeat(16000),
    assembly: 'a'.repeat(30000),
  });
  assert.equal(projected.pseudocode.length, 16000);
  assert.equal(projected.assembly.length, 30000);
  assert.equal(projected.truncated, false);
}

// Existing instruction-line completeness authority is preserved.
{
  const instructions = Array.from({ length: 9 }, (_, index) => ({
    address: 0x1000n + BigInt(index * 4), mnemonic: 'nop', operands: '',
  }));
  const projected = projectFunction({ address: 0x1000n, instructions });
  assert.equal(projected.instructions.length, 8);
  assert.equal(projected.truncated, true);
}

// Later whole-context budget trimming remains authoritative as well.
{
  const broker = new ContextBroker({
    currentAddress: 0x1000n,
    activeFunction: { address: 0x1000n, assembly: 'a'.repeat(12000), pseudocode: 'p'.repeat(12000) },
  }, { maxBytes: 7000, maxFunctionLines: 8 });
  const built = broker.buildModelContext({
    request: { scope: 'function' }, effectiveScope: 'function', includeHistory: false,
  });
  assert.equal(built.context.current.function.truncated, true);
  assert.ok((built.context.current.function.assembly?.length ?? 0) <= 2000);
  assert.ok((built.context.current.function.pseudocode?.length ?? 0) <= 2000);
}

console.log('issue-4570-ai-context-function-truncation: PASS');
