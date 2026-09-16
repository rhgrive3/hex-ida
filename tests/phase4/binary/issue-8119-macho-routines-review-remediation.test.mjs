import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMachO } from '../../../js/binary/macho.js';
import { machoInstructionUnit } from '../../../js/binary/macho-instruction-unit.js';

const CPU_PPC = 18;
const LC_SEGMENT = 0x1;
const LC_ROUTINES = 0x11;

function put(bytes, offset, text) { bytes.set(Buffer.from(text), offset); }

function macho32({
  cpu = CPU_PPC,
  initAddress = 0x1180,
  paddingCommands = 0,
} = {}) {
  const segmentSize = 56;
  const routineSize = 40;
  const sizeofcmds = segmentSize + paddingCommands * 8 + routineSize;
  const bytes = new Uint8Array(Math.max(0x400, 28 + sizeofcmds));
  const v = new DataView(bytes.buffer);
  bytes.set([0xce, 0xfa, 0xed, 0xfe], 0);
  v.setInt32(4, cpu, true);
  v.setInt32(8, 0, true);
  v.setUint32(12, 6, true); // MH_DYLIB
  v.setUint32(16, 2 + paddingCommands, true);
  v.setUint32(20, sizeofcmds, true);

  let p = 28;
  v.setUint32(p, LC_SEGMENT, true);
  v.setUint32(p + 4, segmentSize, true);
  put(bytes, p + 8, '__TEXT');
  v.setUint32(p + 24, 0x1000, true);
  v.setUint32(p + 28, 0x1000, true);
  v.setUint32(p + 32, 0, true);
  v.setUint32(p + 36, 0x400, true);
  v.setInt32(p + 40, 5, true);
  v.setInt32(p + 44, 5, true);
  p += segmentSize;

  for (let i = 0; i < paddingCommands; i++) {
    v.setUint32(p, 0x70000000 + i, true);
    v.setUint32(p + 4, 8, true);
    p += 8;
  }

  v.setUint32(p, LC_ROUTINES, true);
  v.setUint32(p + 4, routineSize, true);
  v.setUint32(p + 8, initAddress, true);
  v.setUint32(p + 12, 3, true);

  const off = initAddress - 0x1000;
  if (off >= 0 && off + 4 <= bytes.length) v.setUint32(off, 0x4e800020, true); // blr
  return bytes;
}

const routineSeed = (image, address) => image.functions.find(
  (f) => f.address === BigInt(address) && (f.source === 'routines' || f.sources?.includes('routines')),
);

test('#8119 PPC routines use the shared four-byte instruction unit', () => {
  const aligned = parseMachO(macho32({ initAddress:0x1180 }));
  assert.equal(aligned.arch, 'ppc');
  assert.equal(aligned.metadata.routines?.[0]?.reason, null);
  assert.equal(aligned.metadata.routines?.[0]?.promoted, true);
  assert.equal(machoInstructionUnit(aligned.arch), 4n, 'shared instruction-unit authority models PPC as fixed-width');
  assert.ok(routineSeed(aligned, 0x1180));

  const misaligned = parseMachO(macho32({ initAddress:0x1182 }));
  assert.equal(misaligned.metadata.routines?.[0]?.reason, 'misaligned');
  assert.equal(misaligned.metadata.routines?.[0]?.promoted, false);
  assert.equal(routineSeed(misaligned, 0x1182), undefined);
  assert.ok(misaligned.metadata.machoMetadata.reasons.includes('routines:initializer-misaligned'));
});

test('#8119 unsupported Mach-O ISA cannot mint an exact routine function start', () => {
  const image = parseMachO(macho32({ cpu:0x12345678, initAddress:0x1180 }));
  assert.match(image.arch, /^cpu-/);
  assert.equal(image.metadata.routines?.[0]?.reason, 'unsupported-isa');
  assert.equal(image.metadata.routines?.[0]?.promoted, false);
  assert.equal(machoInstructionUnit(image.arch), null, 'shared instruction-unit authority fails closed for unknown ISA');
  assert.equal(routineSeed(image, 0x1180), undefined);
  assert.ok(image.metadata.machoMetadata.reasons.includes('routines:initializer-unsupported-isa'));
});

test('#8119 post-core routines traversal charges every scanned command to the shared budget', () => {
  const paddingCommands = 8;
  const coreCommandCount = 2 + paddingCommands;
  const image = parseMachO(macho32({ paddingCommands }), {
    metadataLimits:{ operations:coreCommandCount + 2 },
  });
  assert.equal(image.metadata.routines, undefined, 'routines command beyond the post-pass scan budget must not be reached');
  assert.equal(routineSeed(image, 0x1180), undefined);
  assert.equal(image.metadata.machoMetadata.complete, false);
  assert.ok(
    image.metadata.machoMetadata.reasons.includes('budget:routines-command-scan:operations'),
    'the second traversal must stop through the shared operation budget',
  );
});

test('#8119 zero-record and pre-aborted shared budgets stop before post-core routine publication', () => {
  const zero = parseMachO(macho32({ paddingCommands:4 }), { metadataLimits:{ records:0 } });
  assert.equal(zero.metadata.routines, undefined);
  assert.equal(routineSeed(zero, 0x1180), undefined);
  assert.ok(zero.metadata.machoMetadata.reasons.includes('budget:load-command:records'));

  const controller = new AbortController();
  controller.abort();
  const aborted = parseMachO(macho32({ paddingCommands:4 }), { signal:controller.signal });
  assert.equal(aborted.metadata.routines, undefined);
  assert.equal(routineSeed(aborted, 0x1180), undefined);
  assert.ok(aborted.metadata.machoMetadata.reasons.includes('budget:aborted'));
});
