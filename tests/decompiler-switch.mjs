import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { decompile } from '../js/decompile.js';
import { structureKnownSwitches } from '../js/decompiler/switch.js';

const raw = [
  { row: 0, address: 0x1000n, mn: 'br',  ops: 'x8' },
  { row: 1, address: 0x1004n, mn: 'mov', ops: 'x0, #1' },
  { row: 2, address: 0x1008n, mn: 'ret', ops: '' },
  { row: 3, address: 0x100cn, mn: 'mov', ops: 'x0, #2' },
  { row: 4, address: 0x1010n, mn: 'ret', ops: '' },
  { row: 5, address: 0x1014n, mn: 'mov', ops: 'x0, #3' },
  { row: 6, address: 0x1018n, mn: 'ret', ops: '' },
];
const byAddr = new Map(raw.map((x) => [x.address.toString(), x.row]));
const rowOfAddress = (addr) => byAddr.get(BigInt(addr).toString()) ?? null;
const addrOfRow = (row) => raw[row]?.address ?? null;
const model = buildSemanticModel(raw, { startRow: 0, endRow: raw.length - 1, rowOfAddress, addrOfRow });

const result = decompile(model, {
  addr: 0x1000n, rowOfAddress, addrOfRow, beginner: false,
  jumpTables: [{
    row: 0,
    expr: 'kind',
    cases: [
      { value: 0, address: 0x1004n },
      { value: 1, address: 0x100cn },
    ],
    defaultAddress: 0x1014n,
  }],
});

assert.match(result.pseudocode, /switch \(kind\)/);
assert.match(result.pseudocode, /case 0:\s*\n\s*return x0;/);
assert.match(result.pseudocode, /case 1:\s*\n\s*return x0;/i);
assert.match(result.pseudocode, /default:\s*\n\s*return x0;/);
assert.equal((result.pseudocode.match(/\bgoto\b/g) || []).length, 0);
assert.ok(result.evidence.some((e) => e.reason === 'verified jump-table/switch descriptor'));

// With no verified descriptor the same indirect branch must remain explicit,
// never be invented as a switch.
const unknown = decompile(model, { addr: 0x1000n, rowOfAddress, addrOfRow, beginner: false });
assert.equal(/switch\s*\(/.test(unknown.pseudocode), false);
assert.match(unknown.pseudocode, /br x8|__asm/);



// When verified switch targets already have independent rendered terminal
// bodies, the switch renderer can safely absorb them instead of keeping case
// gotos.  The transformation must stay fail-closed if any target has another
// explicit entry.
function terminalSwitchFixture(extraLines = []) {
  return {
    lines: [
      { kind:'stmt', row:0, indent:1, text:'__asm("br x8");' },
      ...extraLines,
      { kind:'label', row:1, indent:1, text:'loc_1004:' },
      { kind:'stmt', row:2, indent:1, text:'return 1;' },
      { kind:'label', row:3, indent:1, text:'loc_100C:' },
      { kind:'stmt', row:4, indent:1, text:'return 2;' },
      { kind:'label', row:5, indent:1, text:'loc_1014:' },
      { kind:'stmt', row:6, indent:1, text:'return 3;' },
      { kind:'ctrl', row:null, indent:0, text:'}' },
    ],
    ir:{ blocks:[{ startRow:0 }, { startRow:1 }, { startRow:3 }, { startRow:5 }], instructions:[] },
    evidence:[], warnings:[], ctx:{},
  };
}
const terminalDescriptor = { row:0, expr:'kind', cases:[
  { value:0, address:0x1004n }, { value:1, address:0x100cn },
], defaultAddress:0x1014n };
const terminalModel = { instructions:[
  { row:0, address:0x1000n }, { row:1, address:0x1004n }, { row:3, address:0x100cn }, { row:5, address:0x1014n },
] };
const terminalSwitch = terminalSwitchFixture();
structureKnownSwitches(terminalSwitch, terminalModel, { switches:[terminalDescriptor] });
assert.match(terminalSwitch.pseudocode, /case 0:\s*\n\s*return 1;/);
assert.match(terminalSwitch.pseudocode, /case 1:\s*\n\s*return 2;/);
assert.match(terminalSwitch.pseudocode, /default:\s*\n\s*return 3;/);
assert.equal((terminalSwitch.pseudocode.match(/\bgoto\b/g) || []).length, 0);
assert.equal((terminalSwitch.pseudocode.match(/loc_1004:|loc_100C:|loc_1014:/g) || []).length, 0);

const externallyEntered = terminalSwitchFixture([{ kind:'stmt', row:0, indent:1, text:'if (flag) goto loc_1004;' }]);
structureKnownSwitches(externallyEntered, terminalModel, { switches:[terminalDescriptor] });
assert.match(externallyEntered.pseudocode, /case 0: goto loc_1004;/);
assert.match(externallyEntered.pseudocode, /loc_1004:/);

console.log('decompiler-switch: ok');
