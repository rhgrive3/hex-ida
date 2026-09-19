import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNoreturnContinuationProposal } from '../../../js/analysis/discovery/noreturn-refinement.js';

function authority() {
  return {
    functionStartAt(value) { return value === 0x100n ? 0x100n : value === 0x200n ? 0x200n : null; },
    isLocalFunctionStart(value) { return value === 0x200n; },
    declaredEndOf() { return 0x180n; },
    callInstructionEnd() { return 0x110n; },
    summaryOf() { return { status: { completeness: 'complete' }, noreturn: true }; },
    predecessorProof() { return { complete: true, hasOtherPredecessor: false }; },
    isExecutable() { return true; },
    isInstructionBoundary() { return true; },
  };
}

const binding = { generation: 1 };

test('non-iterable calls fail closed without throwing', () => {
  const proposal = buildNoreturnContinuationProposal({ binding, calls: {}, authority: authority() });
  assert.equal(proposal.status.completeness, 'incomplete');
  assert.equal(proposal.status.stopReason, 'calls-not-iterable');
  assert.deepEqual(proposal.candidates, []);
});

test('iterator failure fails closed and discards partial enumeration', () => {
  const calls = {
    [Symbol.iterator]() {
      return {
        next() {
          if (this.done) return { done: true };
          this.done = true;
          return { done: false, value: { site: 0x100n, target: 0x200n } };
        },
        return() { throw new Error('iterator cleanup failed'); },
      };
    },
  };
  Object.defineProperty(calls, Symbol.iterator, {
    value() {
      return {
        next() { throw new Error('enumeration failed'); },
      };
    },
  });
  const proposal = buildNoreturnContinuationProposal({ binding, calls, authority: authority() });
  assert.equal(proposal.status.completeness, 'incomplete');
  assert.equal(proposal.status.stopReason, 'calls-iteration-failed');
  assert.deepEqual(proposal.candidates, []);
});


test('throwing iterator getter fails closed without escaping', () => {
  const calls = {};
  Object.defineProperty(calls, Symbol.iterator, {
    get() { throw new Error('iterator getter failed'); },
  });
  const proposal = buildNoreturnContinuationProposal({ binding, calls, authority: authority() });
  assert.equal(proposal.status.completeness, 'incomplete');
  assert.equal(proposal.status.stopReason, 'calls-iteration-failed');
  assert.deepEqual(proposal.candidates, []);
});
