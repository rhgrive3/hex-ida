// Actual WebKit/production-DOM regression: the explicit local recovery action
// must publish real binary evidence and must not reopen a no-progress result.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {webkit} from 'playwright';
import {openCxxFixture} from './phase7/cxx/fixtures/open.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fixture=openCxxFixture('game-rtti-o0');
assert.ok(fixture.available,fixture.reason);
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost'),relative=decodeURIComponent(url.pathname).replace(/^\/+/, '')||'index.html';
  const file=path.resolve(root,relative);
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
  const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm'}[path.extname(file)]||'application/octet-stream';
  res.writeHead(200,{'content-type':mime});fs.createReadStream(file).pipe(res);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await webkit.launch();
try {
  const page=await browser.newPage({locale:'en-US',viewport:{width:1024,height:768}});
  const errors=[];let remoteCalls=0;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://api.openjev.sh/**',route=>{remoteCalls++;return route.abort();});
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  await page.waitForFunction(()=>Boolean(window.__app),null,{timeout:30000});
  await page.evaluate(async bytes=>{
    await window.__app.openFile(new File([new Uint8Array(bytes)],'cxx-ui-fixture.elf'));
    await window.__app.ensureFunctions(window.__app.codeRegion());
    await window.__app.ensureProgram();
  },Array.from(fixture.bytes));
  const action=page.getByText(/^(Find member candidates in related routines|関連する処理から値の候補を探す)$/);
  const open=async query=>page.evaluate(async query=>{
    const {showCandidates}=await import('/js/panels-base.js');
    const {parseGoal}=await import('/js/goals.js');
    showCandidates(window.__app,parseGoal(query));
  },query);
  await open('unrelated musical tune');
  await action.waitFor({state:'visible',timeout:30000});
  await page.evaluate(()=>{window.__recoverySheet=document.querySelector('#overlays .sheet:last-child');});
  await action.click();
  await page.getByText(/^(No related C\+\+ routines could be identified\.|関連するC\+\+処理を特定できませんでした。)$/).waitFor({timeout:15000});
  assert.equal(await page.evaluate(()=>window.__recoverySheet.isConnected),true,'no-progress must retain the original sheet');
  await page.evaluate(async()=>{const {closeAllSheets}=await import('/js/ui.js');closeAllSheets();});
  await open('player health');
  await action.waitFor({state:'visible',timeout:30000});
  await action.click();
  await page.waitForFunction(async()=>{
    const {cxxMemberIndexForApp}=await import('/js/analysis/query/app-adapter.js');
    return (cxxMemberIndexForApp(window.__app)?.fieldCount??0)>0;
  },null,{timeout:30000});
  const fields=await page.evaluate(async()=>{
    const {cxxMemberIndexForApp}=await import('/js/analysis/query/app-adapter.js');
    return [...cxxMemberIndexForApp(window.__app).classes.values()].flatMap(c=>c.ivars.map(f=>({anonymous:f.anonymous,offset:f.offset,size:f.size})));
  });
  assert.ok(fields.length>0);assert.ok(fields.every(f=>f.anonymous&&f.offset>=0&&f.size>0));
  assert.equal(remoteCalls,0,'explicit recovery must remain local with Jev disabled');
  assert.deepEqual(errors,[]);
  console.log(`C++ query recovery production DOM: PASS (WebKit, ${fields.length} anonymous fields; no-progress retained; no Jev calls)`);
} finally {
  await browser.close();await new Promise(resolve=>server.close(resolve));
}
