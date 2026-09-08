import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeLocalPointsTo } from '../../../js/analysis/pointsto/local.js';
import { analyzeEscape, ROOT_ORIGINS } from '../../../js/analysis/summary/escape.js';
import { fixture } from '../helpers/fixtures.mjs';

// #5274: `nonEscapingRoots` is the authority behind the strong
// `distinct-non-escaping-allocation` alias proof, and `rootOrigins` feeds every
// separation decision. Publishing them as raw mutable collections lets a
// consumer forge (`add`) or revoke (`delete`/`clear`) a proof after analysis.
// The published result must be an immutable snapshot.

const FRAME_ROOTS = Object.freeze({
  'variable:state:sp': { kind: 'stack-like', baseOffset: 0, addressSpace: 'memory', linearOffsets: true },
});

function escapeRun() {
  const f = fixture('function_escape_mutable_probe');
  f.block('entry', []);
  const sp = f.stateRead('sp', 'state:sp');
  const c0 = f.constant('c0', 0);
  const slot = f.binary('slot', 'add', sp, c0);
  f.store('st', slot, null, { widthBits: 32 });
  f.ret('r');
  const built = f.build({ rootDescriptors: FRAME_ROOTS });
  const pointsTo = analyzeLocalPointsTo(built.ir, built.cfg, built.ssa, {
    canonicalOptions: { rootDescriptors: built.rootDescriptors },
  });
  return analyzeEscape(built.ir, built.cfg, built.ssa, pointsTo, {});
}

test('#5274 a proven non-escape proof cannot be revoked after publication', () => {
  const escape = escapeRun();
  const proven = [...escape.nonEscapingRoots][0];
  assert.ok(proven, 'precondition: the frame slot is proven non-escaping');
  assert.throws(() => escape.nonEscapingRoots.delete(proven), /escape-result-immutable/);
  assert.throws(() => escape.nonEscapingRoots.clear(), /escape-result-immutable/);
  assert.ok(escape.nonEscapingRoots.has(proven), 'the proof survives the mutation attempts');
});

test('#5274 a forged non-escape proof cannot be injected after publication', () => {
  const escape = escapeRun();
  const before = escape.nonEscapingRoots.size;
  assert.throws(() => escape.nonEscapingRoots.add('forged-root'), /escape-result-immutable/);
  assert.equal(escape.nonEscapingRoots.size, before);
  assert.equal(escape.nonEscapingRoots.has('forged-root'), false);
});

test('#5274 rootOrigins cannot be rewritten after publication', () => {
  const escape = escapeRun();
  const key = [...escape.rootOrigins.keys()][0];
  assert.ok(key);
  assert.throws(() => escape.rootOrigins.set('forged', 'local-allocation'), /escape-result-immutable/);
  assert.throws(() => escape.rootOrigins.delete(key), /escape-result-immutable/);
  assert.equal(escape.rootOrigins.get(key), 'local-frame');
  assert.equal(escape.rootOrigins.has('forged'), false);
});

test('#5274 forEach exposes only the immutable facade, never its backing collections', () => {
  const escape = escapeRun();
  const proven = [...escape.nonEscapingRoots][0];
  const rootKey = [...escape.rootOrigins.keys()][0];
  assert.ok(proven);
  assert.ok(rootKey);

  let setView = null;
  let mapView = null;
  escape.nonEscapingRoots.forEach((_value, _sameValue, collection) => { setView ??= collection; });
  escape.rootOrigins.forEach((_origin, _key, collection) => { mapView ??= collection; });

  assert.equal(setView, escape.nonEscapingRoots, 'Set forEach third arg is the immutable facade');
  assert.equal(mapView, escape.rootOrigins, 'Map forEach third arg is the immutable facade');

  assert.throws(() => setView.add('forged-root'), /escape-result-immutable/);
  assert.throws(() => setView.delete(proven), /escape-result-immutable/);
  assert.throws(() => setView.clear(), /escape-result-immutable/);
  assert.throws(() => mapView.set('forged-root', 'local-allocation'), /escape-result-immutable/);
  assert.throws(() => mapView.delete(rootKey), /escape-result-immutable/);
  assert.throws(() => mapView.clear(), /escape-result-immutable/);

  assert.ok(escape.nonEscapingRoots.has(proven), 'the proof survives forEach mutation attempts');
  assert.equal(escape.nonEscapingRoots.has('forged-root'), false);
  assert.equal(escape.rootOrigins.get(rootKey), 'local-frame');
  assert.equal(escape.rootOrigins.has('forged-root'), false);
});

test('#5274 the published collections stay read-usable for alias authority', () => {
  const escape = escapeRun();
  assert.ok(escape.nonEscapingRoots.size >= 1);
  assert.ok([...escape.nonEscapingRoots].every((key) => typeof key === 'string'));
  assert.ok([...escape.rootOrigins.values()].every((origin) => ROOT_ORIGINS.includes(origin)));
});
