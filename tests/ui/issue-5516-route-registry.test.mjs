import assert from 'node:assert/strict';
import test from 'node:test';

import { PRIMARY_NAV, ROUTES } from '../../js/ui/registry.js';
import { matchRoute } from '../../js/ui/router.js';

test('canonical route entries are immutable to outside callers', () => {
  assert.equal(Object.isFrozen(ROUTES), true);
  for (const route of ROUTES) assert.equal(Object.isFrozen(route), true);
  assert.throws(() => { ROUTES[0].pattern = '/corrupted'; }, TypeError);
  assert.notEqual(ROUTES[0].pattern, '/corrupted');
});

test('route matching keeps working without writing cache state onto routes', () => {
  assert.equal(matchRoute(ROUTES, '/investigate')?.route.id, 'investigate');
  assert.equal(matchRoute(ROUTES, '/results')?.route.id, 'results');
  for (const route of ROUTES) assert.equal(Object.hasOwn(route, '_matcher'), false);
  for (const item of PRIMARY_NAV) {
    assert.equal(matchRoute(ROUTES, item.route)?.route.id, item.routeId);
  }
});

test('published metadata and the effective matcher cannot split', () => {
  assert.equal(matchRoute(ROUTES, '/investigate')?.route.id, 'investigate');
  assert.throws(() => { ROUTES[0].pattern = '/corrupted'; }, TypeError);
  assert.equal(matchRoute(ROUTES, '/investigate')?.route.id, 'investigate');
  assert.equal(matchRoute(ROUTES, '/corrupted'), null);
});
