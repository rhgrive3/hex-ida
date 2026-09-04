import assert from 'node:assert/strict';
import { CodeViewer } from '../js/viewer.js';

function makeViewer(mode = 'hex') {
  const viewer = Object.create(CodeViewer.prototype);
  viewer.region = {
    id:'cstring',
    vmAddr:0x1000n,
    size:0x20n,
    disasm:true,
    capability:{
      architecture:'arm64',
      fixedInstructionSize:4,
      capabilities:{ decode:'exact' },
    },
  };
  viewer.mode = mode;
  viewer.backend = null;
  viewer.variableRows = Object.freeze([]);
  viewer.variableError = null;
  viewer.totalRows = 8;
  viewer.windowRows = 8;
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

{
  const viewer = makeViewer('asm');
  assert.equal(viewer.rowOfAddress(0x1000n), 0);
  assert.equal(viewer.rowOfAddress(0x1001n), null);
}

console.log('Issue #4183 viewer hex navigation regression passed');
