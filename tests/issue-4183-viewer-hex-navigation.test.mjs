import assert from 'node:assert/strict';
import { CodeViewer } from '../js/viewer.js';

function makeViewer(mode = 'hex', fixedInstructionSize = 4, {
  size = 0x20n,
  windowRows = null,
} = {}) {
  const viewer = Object.create(CodeViewer.prototype);
  viewer.region = {
    id:'cstring',
    vmAddr:0x1000n,
    size,
    disasm:true,
    capability:{
      architecture:'arm64',
      fixedInstructionSize,
      capabilities:{ decode:'exact' },
    },
  };
  viewer.mode = mode;
  viewer.backend = null;
  viewer.variableRows = Object.freeze([]);
  viewer.variableError = null;
  viewer.totalRows = mode === 'hex'
    ? Number((size + 3n) / 4n)
    : Number((size + BigInt(fixedInstructionSize - 1)) / BigInt(fixedInstructionSize));
  viewer.windowRows = windowRows ?? viewer.totalRows;
  viewer.maxBase = Math.max(0, viewer.totalRows - viewer.windowRows);
  viewer.baseRow = 0;
  viewer.rowH = 24;
  viewer.vp = { clientHeight:240, scrollTop:0 };
  viewer.invalidate = () => {};
  return viewer;
}

{
  const viewer = makeViewer('hex');
  assert.equal(viewer.rowOfAddress(0x1000n), 0);
  assert.equal(viewer.rowOfAddress(0x1001n), 0);
  assert.equal(viewer.rowOfAddress(0x1003n), 0);
  assert.equal(viewer.rowOfAddress(0x1004n), 1);
  assert.equal(viewer.rowOfAddress(0x101fn), 7);
  assert.equal(viewer.rowOfAddress(0x1020n), null);
  assert.equal(viewer.rowAddress(viewer.rowOfAddress(0x1003n)), 0x1000n);
}

{
  const viewer = makeViewer('hex', 4, { size:0x400n, windowRows:40 });
  let navigated = null;
  const goToRow = viewer.goToRow;
  viewer.goToRow = function (row, where) {
    navigated = { row, where };
    return goToRow.call(this, row, where);
  };

  assert.equal(viewer.goToAddress(0x1183n), true);
  assert.deepEqual(navigated, { row:96, where:'third' });
  assert.equal(viewer.baseRow, 76);
  assert.equal(viewer.vp.scrollTop, 408);
  assert.equal(viewer.topRow(), 93);
  assert.equal(viewer.rowAddress(96), 0x1180n);
}

for (const fixedInstructionSize of [2, 8]) {
  const viewer = makeViewer('hex', fixedInstructionSize);
  assert.equal(viewer.rowOfAddress(0x1003n), 0);
  assert.equal(viewer.rowOfAddress(0x1004n), 1);
  assert.equal(viewer.rowAddress(1), 0x1004n);
}

{
  const viewer = makeViewer('asm');
  assert.equal(viewer.rowOfAddress(0x1000n), 0);
  assert.equal(viewer.rowOfAddress(0x1001n), null);
}

{
  const viewer = makeViewer('asm', 8);
  assert.equal(viewer.rowOfAddress(0x1004n), null);
  assert.equal(viewer.rowOfAddress(0x1008n), 1);
}

console.log('Issue #4183 viewer hex navigation regression passed');
