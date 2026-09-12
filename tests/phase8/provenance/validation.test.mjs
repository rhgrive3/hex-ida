import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalAnalysisIdentity } from '../../../js/decompiler/phase8/analysis-identity.js';
import { buildRenderProvenance, validateRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';
import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { analysis, expr, resultWith, source, sourceOf } from './fixture.js';

test('P8-PROV counterexample: a rendered entity with lost origins is never trusted', () => {
  const expression = expr.variable('a1', 64, false, source(1, 1));
  const result = applyPhase8Projection(resultWith(expression, { sourcelessLine:true }), analysis());

  const provenance = result.renderProvenance;
  assert.ok(provenance, 'projection must publish render provenance so consumers can distinguish proof from loss');

  const lost = Object.values(provenance.entities).find((entity) => entity.origins.rows.length === 0
    && entity.origins.addresses.length === 0
    && entity.origins.ir.length === 0
    && entity.origins.ssaRefs.length === 0);
  assert.ok(lost, 'the sourceless rendered entity must be present');
  assert.equal(lost.complete, false, 'a zero-origin semantic entity must never be marked complete');
  assert.equal(lost.role, 'semantic', 'a semantic claim with no evidence is a loss, not scaffolding');
  assert.ok(lost.reasons.includes('provenance-loss'));

  const validation = validateRenderProvenance(provenance, { snapshotId:provenance.snapshotId });
  assert.equal(validation.state, 'incomplete');
  assert.ok(validation.reasons.includes('provenance-loss'));
  assert.ok(validation.counts.provenanceLoss >= 1);
});

test('P8-PROV a mapping bound to another snapshot is rejected as stale', () => {
  const expression = expr.variable('a1', 64, false, source(1, 1));
  const result = applyPhase8Projection(resultWith(expression), analysis());
  const validation = validateRenderProvenance(result.renderProvenance, {
    snapshotId:`${result.renderProvenance.snapshotId}-moved`,
  });
  assert.equal(validation.state, 'incomplete');
  assert.ok(validation.reasons.includes('stale-snapshot'));
});

test('P8-PROV caller identity cannot override the canonical current-IR binding', () => {
  const expression = expr.variable('a1', 64, false, source(1, 1));
  const input = resultWith(expression);
  const facts = analysis();
  const canonical = canonicalAnalysisIdentity({ ir:input.ir, analysis:facts });
  assert.equal(canonical.valid, true, 'fixture must have a canonical current-IR identity');
  const forged = {
    valid:true,
    identity:{ ...canonical.identity, snapshotId:'snapshot:stale-or-foreign' },
  };

  const result = applyPhase8Projection(input, facts, { analysisIdentity:forged });
  assert.equal(result.renderProvenance.snapshotId, canonical.identity.snapshotId);
  assert.notEqual(result.renderProvenance.snapshotId, forged.identity.snapshotId,
    'a stale caller-supplied identity must not mint render provenance authority');
});

test('P8-PROV a mapping without snapshot identity fails closed as missing', () => {
  const expression = expr.variable('a1', 64, false, source(1, 1));
  const result = applyPhase8Projection(resultWith(expression), analysis());
  const unbound = buildRenderProvenance({ result, snapshotId:null });
  assert.equal(unbound.completeness, 'incomplete');
  assert.ok(unbound.reasons.includes('missing-snapshot'));

  const validation = validateRenderProvenance(unbound, { snapshotId:'snapshot:anything' });
  assert.equal(validation.state, 'incomplete');
  assert.ok(validation.reasons.includes('missing-snapshot'));
});

test('P8-PROV a malformed transform record fails closed at construction', () => {
  const expression = expr.variable('a1', 64, false, source(1, 1));
  const result = applyPhase8Projection(resultWith(expression), analysis());
  const malformed = {
    ...result,
    phase8Projection:{ version:1, transformCount:1, transforms:[{ kind:'', proof:'x' }], inductionNames:{} },
  };
  assert.throws(() => buildRenderProvenance({ result:malformed, snapshotId:'snapshot:x' }),
    /phase8-render-provenance-record/);
});

test('P8-PROV transform targets are mandatory authority, not an omitted default', () => {
  const sourceValue = sourceOf({ row:1, ir:'ir-1' });
  const malformed = {
    lines:[{ kind:'stmt', text:'x = 1;', source:sourceValue }],
    phase8Projection:{
      version:1,
      transformCount:1,
      transforms:[{
        kind:'rewrite',
        proof:'fixture proof',
        origin:{
          addresses:[...sourceValue.addresses],
          rows:[...sourceValue.rows],
          ir:[...sourceValue.ir],
          ssaDefs:[...sourceValue.ssaDefs],
          ssaUses:[...sourceValue.ssaUses],
        },
      }],
    },
  };
  assert.throws(() => buildRenderProvenance({ result:malformed, snapshotId:'snapshot:x' }),
    /phase8-render-provenance-record-targets-invalid/);
});

test('P8-PROV validation rejects a non-conforming provenance map', () => {
  assert.throws(() => validateRenderProvenance({ version:2, entities:{} }, { snapshotId:'s' }),
    /phase8-render-provenance-map/);
  assert.throws(() => validateRenderProvenance(null, {}), /phase8-render-provenance-map/);
});
