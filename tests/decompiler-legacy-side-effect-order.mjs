import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { decompile as decompileLegacy, decompiledText } from '../js/decompile-legacy.js';

function render(lines) {
  const raw = lines.map((text, row) => {
    const split = text.indexOf(' ');
    return {
      row,
      address: 0x1000n + BigInt(row * 4),
      mn: split < 0 ? text : text.slice(0, split),
      ops: split < 0 ? '' : text.slice(split + 1),
    };
  });
  const byAddress = new Map(raw.map((item) => [item.address.toString(), item.row]));
  const rowOfAddress = (addr) => byAddress.get(BigInt(addr).toString()) ?? null;
  const addrOfRow = (row) => raw[row]?.address ?? null;
  const model = buildSemanticModel(raw, { startRow:0, endRow:raw.length - 1, rowOfAddress, addrOfRow });
  return decompiledText(decompileLegacy(model, {
    addr:0x1000n, rowOfAddress, addrOfRow, beginner:false,
    symbolFor:(addr) => BigInt(addr) === 0x2000n ? 'mutate' : null,
  }));
}

const acrossCall = render([
  'ldr x19, [x0]',
  'bl 0x2000',
  'str x19, [x1]',
  'ret',
]);
assert.match(acrossCall, /x19\s*=\s*\*\(uint64 \*\)\(a1\);/);
assert.ok(acrossCall.indexOf('x19 =') < acrossCall.indexOf('(*func)'), acrossCall);
assert.match(acrossCall, /\*\(uint64 \*\)\(x1\)\s*=\s*x19;/);
assert.doesNotMatch(acrossCall, /\(\*func\)[^]*\*\(uint64 \*\)\(x1\)\s*=\s*\*\(uint64 \*\)\(a1\)/);

const derivedAcrossCall = render([
  'ldr x19, [x0]',
  'add x19, x19, #1',
  'bl 0x2000',
  'str x19, [x1]',
  'ret',
]);
assert.match(derivedAcrossCall, /x19\s*=\s*\*\(uint64 \*\)\(a1\) \+ 1;/);
assert.ok(derivedAcrossCall.indexOf('x19 =') < derivedAcrossCall.indexOf('(*func)'), derivedAcrossCall);
assert.match(derivedAcrossCall, /\*\(uint64 \*\)\(x1\)\s*=\s*x19;/);

const acrossAliasingStore = render([
  'ldr x19, [x0]',
  'str x2, [x0]',
  'str x19, [x1]',
  'ret',
]);
assert.match(acrossAliasingStore, /x19\s*=\s*\*\(uint64 \*\)\(a1\);/);
assert.ok(acrossAliasingStore.indexOf('x19 =') < acrossAliasingStore.indexOf('*(uint64 *)(x0)'), acrossAliasingStore);
assert.match(acrossAliasingStore, /\*\(uint64 \*\)\(x1\)\s*=\s*x19;/);

const pureAcrossCall = render([
  'mov x19, #5',
  'bl 0x2000',
  'str x19, [x1]',
  'ret',
]);
assert.doesNotMatch(pureAcrossCall, /x19\s*=\s*5;/);
assert.match(pureAcrossCall, /\*\(uint64 \*\)\(x1\)\s*=\s*5;/);

console.log('decompiler-legacy-side-effect-order: ok');
