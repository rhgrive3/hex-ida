import assert from 'node:assert/strict';
import { buildSemanticModel } from '../../js/blocks.js';
import { decompile } from '../../js/decompile.js';

function render(rows, opts = {}) {
  const raw = rows.map((x, row) => ({ row, address: 0x1000n + BigInt(row * 4), ...x }));
  const byAddr = new Map(raw.map((x) => [x.address.toString(), x.row]));
  const rowOfAddress = (addr) => byAddr.get(BigInt(addr).toString()) ?? null;
  const addrOfRow = (row) => raw[row]?.address ?? null;
  const model = buildSemanticModel(raw, { startRow: 0, endRow: raw.length - 1, rowOfAddress, addrOfRow });
  return decompile(model, { addr: 0x1000n, rowOfAddress, addrOfRow, beginner: false, ...opts }).pseudocode;
}

// A memory value read before an unknown call must be captured before the call.
// Re-reading it after the call changes meaning if the callee mutates the source.
const acrossCall = render([
  { mn: 'ldr', ops: 'x19, [x0]' },
  { mn: 'bl',  ops: '0x2000' },
  { mn: 'str', ops: 'x19, [x1]' },
  { mn: 'ret', ops: '' },
], { symbolFor: (addr) => BigInt(addr) === 0x2000n ? 'mutate' : null });
assert.match(acrossCall, /load_\d+\s*=\s*a1->field_0;/);
assert.ok(acrossCall.search(/load_\d+ =/) < acrossCall.indexOf('mutate('), acrossCall);
assert.match(acrossCall, /mutate[^]*\n\s*[^=]+\s*=\s*load_\d+;/);
assert.doesNotMatch(acrossCall, /mutate[^]*a2->field_0\s*=\s*a1->field_0;/);

// Same aliasing hazard for an intervening store: the first load observes the old value.
const acrossStore = render([
  { mn: 'ldr', ops: 'x19, [x0]' },
  { mn: 'str', ops: 'x2, [x0]' },
  { mn: 'str', ops: 'x19, [x1]' },
  { mn: 'ret', ops: '' },
]);
assert.match(acrossStore, /load_\d+\s*=\s*a1->field_0;/);
assert.ok(acrossStore.search(/load_\d+ =/) < acrossStore.indexOf('a1->field_0 = a3'), acrossStore);
assert.match(acrossStore, /a2->field_0\s*=\s*load_\d+;/);
assert.doesNotMatch(acrossStore, /a2->field_0\s*=\s*a1->field_0;/);

// A read-modify-write is still a memory-order barrier. Re-rendering the
// pre-store load after writing the derived value would turn old+1 into new+1
// and would also invent a second MMIO/faulting read.
const rmwAcrossStore = render([
  { mn: 'ldr', ops: 'x19, [x0]' },
  { mn: 'add', ops: 'x19, x19, #1' },
  { mn: 'str', ops: 'x19, [x0]' },
  { mn: 'str', ops: 'x19, [x1]' },
  { mn: 'ret', ops: '' },
]);
assert.match(rmwAcrossStore, /load_\d+\s*=\s*a1->field_0;/);
assert.match(rmwAcrossStore, /a1->field_0\s*=\s*load_\d+ \+ 1;/);
assert.match(rmwAcrossStore, /a2->field_0\s*=\s*load_\d+ \+ 1;/);
assert.doesNotMatch(rmwAcrossStore, /a2->field_0\s*=\s*a1->field_0 \+ 1;/);

// Do not pessimize pure values: constants/arithmetic can still move across a call safely.
const pureAcrossCall = render([
  { mn: 'mov', ops: 'x19, #5' },
  { mn: 'bl',  ops: '0x2000' },
  { mn: 'str', ops: 'x19, [x1]' },
  { mn: 'ret', ops: '' },
], { symbolFor: (addr) => BigInt(addr) === 0x2000n ? 'mutate' : null });
assert.doesNotMatch(pureAcrossCall, /x19\s*=\s*5;/);
assert.match(pureAcrossCall, /mutate[^]*\n\s*[^=]+\s*=\s*5;/);

