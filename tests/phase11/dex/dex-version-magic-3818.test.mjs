import assert from 'node:assert/strict';
import { parseDex, probeDex } from '../../../js/managed/dex/parser.js';
import { buildMinimalDex as buildMappedDex } from './dex-parser.test.mjs';

function buildMinimalDex(version, terminator = 0x00) {
  assert.equal(version.length, 3);
  const bytes = buildMappedDex().slice();
  bytes[4] = version.charCodeAt(0);
  bytes[5] = version.charCodeAt(1);
  bytes[6] = version.charCodeAt(2);
  bytes[7] = terminator;
  return bytes;
}

for (const version of ['035', '037', '038', '039', '040']) {
  const bytes = buildMinimalDex(version);
  const probe = probeDex(bytes);
  assert.equal(probe.supported, true);
  assert.equal(probe.confidence, 1);
  assert.equal(probe.formatVersion, `dex-${version}`);
  assert.equal(probe.vmSpecEdition, `dalvik-dex-${version}`);

  const image = parseDex(bytes);
  assert.equal(image.formatVersion, `dex-${version}`);
  assert.equal(image.vmSpecEdition, `dalvik-dex-${version}`);
}

for (const malformed of ['abc', '03x', '0 5']) {
  const bytes = buildMinimalDex(malformed);
  const probe = probeDex(bytes);
  assert.equal(probe.supported, false);
  assert.equal(probe.confidence, 0);
  assert.equal(probe.reason, 'invalid-version');
  assert.throws(() => parseDex(bytes), /dex-unsupported-binary/);
}

{
  const bytes = buildMinimalDex('035', 0x78);
  const probe = probeDex(bytes);
  assert.equal(probe.supported, false);
  assert.equal(probe.confidence, 0);
  assert.equal(probe.reason, 'invalid-magic');
  assert.throws(() => parseDex(bytes), /dex-unsupported-binary/);
}

for (const unsupported of ['041', '999']) {
  const bytes = buildMinimalDex(unsupported);
  const probe = probeDex(bytes);
  assert.equal(probe.supported, false);
  assert.equal(probe.confidence, 0);
  assert.equal(probe.reason, 'unsupported-version');
  assert.equal(probe.formatVersion, `dex-${unsupported}`);
  assert.equal(probe.vmSpecEdition, `dalvik-dex-${unsupported}`);
  assert.throws(() => parseDex(bytes), /dex-unsupported-binary/);
}
