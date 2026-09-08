import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveABIPlugin, abiPlugin, registerABIPlugin } from '../../../js/targets/abi/index.js';
import { riscvAbiFromElfFlags } from '../../../js/targets/abi/riscv-lp64.js';

test('6052: arch+platform alone does not invent soft-float LP64', () => {
  assert.equal(resolveABIPlugin({ architecture: 'riscv64', platform: 'linux' }).id, 'unknown');
  assert.equal(resolveABIPlugin({ architecture: 'riscv64', platform: 'unix' }).id, 'unknown');
});

test('6052: explicit abiIds still resolve', () => {
  assert.equal(resolveABIPlugin({ architecture: 'riscv64', platform: 'linux', abiId: 'lp64' }).id, 'lp64');
  assert.equal(resolveABIPlugin({ architecture: 'riscv64', platform: 'linux', abiId: 'lp64f' }).id, 'lp64f');
  assert.equal(resolveABIPlugin({ architecture: 'riscv64', platform: 'linux', abiId: 'lp64d' }).id, 'lp64d');
});

test('6052: profile calling conventions select unambiguously', () => {
  assert.equal(resolveABIPlugin({ architecture: 'riscv64', platform: 'linux', callingConvention: 'lp64d' }).id, 'lp64d');
  assert.equal(resolveABIPlugin({ architecture: 'riscv64', platform: 'linux', callingConvention: 'lp64f' }).id, 'lp64f');
});

test('6052: shared vector-variant alias stays ambiguous', () => {
  assert.equal(
    resolveABIPlugin({ architecture: 'riscv64', platform: 'linux', callingConvention: 'riscv-vector-variant' }).id,
    'unknown',
  );
});

test('6052: ELF float-ABI metadata selects the profile', () => {
  for (const [flags, abiId] of [[0x0, 'lp64'], [0x3, 'lp64f'], [0x5, 'lp64d']]) {
    const selected = riscvAbiFromElfFlags(flags);
    assert.equal(selected.abiId, abiId);
    assert.equal(resolveABIPlugin({ architecture: 'riscv64', platform: 'linux', abiId: selected.abiId }).id, abiId);
  }
});

test('6052: selection does not depend on registration order', () => {
  const before = resolveABIPlugin({ architecture: 'riscv64', platform: 'linux' }).id;
  const probe = registerABIPlugin({
    id: 'probe-order-guard', architectureId: 'probe-arch', platformPredicate: () => false,
  });
  assert.ok(probe, 'probe registration must succeed');
  assert.equal(resolveABIPlugin({ architecture: 'riscv64', platform: 'linux' }).id, before);
  assert.equal(before, 'unknown');
});

test('6052: other architectures keep their defaults', () => {
  assert.equal(resolveABIPlugin({ architecture: 'x86_64', platform: 'linux' }).id, 'sysv-amd64');
  assert.equal(resolveABIPlugin({ architecture: 'x86_64', platform: 'windows' }).id, 'microsoft-x64');
  assert.equal(abiPlugin('lp64').architectureId, 'riscv64');
});
