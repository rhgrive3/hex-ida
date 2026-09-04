import assert from 'node:assert/strict';
import { CodeViewer } from '../js/viewer.js';

function makeViewer(mode = 'hex', fixedInstructionSize = 4) {
  const viewer = Object.create(CodeViewer.prototype);
  viewer.region = {
    id:'cstring',
    vmAddr:0x1000n,
    size:0x20n,
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
  viewer.totalRows = mode === 'hex' ? 8 : Math.ceil(0x20 / fixedInstructionSize);
  viewer.windowRows = viewer.totalRows;
  viewer.maxBase = 0;
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

  let navigated = null;
  viewer.goToRow = (row, where) => { navigated = { row, where }; };
  assert.equal(viewer.goToAddress(0x1003n), true);
  assert.deepEqual(navigated, { row:0, where:'third' });
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
