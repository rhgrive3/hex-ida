import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('solver Worker loads query contracts without the IR, targets or decompiler runtime', async () => {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['js/symbolic/solver/tiered-worker-entry.js'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    metafile: true,
    logLevel: 'silent',
  });
  const inputs = Object.keys(result.metafile.inputs);
  assert.ok(inputs.includes('js/symbolic/solver/tiered-worker-entry.js'));
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
