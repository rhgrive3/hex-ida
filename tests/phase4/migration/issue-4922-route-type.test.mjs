import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANALYSIS_ORCHESTRATION_ROUTE,
  normalizeAnalysisRoute,
} from '../../../js/cache/artifact-orchestration.js';
import { Backend } from '../../../js/backend.js';

const invalidRoutes = [
  ['artifact'],
  ['current'],
  { value:'artifact' },
  new String('artifact'),
  1,
  true,
];

test('analysis route accepts only primitive enum strings', () => {
  assert.equal(normalizeAnalysisRoute('artifact'), ANALYSIS_ORCHESTRATION_ROUTE.ARTIFACT);
  assert.equal(normalizeAnalysisRoute(' current '), ANALYSIS_ORCHESTRATION_ROUTE.CURRENT);

  for (const route of invalidRoutes) {
    assert.throws(
      () => normalizeAnalysisRoute(route),
      /analysis-orchestration-route-invalid/,
      `structured/non-string route must fail closed: ${Object.prototype.toString.call(route)}`,
    );
  }
});

test('invalid route objects are rejected without invoking coercion hooks', () => {
  let calls = 0;
  const route = {
    toString() {
      calls += 1;
      return 'artifact';
    },
  };

  assert.throws(() => normalizeAnalysisRoute(route), /analysis-orchestration-route-invalid/);
  assert.equal(calls, 0, 'route validation must not execute caller coercion hooks');
});

test('Backend route boundaries share the strict route contract', () => {
  assert.throws(
    () => new Backend({ analysisRoute:['artifact'] }),
    /analysis-orchestration-route-invalid/,
    'constructor must reject structured route before storing it',
  );

  const backend = new Backend({ analysisRoute:'artifact' });
  assert.equal(backend.analysisRoute, 'artifact');
  assert.throws(
    () => backend.setAnalysisRoute(['current']),
    /analysis-orchestration-route-invalid/,
    'setter must not mutate route from structured input',
  );
  assert.equal(backend.analysisRoute, 'artifact', 'failed setter must preserve prior route state');
  assert.throws(
    () => backend.analyze(0, { route:['current'] }),
    /analysis-orchestration-route-invalid/,
    'per-request route must fail before any worker/orchestration path is selected',
  );
});
