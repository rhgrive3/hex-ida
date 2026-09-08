import assert from 'node:assert/strict';
import test from 'node:test';

import { parseGoFunctions } from '../js/metadata/go.js';

test('#5861 entries past the buffer end are not reported as scanned', () => {
  const buf = new Uint8Array(16);
  const r = parseGoFunctions(buf, {
    nfunc: 100, ftabOff: 16, version: '1.20+', ptrSize: 8, little: true,
    textStart: 0n, pclnOff: 0, funcnametabOff: 0,
  });
  assert.equal(r.completeness.declared, 100);
  assert.equal(r.completeness.scanned, 1, 'only the failed entry was attempted');
  assert.equal(r.completeness.unreadableEntries, 1);
  assert.equal(r.completeness.complete, false);
});

test('#5861 mid-table truncation reports only the entries actually examined', () => {
  // ftab holds 3 declared entries but the buffer ends mid-ftab: entry 2's slot
  // (40..48) crosses the 44-byte buffer, so the loop must break after
  // examining exactly 3 slots (2 parsed + 1 unreadable).
  const buf = new Uint8Array(44);
  const dv = new DataView(buf.buffer);
  buf[0] = 0x41; buf[1] = 0; buf[8] = 0x42; buf[9] = 0; // nametab: 'A\0'@0, 'B\0'@8
  dv.setUint32(16, 0, true);   // _func[0]: entryOff (unused here)
  dv.setInt32(20, 0, true);    // _func[0]: nameOff 0 -> 'A'
  dv.setUint32(24, 0, true);   // ftab[0]: entryOff 0
  dv.setUint32(28, 0, true);   // ftab[0]: funcOff 0   -> _func at 16
  dv.setUint32(32, 1, true);   // ftab[1]: entryOff 1
  dv.setUint32(36, 8, true);   // ftab[1]: funcOff 8   -> _func at 24
  dv.setInt32(28, 8, true);    // _func[1] overlaps ftab[0]: nameOff 8 -> 'B'
  const r = parseGoFunctions(buf, {
    nfunc: 3, ftabOff: 24, version: '1.20+', ptrSize: 8, little: true,
    textStart: 0n, pclnOff: 16, funcnametabOff: 0,
  });
  assert.equal(r.completeness.scanned, 3, '2 parsed plus 1 attempted-unreadable');
  assert.equal(r.completeness.parsed, 2);
  assert.equal(r.completeness.unreadableEntries, 1);
  assert.equal(r.completeness.complete, false);
});

test('#5861 fully readable tables keep scanned === declared and complete', () => {
  const buf = new Uint8Array(16 + 8 + 16);
  const dv = new DataView(buf.buffer);
  dv.setUint32(16, 0, true); dv.setUint32(20, 24, true);
  dv.setInt32(28, 0, true);
  buf[0] = 0x41; buf[1] = 0;
  const r = parseGoFunctions(buf, {
    nfunc: 1, ftabOff: 16, version: '1.20+', ptrSize: 8, little: true,
    textStart: 0n, pclnOff: 0, funcnametabOff: 0,
  });
  assert.equal(r.completeness.scanned, 1);
  assert.equal(r.completeness.complete, true);
  assert.equal(r.functions[0].name, 'A');
});
