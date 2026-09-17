import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPR_DAG_MAX_NODES,
  deserializeExprDag,
  serializeExprDag,
} from '../../../js/symbolic/expr/serialize.js';

function envelope(root, metadata = {}) {
  return { schemaVersion: '1.0.0', expressionDagVersion: '1.0.0', metadata, root };
}

function assertDomainRejection(thunk, label) {
  let thrown = null;
  try {
    thunk();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, `${label} must be rejected`);
  assert.ok(!(thrown instanceof RangeError), `${label} must not surface a raw stack overflow: ${thrown.message}`);
  assert.ok(thrown instanceof TypeError, `${label} must fail as a domain TypeError`);
  return thrown;
}

test('issue #8753 CE1: deep unknown-semantic detail fails under the DAG depth budget', () => {
  let detail = { leaf: true };
  for (let level = 0; level < 50_000; level++) detail = { next: detail };
  const error = assertDomainRejection(
    () => deserializeExprDag(envelope({ kind: 'unknown_semantic', sort: { kind: 'bool' }, reason: 'x', detail })),
    'deep embedded detail payload',
  );
  assert.match(error.message, /expression DAG depth budget exceeded/);
});

test('issue #8753 CE2: oversized BV hex is rejected before BigInt conversion with a bounded message', () => {
  const error = assertDomainRejection(
    () => deserializeExprDag(envelope({ kind: 'const', sort: { kind: 'bv', width: 8 }, value: `0x${'f'.repeat(8_000_000)}` })),
    '8M-digit width-8 BV literal',
  );
  assert.match(error.message, /canonical hex string/);
  assert.ok(error.message.length < 512, 'rejection message must not echo the whole oversized literal');
});

test('issue #8753 CE3: falsy connective children are charged to the node budget', () => {
  const args = Array(EXPR_DAG_MAX_NODES + 1).fill(null);
  const error = assertDomainRejection(
    () => deserializeExprDag(envelope({ kind: 'connective', sort: { kind: 'bool' }, op: 'and', args })),
    'null-filled oversized args array',
  );
  assert.match(error.message, /expression DAG node budget exceeded/);
});

test('issue #8753: at-limit detail payloads and canonical hex values remain valid', () => {
  let detail = { leaf: true };
  for (let level = 0; level < 1_000; level++) detail = { next: detail };
  const unknown = deserializeExprDag(envelope({ kind: 'unknown_semantic', sort: { kind: 'bool' }, reason: 'x', detail }));
  assert.equal(unknown.kind, 'unknown_semantic');

  const full = `0x${'f'.repeat(65_536 / 4)}`;
  const widest = deserializeExprDag(envelope({ kind: 'const', sort: { kind: 'bv', width: 65_536 }, value: full }));
  assert.equal(widest.value, BigInt(full));
  const wire = serializeExprDag(widest);
  assert.equal(typeof wire, 'string');
  assert.ok(wire.includes(full), 'canonical serializer keeps the at-limit hex value');
  assert.equal(deserializeExprDag(wire).value, BigInt(full));

  const boolNode = deserializeExprDag(envelope({ kind: 'const', sort: { kind: 'bool' }, value: true }));
  assert.equal(boolNode.value, true);
});
