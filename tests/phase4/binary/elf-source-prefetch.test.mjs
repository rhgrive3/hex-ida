import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { parseELF } from '../../../js/binary/elf-loader.js';
import { parseELFSource } from '../../../js/binary/source-loaders.js';
import { makeElf64Fixture } from '../../universal-binary.mjs';

function normalizeSymbols(symbols) {
  return symbols.map((s) => ({
    name: s.name,
    address: s.address,
    kind: s.kind,
    binding: s.binding,
    defined: s.defined,
  }));
}

function normalizeFunctions(functions) {
  return functions.map((f) => ({
    address: f.address,
    size: f.size,
    source: f.source,
  }));
}

test('ELF source prefetch matches full-bytes and disabled prefetch across benchmarks and fixtures', async () => {
  const benchmarkDir = path.resolve('benchmarks/public/codefuse-arm64/inputs');
  const files = fs.readdirSync(benchmarkDir).filter((f) => f.endsWith('.bin')).slice(0, 5);
  const testInputs = files.map((f) => ({
    name: f,
    bytes: fs.readFileSync(path.join(benchmarkDir, f)),
  }));

  testInputs.push({
    name: 'makeElf64Fixture',
    bytes: makeElf64Fixture(),
  });

  for (const { name, bytes } of testInputs) {
    const full = parseELF(bytes);
    const prefetched = await parseELFSource(bytes);
    const noPrefetch = await parseELFSource(bytes, { prefetch: false }, null, { prefetch: false });

    // Assert sourceReads.parserPasses with prefetch <= 4
    assert.ok(
      prefetched.metadata.sourceReads.parserPasses <= 4,
      `${name}: expected parserPasses <= 4 with prefetch, got ${prefetched.metadata.sourceReads.parserPasses}`,
    );

    // Assert same symbols (name, address)
    assert.deepEqual(
      normalizeSymbols(prefetched.symbols),
      normalizeSymbols(full.symbols),
      `${name}: prefetched symbols mismatch with full bytes`,
    );
    assert.deepEqual(
      normalizeSymbols(noPrefetch.symbols),
      normalizeSymbols(full.symbols),
      `${name}: noPrefetch symbols mismatch with full bytes`,
    );

    // Assert same functions (address, size, source)
    assert.deepEqual(
      normalizeFunctions(prefetched.functions),
      normalizeFunctions(full.functions),
      `${name}: prefetched functions mismatch with full bytes`,
    );
    assert.deepEqual(
      normalizeFunctions(noPrefetch.functions),
      normalizeFunctions(full.functions),
      `${name}: noPrefetch functions mismatch with full bytes`,
    );

    // Assert same imports, sections, segments, metadata.aarch64PltResolver
    assert.deepEqual(prefetched.imports, full.imports, `${name}: imports mismatch`);
    assert.deepEqual(noPrefetch.imports, full.imports, `${name}: noPrefetch imports mismatch`);

    assert.deepEqual(prefetched.sections, full.sections, `${name}: sections mismatch`);
    assert.deepEqual(noPrefetch.sections, full.sections, `${name}: noPrefetch sections mismatch`);

    assert.deepEqual(prefetched.segments, full.segments, `${name}: segments mismatch`);
    assert.deepEqual(noPrefetch.segments, full.segments, `${name}: noPrefetch segments mismatch`);

    assert.deepEqual(
      prefetched.metadata.aarch64PltResolver,
      full.metadata.aarch64PltResolver,
      `${name}: aarch64PltResolver mismatch`,
    );
    assert.deepEqual(
      noPrefetch.metadata.aarch64PltResolver,
      full.metadata.aarch64PltResolver,
      `${name}: noPrefetch aarch64PltResolver mismatch`,
    );
  }
});

test('tiny maxCachedBytes fails closed or yields same budget error as before', async () => {
  const bytes = makeElf64Fixture();
  const tinyRangeOpts = { pageSize: 64, maxCachedBytes: 32 };

  let errorWithPrefetch = null;
  try {
    await parseELFSource(bytes, {}, null, tinyRangeOpts);
  } catch (err) {
    errorWithPrefetch = err;
  }

  let errorWithoutPrefetch = null;
  try {
    await parseELFSource(bytes, { prefetch: false }, null, { ...tinyRangeOpts, prefetch: false });
  } catch (err) {
    errorWithoutPrefetch = err;
  }

  assert.ok(errorWithPrefetch != null, 'expected error with tiny maxCachedBytes and prefetch');
  assert.ok(errorWithoutPrefetch != null, 'expected error with tiny maxCachedBytes without prefetch');
  assert.equal(errorWithPrefetch.code, errorWithoutPrefetch.code);
  assert.match(errorWithPrefetch.message, /cache limit/);
});
