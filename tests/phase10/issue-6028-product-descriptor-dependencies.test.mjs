import assert from 'node:assert/strict';
import { productDescriptor } from '../../js/platform/product-descriptor.js';

// Normal array dependencies are preserved and deduped.
{
  const d = productDescriptor(
    { productDescriptor: { formatId: 'macho', dependencies: ['libA.dylib', 'libA.dylib', 'libB.dylib'] } },
    null,
  );
  assert.deepEqual(d.dependencies, ['libA.dylib', 'libB.dylib']);
}

// String container must not be split into single characters.
{
  const d = productDescriptor(
    { productDescriptor: { formatId: 'macho', dependencies: 'libA.dylib' } },
    null,
  );
  assert.deepEqual(d.dependencies, []);
}

// Object container must not leak a raw spread TypeError.
{
  const d = productDescriptor(
    { productDescriptor: { formatId: 'macho', dependencies: { name: 'libA.dylib' } } },
    null,
  );
  assert.deepEqual(d.dependencies, []);
}

// info.dependencies / info.dylibs share the same Array-only contract.
{
  const d = productDescriptor(
    { slices: [{ info: { dependencies: 'libB', dylibs: 'libC' } }] },
    null,
  );
  assert.deepEqual(d.dependencies, []);
}

// Array element compatibility ({name}) is preserved.
{
  const d = productDescriptor(
    { productDescriptor: { formatId: 'macho', dependencies: [{ name: 'libA.dylib' }] } },
    null,
  );
  assert.deepEqual(d.dependencies, ['libA.dylib']);
}

// imports-derived library aggregation still works.
{
  const d = productDescriptor(
    { slices: [{ info: { imports: [{ library: 'libImp.dylib' }] } }] },
    null,
  );
  assert.ok(d.dependencies.includes('libImp.dylib'));
}

console.log('issue-6028 product-descriptor dependency collection tests passed');
