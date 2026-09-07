import assert from 'node:assert/strict';
import { SymbolIndex } from '../js/symbols.js';
import { ProgramIndex } from '../js/program.js';
import { readFile } from 'node:fs/promises';

function makeIndex() {
  return new SymbolIndex({
    addrs: new BigUint64Array([0x1000n, 0x1010n, 0x1200n]),
    kinds: new Uint8Array([0, 0, 0]),
    names: '_known\nL_local\n_global_after',
    funcs: new BigUint64Array([0x1000n, 0x1100n]),
  });
}

{
  const index = makeIndex();
  assert.equal(index.label(0x1004n), '_known+0x4', 'normal in-function symbol offsets should remain');
  assert.equal(index.label(0x1014n), 'L_local+0x4', 'local labels inside the same function should remain valid');

  assert.equal(index.label(0x1100n), null, 'an unnamed function start must not borrow the previous function name');
  assert.equal(index.label(0x1108n), null, 'an unnamed function body must not inherit a symbol from the previous function');
}

{
  const index = makeIndex();
  index.rename(0x1000n, 'Player::tick');
  assert.equal(index.label(0x1000n), 'Player::tick');
  assert.equal(index.label(0x1008n), 'Player::tick+0x8', 'rename should propagate through the renamed function body');

  index.rename(0x1100n, 'Player::update');
  assert.equal(index.nameAt(0x1100n), 'Player::update', 'rename should identify a stripped function exactly');
  assert.equal(index.label(0x110cn), 'Player::update+0xC', 'rename of a stripped function must propagate without an original symbol');

  index.rename(0x1100n, '');
  assert.equal(index.nameAt(0x1100n), null, 'clearing rename should restore stripped state');
  assert.equal(index.label(0x110cn), null, 'clearing rename must not fall back across the previous function boundary');
}

{
  const index = makeIndex();
  index.rename(0x1008n, 'interesting_branch');
  assert.equal(index.label(0x100cn), 'interesting_branch+0x4', 'explicit local renames may label later addresses in the same function');
  assert.equal(index.label(0x1104n), null, 'local rename must not leak into the next function');
}

// #5970: malformed structured addresses must not alias canonical rename keys.
{
  const index = new SymbolIndex({
    addrs: new BigUint64Array([0x1000n]),
    kinds: new Uint8Array([0]),
    names: 'real_name',
    funcs: new BigUint64Array([0x1000n]),
  });
  index.rename(['4096'], 'forged');
  assert.equal(index.renamedAt(0x1000n), null, 'structured rename address must not create a canonical alias');
  assert.equal(index.nameEvidence(0x1000n)?.source, 'binary-symbol', 'malformed rename must not replace symbol provenance');
  index.rename(0x1000n, 'real_name_override');
  assert.equal(index.renamedAt(['4096']), null, 'structured lookup address must not read a canonical rename');
  assert.equal(index.nameAt(0x1000n), 'real_name_override');
  index.rename(['4096'], '');
  assert.equal(index.renamedAt(0x1000n), 'real_name_override', 'malformed delete must not remove a canonical rename');
}

// #5711: functionWindowBound must honor the same containment as functionAt.
{
  const explicit = new SymbolIndex({
    funcs: new BigUint64Array([0x1000n]),
    funcEnds: new BigUint64Array([0x1010n]),
  });
  assert.equal(explicit.functionWindowBound(0x1000n), 0x1010n, 'function start keeps its explicit window bound');
  assert.equal(explicit.functionWindowBound(0x100fn), 0x1010n, 'address inside explicit function keeps its bound');
  assert.equal(explicit.functionWindowBound(0x1010n), null, 'exact explicit end is outside the function window');
  assert.equal(explicit.functionWindowBound(0x2000n), null, 'address after explicit end has no stale window bound');

  const regions = new SymbolIndex({
    funcs: new BigUint64Array([0x1000n, 0x2000n]),
    regions: [
      { id: 'text-a', vmAddr: 0x1000n, size: 0x10n, exec: true },
      { id: 'text-b', vmAddr: 0x2000n, size: 0x100n, exec: true },
    ],
  });
  assert.equal(regions.functionWindowBound(0x1080n), null, 'a clear cross-region gap must not inherit the prior function window');

  const outsideRegions = new SymbolIndex({
    funcs: new BigUint64Array([0x1000n]),
    funcEnds: new BigUint64Array([0x1010n]),
    regions: [{ id: 'text-only', vmAddr: 0x2000n, size: 0x100n, exec: true }],
  });
  assert.equal(outsideRegions.functionAt(0x1008n), null, 'a function outside executable regions is not contained');
  assert.equal(
    outsideRegions.functionWindowBound(0x1008n),
    null,
    'a start and query outside executable regions must not expose an explicit window bound',
  );
}


