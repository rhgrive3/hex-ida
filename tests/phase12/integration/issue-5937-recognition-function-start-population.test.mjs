import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureRecognitionState } from '../../../js/app.js';
import { SymbolIndex } from '../../../js/symbols.js';

/* Recognition's population is the function-start collection, not the
 * named-symbol collection (issue #5937): `addrs` also holds data/stub/pointer
 * symbols and can be legitimately empty while `funcs` carries the complete
 * function starts of a stripped binary. */

const textRegion = { id:'text', vmAddr:0x1000n, size:0x200n, exec:true };

function recognitionApp(sym, propagated = []) {
  return {
    symbols:sym,
    backend:{ gen:0, contentHash:'fixture-hash' },
    recognition:null,
    recognitionBusy:null,
    fields:{ ownerOf:()=>null },
    knowledge:{ propagate:async (fn)=>{ propagated.push(fn.address); return { propagated:false }; } },
    ensureSwift:async()=>{},
  };
}

test('ensureRecognition executes actual function starts, names, windows, and completeness', async () => {
  const sym = new SymbolIndex({
    addrs:new BigUint64Array([0x1000n]),
    kinds:new Uint8Array([1]),
    flags:new Uint8Array([0]),
    names:['_named'],
    funcs:new BigUint64Array([0x1000n, 0x1100n]),
    functionStartsComplete:true,
    regions:[textRegion],
  });
  const propagated = [];
  const app = recognitionApp(sym, propagated);
  const state = await ensureRecognitionState(app, { maxFunctions:10, knowledgeLimit:10 });
  assert.equal(state.total, 2, 'the state population must use all function starts');
  assert.equal(state.scannedCount, 2);
  assert.equal(state.complete, true);
  assert.equal(state.truncationReason, null);
  assert.equal(state.knowledgeScanned, 2, 'knowledge propagation follows actual functions');
  assert.deepEqual(propagated, [0x1000n, 0x1100n], 'knowledge must visit every function start');
  assert.deepEqual(state.records.map((record)=>({ address:record.address, name:record.name, size:record.fingerprint.size })), [
    { address:0x1000n, name:'_named', size:0x100 },
    { address:0x1100n, name:null, size:0 },
  ]);
  assert.equal(await ensureRecognitionState(app, { maxFunctions:10, knowledgeLimit:10 }), state,
    'recognition results must be cached by generation');
});

test('ensureRecognition discards state when symbol generation changes during build', async () => {
  const sym = new SymbolIndex({
    addrs:new BigUint64Array([0x1000n]),
    kinds:new Uint8Array([1]),
    flags:new Uint8Array([0]),
    names:['_named'],
    funcs:new BigUint64Array([0x1000n, 0x1100n]),
    functionStartsComplete:true,
    regions:[textRegion],
  });
  const app = recognitionApp(sym);
  let changed = false;
  app.knowledge = {
    propagate: async () => {
      if (!changed) {
        changed = true;
        sym.rename(0x1000n, '_updated-during-build');
      }
      return { propagated:false };
    },
  };
  const state = await ensureRecognitionState(app, { maxFunctions:10, knowledgeLimit:1 });
  assert.equal(state, null, 'a symbol-index mutation must invalidate the in-flight state');
  assert.equal(app.recognition, null, 'an invalidated state must never enter the cache');
});

test('ensureRecognition stays incomplete when function discovery is incomplete', async () => {
  const sym = new SymbolIndex({
    addrs:new BigUint64Array(0), kinds:new Uint8Array(0), flags:new Uint8Array(0), names:[],
    funcs:new BigUint64Array([0x1000n, 0x1100n]), functionStartsComplete:false, regions:[textRegion],
  });
  const state = await ensureRecognitionState(recognitionApp(sym), {});
  assert.equal(state.total, 2);
  assert.equal(state.scannedCount, 2);
  assert.equal(state.complete, false);
  assert.equal(state.truncationReason, 'function-discovery-incomplete');
});

{
  const sym = new SymbolIndex({
    addrs:new BigUint64Array(0),
    kinds:new Uint8Array(0),
    flags:new Uint8Array(0),
    names:[],
    funcs:new BigUint64Array([0x1000n, 0x1100n]),
    functionStartsComplete:true,
    regions:[textRegion],
  });
  assert.equal(sym.symbolCount, 0);
  assert.equal(sym.functionCount, 2, 'stripped functions live in funcs, not addrs');
  assert.equal(sym.nameAt(0x1000n), null, 'stripped functions have no name');
  const bound = sym.functionWindowBound(0x1000n);
  assert.equal(bound, 0x1100n, 'the function-window contract bounds the first function at the next start');
  assert.equal(sym.functionWindowBound(0x1100n), null, 'the last function has no derived window bound');
}

{
  const sym = new SymbolIndex({
    addrs:new BigUint64Array([0x2000n, 0x2010n]),
    kinds:new Uint8Array([2, 1]),
    flags:new Uint8Array([0, 0]),
    names:['_global_ptr', '_global_value'],
    funcs:new BigUint64Array([0x1000n]),
    functionStartsComplete:true,
    regions:[textRegion],
  });
  assert.equal(sym.functionCount, 1, 'data symbols are not function starts');
  assert.equal(sym.nameAt(0x1000n), null);
  assert.equal(sym.nameAt(0x2000n), '_global_ptr', 'names stay attached to their own collection');
  assert.equal(sym.functionWindowBound(0x1000n), null,
    'data-symbol distance must never bound a function window');
}