// The ordering dependency is transitive through pure arithmetic.
const derivedAcrossCall = render([
  { mn: 'ldr', ops: 'x19, [x0]' },
  { mn: 'add', ops: 'x19, x19, #1' },
  { mn: 'bl',  ops: '0x2000' },
  { mn: 'str', ops: 'x19, [x1]' },
  { mn: 'ret', ops: '' },
], { symbolFor: (addr) => BigInt(addr) === 0x2000n ? 'mutate' : null });
assert.match(derivedAcrossCall, /load_\d+\s*=\s*a1->field_0;/);
assert.ok(derivedAcrossCall.search(/load_\d+ =/) < derivedAcrossCall.indexOf('mutate('), derivedAcrossCall);
assert.match(derivedAcrossCall, /mutate[^]*\n\s*[^=]+\s*=\s*load_\d+ \+ 1;/);
assert.doesNotMatch(derivedAcrossCall, /mutate[^]*=\s*a1->field_0 \+ 1;/);

// A compare may consume the load before the barrier while the branch consumes
// the derived flags after it. The transitive dependency must still pin the load.
const branchAcrossStore = render([
  { mn: 'ldr', ops: 'x19, [x0]' },
  { mn: 'cmp', ops: 'x19, #0' },
  { mn: 'str', ops: 'x2, [x0]' },
  { mn: 'b.eq', ops: '0x1018' },
  { mn: 'mov', ops: 'x0, #1' },
  { mn: 'ret', ops: '' },
  { mn: 'mov', ops: 'x0, #2' },
  { mn: 'ret', ops: '' },
], { returnType: 'uint64' });
assert.match(branchAcrossStore, /load_\d+\s*=\s*a1->field_0;/);
assert.ok(branchAcrossStore.search(/load_\d+ =/) < branchAcrossStore.indexOf('a1->field_0 = a3'), branchAcrossStore);
assert.match(branchAcrossStore, /if \([^\n]*load_\d+[^\n]*== 0\)/);
assert.doesNotMatch(branchAcrossStore, /if \([^\n]*a1->field_0[^\n]*== 0\)/);

// A pre-call memory observation that becomes the function return value must
// remain captured before the call rather than being re-read at ret.
const returnAcrossCall = render([
  { mn: 'ldr', ops: 'x19, [x0]' },
  { mn: 'bl',  ops: '0x2000' },
  { mn: 'mov', ops: 'x0, x19' },
  { mn: 'ret', ops: '' },
], { symbolFor: (addr) => BigInt(addr) === 0x2000n ? 'mutate' : null, returnType: 'uint64' });
assert.match(returnAcrossCall, /load_\d+\s*=\s*a1->field_0;/);
assert.ok(returnAcrossCall.search(/load_\d+ =/) < returnAcrossCall.indexOf('mutate('), returnAcrossCall);
assert.match(returnAcrossCall, /return load_\d+;/);
assert.doesNotMatch(returnAcrossCall, /return a1->field_0;/);

// Even without an explicit call/store barrier, delaying a load into a successor
// block changes whether that memory observation happens (fault/MMIO semantics).
// Keep the observation in the defining block when its value crosses a CFG edge.
const acrossBlock = render([
  { mn: 'ldr', ops: 'x19, [x0]' },
  { mn: 'cbz', ops: 'x1, 0x1010' },
  { mn: 'str', ops: 'x19, [x2]' },
  { mn: 'ret', ops: '' },
  { mn: 'ret', ops: '' },
]);
assert.match(acrossBlock, /load_\d+\s*=\s*a1->field_0;/);
assert.match(acrossBlock, /a3->field_0\s*=\s*load_\d+;/);
assert.doesNotMatch(acrossBlock, /a3->field_0\s*=\s*a1->field_0;/);

console.log('decompiler-side-effect-order: ok');