{
  const index = new SymbolIndex({
    funcs: new BigUint64Array([0x1000n, 0x1100n, 0x3000n, 0x90000n]),
    regions: [
      { id:'text-a', vmAddr:0x1000n, size:0x1000n, exec:true },
      { id:'text-b', vmAddr:0x3000n, size:0x100000n, exec:true },
      { id:'data', vmAddr:0x2000n, size:0x1000n, exec:false },
    ],
  });
  assert.deepEqual(index.functionAt(0x1000n), { start:0x1000n, end:null, index:0 });
  assert.equal(index.functionAt(0x1080n), null, 'next function start is not proof of the previous function extent');
  assert.deepEqual(index.functionAt(0x1100n), { start:0x1100n, end:null, index:1 });
  assert.equal(index.functionAt(0x1180n), null);
  assert.equal(index.functionAt(0x2800n), null);
  assert.equal(index.functionAt(0x5000n), null);
}

{
  const index = new SymbolIndex({
    funcs: new BigUint64Array([0x1000n]),
    funcEnds: new BigUint64Array([0x1080n]),
    regions: [{ id:'text', vmAddr:0x1000n, size:0x1000n, exec:true }],
  });
  assert.deepEqual(index.functionAt(0x107cn), { start:0x1000n, end:0x1080n, index:0 });
  assert.equal(index.functionAt(0x1080n), null);
}


{
  const index = new SymbolIndex({
    funcs: new BigUint64Array([0x1000n]),
    funcEnds: new BigUint64Array([0x1080n]),
    regions: [{ id:'text', vmAddr:0x1000n, size:0x1000n, exec:true }],
  });
  index.addFunctions([0x1100n]);
  assert.deepEqual(index.functionAt(0x107cn), { start:0x1000n, end:0x1080n, index:0 }, 'adding a start must preserve independently proven extents');
  assert.deepEqual(index.functionAt(0x1100n), { start:0x1100n, end:null, index:1 });
}

// #464 re-audit: ProgramIndex must observe the same executable-region trust
// boundary as Script lookups. A short global next-start gap in another region
// must not turn trailing padding in region A into function A ownership.
{
  const regionA={ id:'text-a', vmAddr:0x1000n, size:0x200n, exec:true };
  const regionB={ id:'text-b', vmAddr:0x2000n, size:0x200n, exec:true };
  const symbols=new SymbolIndex({
    funcs:new BigUint64Array([0x1100n,0x2000n]),
    regions:[regionA,regionB],
  });
  const program=new ProgramIndex({
    vmAddr:regionA.vmAddr, words:Number(regionA.size/4n), kindsCovered:0,
    kinds:new Uint8Array(0), callFrom:new BigUint64Array(0), callTo:new BigUint64Array(0),
  },symbols,regionA);
  assert.equal(program.functionStartOf(0x1100n),0x1100n,'exact start remains owned');
  assert.equal(program.functionStartOf(0x1180n),null,'region-A trailing padding is not owned across a short region gap');
  assert.equal(symbols.functionAt(0x2000n)?.start,0x2000n,'region-B exact start remains identifiable');
}

// Keep the production App wiring under regression too; the previous fix only
// called setFunctionRegions() in Script.functionAt(), leaving normal worker
// replacement unbound.
{
  const appSource=await readFile(new URL('../js/app.js',import.meta.url),'utf8');
  assert.match(appSource,/new SymbolIndex\(\{ \.\.\.res, regions \}\)/,
    'worker analysis SymbolIndex must receive active slice regions');
  assert.match(appSource,/new SymbolIndex\(\{ regions: this\.store\.get\('regions'\) \|\| \[\] \}\)/,
    'EMPTY_INDEX replacement must retain active region trust boundaries');
}

console.log('symbol identity regression: PASS');
