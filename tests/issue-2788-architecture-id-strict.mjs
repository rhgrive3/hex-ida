import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalArchitectureId,
  architecturePluginV2,
  registerArchitecturePlugin,
  architecturePluginsV2,
} from '../js/targets/architecture/index.js';
import { architectureCapability, UnsupportedArchitectureError } from '../js/architecture/index.js';

test('#2788 canonicalArchitectureId accepts only real strings', () => {
  assert.equal(canonicalArchitectureId(' ARM64 '), 'arm64');
  assert.equal(canonicalArchitectureId('arm64'), 'arm64');
  assert.equal(canonicalArchitectureId(['arm64']), '');
  assert.equal(canonicalArchitectureId({ toString() { return 'arm64'; } }), '');
  assert.equal(canonicalArchitectureId(0), '');
  assert.equal(canonicalArchitectureId(1), '');
  assert.equal(canonicalArchitectureId(true), '');
  assert.equal(canonicalArchitectureId(null), '');
  assert.equal(canonicalArchitectureId(undefined), '');
});

test('#2788 malformed ids cannot resolve a registered plugin', () => {
  assert.equal(architecturePluginV2('arm64')?.id, 'arm64');
  assert.notEqual(architecturePluginV2(['arm64'])?.id, 'arm64');
  assert.notEqual(architecturePluginV2({ toString() { return 'arm64'; } })?.id, 'arm64');
  assert.equal(architecturePluginV2(['arm64'])?.id ?? null, 'unknown');
  assert.equal(architecturePluginV2({ toString() { return 'arm64'; } })?.id ?? null, 'unknown');
  assert.equal(architecturePluginV2('')?.id, 'unknown');
  assert.equal(architecturePluginV2(null)?.id, 'unknown');
});

test('#2788 registration rejects non-string plugin identities', () => {
  const before = architecturePluginsV2().length;
  assert.throws(() => registerArchitecturePlugin({ id: ['forged'] }), /architecture id is required/);
  assert.throws(() => registerArchitecturePlugin({ id: 0 }), /architecture id is required/);
  assert.equal(architecturePluginsV2().length, before);
});

test('#2788 architectureCapability fails closed on malformed image.arch', () => {
  const forged = architectureCapability({ arch: ['arm64'] }, { arm64: true });
  assert.equal(forged.architecture, '');
  assert.equal(forged.canDisassemble, false);
  assert.equal(forged.canAnalyzeDataflow, false);

  const real = architectureCapability({ arch: 'arm64' }, { arm64: true });
  assert.equal(real.architecture, 'arm64');
  assert.equal(real.canDisassemble, true);
});

test('#2788 UnsupportedArchitectureError keeps string normalization for real strings', () => {
  const error = new UnsupportedArchitectureError('decompile', ' ARM64 ');
  assert.equal(error.architecture, 'arm64');
  const forged = new UnsupportedArchitectureError('decompile', ['arm64']);
  assert.equal(forged.architecture, '');
});
