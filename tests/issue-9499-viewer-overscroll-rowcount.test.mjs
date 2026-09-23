import assert from 'node:assert/strict';
import test from 'node:test';
import { CodeViewer } from '../js/viewer.js';

function classList(){ return { toggle(){}, add(){}, remove(){} }; }
function installDom(){
  globalThis.__HEX_UI_ROOT__ = { classList: classList(), style: { setProperty(){} } };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
}

test('#9499 overscroll cannot start pool cleanup at a negative index', () => {
  installDom();
  const viewport = { clientHeight: 240, scrollTop: 300, classList: classList(), addEventListener(){}, removeEventListener(){} };
  const backend = { platformInfo:{capability:{architecture:'arm64',fixedInstructionSize:4,capabilities:{decode:'external'}}}, legacyInfo:null };
  const viewer = new CodeViewer({ viewport, rows:{style:{height:''},appendChild(){}}, backend });
  viewer.region = { id:'text', vmAddr:0x1000n, size:20n, disasm:true, capability:backend.platformInfo.capability };
  viewer.totalRows = 5;
  viewer.totalRowsBig = 5n;
  viewer.windowRows = 5;
  viewer.baseRow = 0;
  viewer.rowH = 24;
  viewer.pool = [{ style: { display:'' } }];
  viewer._ensurePool = () => {};
  viewer._renderFixed = () => {};
  viewer._updateScrubber = () => {};
  assert.doesNotThrow(() => viewer._render());
  assert.equal(viewer.pool[0].style.display, 'none');
  viewer.dispose();
});
