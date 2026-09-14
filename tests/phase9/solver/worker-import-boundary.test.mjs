import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../../', import.meta.url));

for (const entry of ['worker-entry.js', 'tiered-worker-entry.js']) test(`${entry} loads query contracts without host transport or analysis runtime`, async () => {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [`js/symbolic/solver/${entry}`],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    metafile: true,
    logLevel: 'silent',
  });
  const inputs = Object.keys(result.metafile.inputs);
  assert.ok(inputs.includes(`js/symbolic/solver/${entry}`));
  assert.deepEqual(inputs.filter(file => /\/(?:tiered-)?worker-backend\.js$/.test(file)), [],
    'worker identity must not import the host transport');
  const runtimeImports = inputs.filter(file =>
    /^js\/(?:ir[^/]*\.js|decompiler\/|semantics\/|targets\/|ui[/.\-]|apple\/)/.test(file));
  assert.deepEqual(runtimeImports, [], 'query metadata must not pull the analysis runtime into each Worker');
});


test('the public translator facade re-exports the same completeness contract', async () => {
  const light = await import('../../../js/symbolic/translate/completeness.js');
  const facade = await import('../../../js/symbolic/translate/support-matrix.js');
  assert.equal(facade.COMPLETENESS_STATUS, light.COMPLETENESS_STATUS);
  assert.equal(facade.createCompleteness, light.createCompleteness);
});

test('both host APIs retain the canonical worker wire identity', async () => {
  const protocol = await import('../../../js/symbolic/solver/worker-protocol.js');
  for (const [file, prefix, id] of [
    ['worker-backend.js', 'WORKER', 'hex-exhaustive-bv-worker'],
    ['tiered-worker-backend.js', 'TIERED_WORKER', 'hex-tiered-qfbv-worker'],
  ]) {
    const host = await import(`../../../js/symbolic/solver/${file}`);
    assert.equal(host[`${prefix}_BACKEND_ID`], id);
    assert.equal(host[`${prefix}_BACKEND_VERSION`], '1.0.0');
    assert.equal(host[`${prefix}_BACKEND_ID`], protocol[`${prefix}_BACKEND_ID`]);
    assert.equal(host[`${prefix}_BACKEND_VERSION`], protocol[`${prefix}_BACKEND_VERSION`]);
  }
});
