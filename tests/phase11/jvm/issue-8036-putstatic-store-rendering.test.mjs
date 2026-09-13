import assert from 'node:assert/strict';
import test from 'node:test';

import { liftJvmMethod } from '../../../js/managed/jvm/lifter.js';
import { lowerVMEffectsToSemanticIr, decompileManagedMethod } from '../../../js/managed/shared/bridge-v2.js';

// #8036 — a JVM `putstatic` lowers to a complete Semantic IR `store` whose
// single node input is the stored value; the field address/identity is
// carried by `node.attributes.fieldIdentity` / `node.memory.addressExpr`
// instead of a positional operand. `decompileManagedMethod()` only rendered
// stores with two inputs (field) or more (array), so the mandatory static
// state mutation silently disappeared from pseudocode. A complete store must
// never vanish merely because its address is not a positional input.

function staticStoreClass() {
  return {
    moduleId: 'managed-mod:test:jvm',
    vmSpecEdition: 'java-se-17',
    thisClassName: 'StaticStoreRepro',
    constantPool: [null,
      { tag: 1, value: 'StaticStoreRepro' },           // 1: owner class name
      { tag: 1, value: 's' },                          // 2: field name
      { tag: 1, value: 'I' },                          // 3: field descriptor
      { tag: 7, nameIndex: 1 },                        // 4: Class
      { tag: 12, nameIndex: 2, descriptorIndex: 3 },   // 5: NameAndType
      { tag: 9, classIndex: 4, nameAndTypeIndex: 5 },  // 6: Fieldref
    ],
    fields: [{ name: 's', descriptor: 'I', accessFlags: 0x0008 }],
    methods: [{
      accessFlags: 0x0008,
      name: 'f',
      descriptor: '()V',
      code: {
        maxStack: 1,
        maxLocals: 0,
        bytecode: Uint8Array.from([0x08, 0xb3, 0x00, 0x06, 0xb1]), // iconst_5; putstatic #6; return
        exceptionTable: [],
        offset: 0x180,
      },
    }],
  };
}

test('#8036 the frontend and bridge preserve the exact putstatic store', () => {
  const fn = liftJvmMethod(0, staticStoreClass());
  const putstatic = fn.bundles.find((b) => b.mnemonic === 'putstatic');
  assert.equal(putstatic.completeness, 'exact');
  assert.equal(putstatic.memoryEffects[0].space, 'static-field');
  assert.equal(putstatic.memoryEffects[0].name, 's');
  assert.equal(putstatic.memoryEffects[0].isWrite, true);

  const lowered = lowerVMEffectsToSemanticIr(fn);
  const store = lowered.semanticIr.nodes.find((n) => n.kind === 'store');
  assert.ok(store, 'store node required');
  assert.equal(store.completeness, 'complete');
  assert.equal(store.inputs.length, 1);
  assert.deepEqual(store.attributes.fieldIdentity, {
    kind: 'jvm-field', owner: 'StaticStoreRepro', name: 's', descriptor: 'I', static: true,
  });
});

test('#8036 the decompiler renders the static-field mutation', () => {
  const fn = liftJvmMethod(0, staticStoreClass());
  const decompiled = decompileManagedMethod(fn);
  assert.match(decompiled.pseudocode, /StaticStoreRepro\.s = 5;/);

  // The mutation must be present at all — on main the store fell through and
  // the pseudocode contained no assignment whatsoever.
  assert.match(decompiled.pseudocode, /= 5;/);
});

test('#8036 a store-only method is not rendered as an empty method', () => {
  const fn = liftJvmMethod(0, staticStoreClass());
  const emptyFn = liftJvmMethod(0, {
    ...staticStoreClass(),
    methods: [{
      accessFlags: 0x0008,
      name: 'f',
      descriptor: '()V',
      code: {
        maxStack: 0,
        maxLocals: 0,
        bytecode: Uint8Array.from([0xb1]), // return
        exceptionTable: [],
        offset: 0x180,
      },
    }],
  });
  const withStore = decompileManagedMethod(fn).pseudocode;
  const withoutStore = decompileManagedMethod(emptyFn).pseudocode;
  assert.notEqual(withStore, withoutStore);
  assert.match(withStore, /StaticStoreRepro\.s = 5;/);
});
