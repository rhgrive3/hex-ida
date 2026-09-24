#!/usr/bin/env node
/*
 * Diagnosis for the switch-render provenance completeness regression seen on the
 * public path after the C-output closure started injecting declaration lines.
 * Replicates the phase8 fixture (publicPath:true, name 'local_ff'), rebuilds
 * render provenance and reports the reasons plus the incomplete entities.
 *
 * Diagnosis only; no product mutation.
 */
import { buildSemanticModel } from '../../../js/blocks.js';
import { decompile } from '../../../js/decompile.js';
import { buildRenderProvenance, validateRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';

const raw = [
  { row:0, address:0x1000n, mn:'br', ops:'x8' },
  { row:1, address:0x1004n, mn:'mov', ops:'x0, #1' },
  { row:2, address:0x1008n, mn:'ret', ops:'' },
  { row:3, address:0x100cn, mn:'mov', ops:'x0, #2' },
  { row:4, address:0x1010n, mn:'ret', ops:'' },
  { row:5, address:0x1014n, mn:'mov', ops:'x0, #3' },
  { row:6, address:0x1018n, mn:'ret', ops:'' },
];
const rowOfAddress = (addr) => raw.find((inst) => inst.address === BigInt(addr))?.row ?? null;
const addrOfRow = (row) => raw[row]?.address ?? null;
const model = buildSemanticModel(raw, { startRow:0, endRow:6, rowOfAddress, addrOfRow });
const descriptor = { row:0, expr:'local_ff', cases:[{ value:0, address:0x1004n }, { value:1, address:0x100cn }], defaultAddress:0x1014n };
const opts = { addr:0x1000n, rowOfAddress, addrOfRow, beginner:false, deterministicTransforms:true, jumpTables:[descriptor] };
const result = decompile(model, opts);

console.log('--- public lines');
for (const [index, line] of result.lines.entries()) {
  console.log(String(index).padStart(3), line.kind, JSON.stringify(line.text), 'row=', line.row, 'addr=', line.addr, 'src=', line.source ? 'yes' : 'no');
}
const map = buildRenderProvenance({ result, snapshotId:'switch-fixture' });
console.log('--- build reasons', JSON.stringify(map.reasons), 'counts', JSON.stringify(map.counts));
console.log('--- validation', validateRenderProvenance(map, { snapshotId:'switch-fixture' }).state,
  JSON.stringify(validateRenderProvenance(map, { snapshotId:'switch-fixture' }).reasons));
for (const entity of Object.values(map.entities)) {
  if (!entity.complete) console.log('incomplete', entity.entityKey, JSON.stringify(result.lines[entity.lineIndex]?.text), JSON.stringify(entity.reasons));
}
