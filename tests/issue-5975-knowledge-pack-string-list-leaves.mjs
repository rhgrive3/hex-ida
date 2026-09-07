import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createKnowledgePack,
  validateKnowledgePack,
  importKnowledgePack,
} from '../js/signature/index.js';

test('#5975 create path keeps primitive string symbols', () => {
  const pack = createKnowledgePack({
    signatures: [{ architecture: 'arm64', symbols: ['malloc', 'malloc', 'free'], confidence: 1, provenance: { source: 'test' }, license: 'test' }],
  });
  assert.deepEqual(pack.signatures[0].symbols, ['malloc', 'free']);
  assert.equal(validateKnowledgePack(pack).ok, true);
});

test('#5975 create path must not coerce structured symbol leaves', () => {
  assert.throws(
    () => createKnowledgePack({ signatures: [{ architecture: 'arm64', symbols: [['malloc']], confidence: 1, provenance: { source: 'test' }, license: 'test' }] }),
    /signature symbols must contain only primitive strings/,
  );
  assert.throws(
    () => createKnowledgePack({ signatures: [{ architecture: 'arm64', symbols: [{ name: 'malloc' }], confidence: 1, provenance: { source: 'test' }, license: 'test' }] }),
    /signature symbols must contain only primitive strings/,
  );
  assert.throws(
    () => createKnowledgePack({ signatures: [{ architecture: 'arm64', symbols: [42], confidence: 1, provenance: { source: 'test' }, license: 'test' }] }),
    /signature symbols must contain only primitive strings/,
  );
  assert.throws(
    () => createKnowledgePack({ signatures: [{ architecture: 'arm64', symbols: [true], confidence: 1, provenance: { source: 'test' }, license: 'test' }] }),
    /signature symbols must contain only primitive strings/,
  );
});

test('#5975 create path must not coerce mapping role/type/comment/label leaves', () => {
  for (const [field, value] of [
    ['roles', [['allocator']]],
    ['types', [['size_t']]],
    ['comments', [['manual']]],
    ['semanticLabels', [['memory-allocation']]],
    ['roles', [7]],
    ['types', [false]],
    ['comments', [{}]],
    ['semanticLabels', [['x']]],
  ]) {
    const entry = { identity: 'fn-1', confidence: 1, provenance: { source: 'test' }, license: 'test', [field]: value };
    assert.throws(
      () => createKnowledgePack({ mappings: [entry] }),
      /mapping (roles|types|comments|semanticLabels) must contain only primitive strings/,
      `${field} leaf ${JSON.stringify(value)} must be rejected`,
    );
  }
});

test('#5975 create path keeps primitive mapping string lists and dedupe', () => {
  const pack = createKnowledgePack({
    mappings: [{ identity: 'fn-1', roles: ['allocator', 'allocator'], types: ['size_t'], comments: ['manual'], semanticLabels: ['memory-allocation'], confidence: 1, provenance: { source: 'test' }, license: 'test' }],
  });
  assert.deepEqual(pack.mappings[0].roles, ['allocator']);
  assert.deepEqual(pack.mappings[0].types, ['size_t']);
  assert.deepEqual(pack.mappings[0].comments, ['manual']);
  assert.deepEqual(pack.mappings[0].semanticLabels, ['memory-allocation']);
});

test('#5975 validateKnowledgePack rejects structured symbol leaves on import', () => {
  const raw = {
    format: 'hex-knowledge-pack',
    version: 2,
    signatures: [{ architecture: 'arm64', confidence: 1, symbols: [['malloc']], provenance: { source: 'test' }, license: 'test' }],
    mappings: [],
  };
  const result = validateKnowledgePack(raw);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'signature symbols must contain only primitive strings');
  assert.equal(importKnowledgePack(JSON.stringify(raw)).ok, false);
});

test('#5975 validateKnowledgePack rejects structured mapping leaves on import', () => {
  for (const [field, value] of [
    ['roles', [['allocator']]],
    ['types', [['size_t']]],
    ['comments', [['manual']]],
    ['semanticLabels', [['memory-allocation']]],
  ]) {
    const raw = {
      format: 'hex-knowledge-pack',
      version: 2,
      signatures: [],
      mappings: [{ identity: 'fn-1', confidence: 1, provenance: { source: 'test' }, license: 'test', [field]: value }],
    };
    const result = validateKnowledgePack(raw);
    assert.equal(result.ok, false, `${field} structured leaf must fail validation`);
    assert.equal(result.error, `mapping ${field} must contain only primitive strings`);
    assert.equal(importKnowledgePack(raw).ok, false);
  }
});

test('#5975 import path rejects non-array mapping list containers', () => {
  const raw = {
    format: 'hex-knowledge-pack',
    version: 2,
    signatures: [],
    mappings: [{ identity: 'fn-1', confidence: 1, provenance: { source: 'test' }, license: 'test', roles: 'allocator' }],
  };
  const result = validateKnowledgePack(raw);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'mapping roles must be an array');
});

test('#5975 import path still accepts primitive string lists', () => {
  const raw = {
    format: 'hex-knowledge-pack',
    version: 2,
    signatures: [{ architecture: 'arm64', confidence: 1, symbols: ['_foo', '_bar'], provenance: { source: 'test' }, license: 'test' }],
    mappings: [{ identity: 'fn-1', roles: ['allocator'], types: ['size_t'], comments: ['manual'], semanticLabels: ['memory-allocation'], confidence: 1, provenance: { source: 'test' }, license: 'test' }],
  };
  assert.equal(validateKnowledgePack(raw).ok, true);
  assert.equal(importKnowledgePack(JSON.stringify(raw)).ok, true);
});
