import assert from 'node:assert/strict';
import { liftArm64AtomicEffects } from '../../js/targets/architecture/arm64/effects/atomic.js';

let sequence = 0;
const x = (n) => ({ k:'reg', text:`x${n}`, cls:'gp', bits:64, num:n });
const w = (n) => ({ k:'reg', text:`w${n}`, cls:'gp', bits:32, num:n });
const xzr = () => ({ k:'reg', text:'xzr', cls:'zr', bits:64, num:31 });
const wzr = () => ({ k:'reg', text:'wzr', cls:'zr', bits:32, num:31 });
const mem = (base) => ({ k:'mem', text:'[...]', base, index:null, shift:null, mode:'offset', disp:null, addressDisp:null, writebackDisp:null });
function context() { const instructionId=`issue-8603-${sequence++}`; return { instructionId, origin:{ instructionIds:[instructionId] } }; }
function lift(mnemonic, ops) { return liftArm64AtomicEffects({ mnemonic, ops }, context()); }
function rmwOrderings(b) {
  const intrinsic = b.operations.find((op) => op.kind === 'intrinsic');
  return {
    read:intrinsic.effectSummary.memoryRead.accesses[0].ordering,
    write:intrinsic.effectSummary.memoryWrite.accesses[0].ordering,
    summary:b.metadata.ordering,
    completeness:b.completeness,
  };
}
function loadOrdering(b) {
  return {
    read:b.operations.find((op) => op.kind === 'memory-read').access.ordering,
    completeness:b.completeness,
  };
}

// #1 LSE RMW/SWP: Rt == ZR suppresses the architectural acquire edge, release half preserved.
assert.deepEqual(rmwOrderings(lift('ldadda', [x(0), xzr(), mem(x(1))])), { read:'relaxed', write:'relaxed', summary:'relaxed', completeness:'exact-with-intrinsic' });
assert.deepEqual(rmwOrderings(lift('ldaddal', [x(0), xzr(), mem(x(1))])), { read:'relaxed', write:'release', summary:'release', completeness:'exact-with-intrinsic' });
assert.deepEqual(rmwOrderings(lift('swpa', [x(0), xzr(), mem(x(1))])), { read:'relaxed', write:'relaxed', summary:'relaxed', completeness:'exact-with-intrinsic' });
assert.deepEqual(rmwOrderings(lift('swpal', [x(0), xzr(), mem(x(1))])), { read:'relaxed', write:'release', summary:'release', completeness:'exact-with-intrinsic' });
assert.deepEqual(rmwOrderings(lift('ldaddab', [w(0), wzr(), mem(x(1))])), { read:'relaxed', write:'relaxed', summary:'relaxed', completeness:'exact-with-intrinsic' });

// #2 CAS: Rs == ZR suppresses the architectural acquire edge, release half preserved.
assert.deepEqual(rmwOrderings(lift('casa', [xzr(), x(0), mem(x(1))])), { read:'relaxed', write:'relaxed', summary:'relaxed', completeness:'exact-with-intrinsic' });
assert.deepEqual(rmwOrderings(lift('casal', [xzr(), x(0), mem(x(1))])), { read:'relaxed', write:'release', summary:'release', completeness:'exact-with-intrinsic' });

// #3 exclusive acquire load: ZR destination carries no acquire semantics.
assert.deepEqual(loadOrdering(lift('ldaxr', [xzr(), mem(x(1))])), { read:'relaxed', completeness:'exact-with-intrinsic' });
assert.deepEqual(loadOrdering(lift('ldaxrb', [wzr(), mem(x(1))])), { read:'relaxed', completeness:'exact-with-intrinsic' });
assert.deepEqual(loadOrdering(lift('ldaxrh', [wzr(), mem(x(1))])), { read:'relaxed', completeness:'exact-with-intrinsic' });

// Exclusive monitor set/clear semantics remain independent of destination discard.
assert.ok(lift('ldaxr', [xzr(), mem(x(1))]).operations.some((op) => op.kind === 'intrinsic' && op.intrinsicId === 'arm64.exclusive-monitor-set'));

// Controls: non-ZR keeps acquire/acq-rel exactly as before.
assert.deepEqual(rmwOrderings(lift('ldadda', [x(0), x(2), mem(x(1))])), { read:'acquire', write:'relaxed', summary:'acquire', completeness:'exact-with-intrinsic' });
assert.deepEqual(rmwOrderings(lift('casal', [x(0), x(2), mem(x(1))])), { read:'acquire', write:'release', summary:'acq-rel', completeness:'exact-with-intrinsic' });
assert.deepEqual(loadOrdering(lift('ldaxr', [x(0), mem(x(1))])), { read:'acquire', completeness:'exact-with-intrinsic' });

console.log('issue-8603 arm64 atomic ZR acquire: PASS');
