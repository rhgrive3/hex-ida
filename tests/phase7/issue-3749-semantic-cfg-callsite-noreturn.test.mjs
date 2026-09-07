import assert from 'node:assert/strict';
import test from 'node:test';

import { createMachineEffectBundle } from '../../js/semantics/effects/index.js';
import { buildSemanticV2CompatibilityPipeline } from '../../js/semantics/compat/index.js';
import { decompileSemantic } from '../../js/decompiler/semantic.js';
import { ABIPlugin, registerABIPlugin } from '../../js/targets/abi/index.js';
import {
  analyzeDecodedSemanticFunction,
  createSemanticCallPrototypeAuthority,
  partitionDecodedFunction as partitionBase,
  semanticAbiAdapter,
  semanticControlUnknowns,
} from '../../js/analysis/semantic-function-base.js';
import { analyzeSemanticFunction, partitionDecodedFunction as partitionPublic } from '../../js/analysis/semantic-function.js';

const partitions = [
  ['public', partitionPublic],
  ['base', partitionBase],
];

function decoded(entries) {
  return entries.map(([address, kind, target = null, callPrototype = null]) => ({
    address:BigInt(address),
    length:4n,
    kind,
    target:target == null ? null : BigInt(target),
    ...(callPrototype == null ? {} : { callPrototype }),
  }));
}

function plugin() {
  return {
    classifyControlFlow(instruction) { return instruction.kind; },
    directControlTarget(instruction) { return instruction.target; },
  };
}

function blockAt(blocks, address) {
  return blocks.find((block) => block.startAddress === BigInt(address));
}

for (const [route, partition] of partitions) {
  test(`${route}: per-call resolver terminates only the call bound to noreturn evidence`, () => {
    const fatalTarget = 0x1000n;
    const normalTarget = 0x2000n;
    const seen = [];
    const blocks = partition(decoded([
      [0, 'call', fatalTarget],
      [4, 'fallthrough'],
      [8, 'call', normalTarget],
      [12, 'return'],
    ]), plugin(), {
      callPrototypeFor(target, call) {
        seen.push([target, call.address]);
        if (target === fatalTarget) return { noreturn:true, returnType:'void' };
        if (target === normalTarget) return { noreturn:false, returnType:'int' };
        return null;
      },
    });

    assert.deepEqual(seen, [[fatalTarget, 0n], [normalTarget, 8n]]);
    assert.equal(blocks.length, 2);
    assert.deepEqual(blockAt(blocks, 0).instructions.map(({ decoded:instruction }) => instruction.address), [0n]);
    assert.deepEqual(blockAt(blocks, 0).successors, []);
    assert.deepEqual(blockAt(blocks, 4).instructions.map(({ decoded:instruction }) => instruction.address), [4n, 8n, 12n]);
  });

  test(`${route}: unknown per-call prototype keeps ordinary call fallthrough`, () => {
    const blocks = partition(decoded([
      [0, 'call', 0x1000n],
      [4, 'return'],
    ]), plugin(), { callPrototypeFor:() => null });
    assert.equal(blocks.length, 1);
    assert.deepEqual(blocks[0].instructions.map(({ decoded:instruction }) => instruction.address), [0n, 4n]);
  });

  test(`${route}: indirect calls bind resolver evidence by callsite identity`, () => {
    const blocks = partition(decoded([
      [0, 'call'],
      [4, 'return'],
    ]), plugin(), {
      callPrototypeFor(target, call) {
        assert.equal(target, null);
        return call.address === 0n ? { noreturn:true } : null;
      },
    });
    assert.equal(blocks.length, 2);
    assert.deepEqual(blockAt(blocks, 0).successors, []);
  });

  test(`${route}: instruction-bound evidence outranks the resolver for the same callsite`, () => {
    let resolverCalls = 0;
    const blocks = partition(decoded([
      [0, 'call', 0x1000n, { noreturn:false }],
      [4, 'return'],
    ]), plugin(), {
      callPrototypeFor() {
        resolverCalls += 1;
        return { noreturn:true };
      },
    });
    assert.equal(resolverCalls, 0);
    assert.equal(blocks.length, 1);
  });

  test(`${route}: legacy global noreturn fallback is retained only for a single callsite`, () => {
    const single = partition(decoded([
      [0, 'call', 0x1000n],
      [4, 'return'],
    ]), plugin(), { callPrototype:{ noreturn:true } });
    assert.equal(single.length, 2, 'PR #944 single-call behavior must remain');

    const multiple = partition(decoded([
      [0, 'call', 0x1000n],
      [4, 'fallthrough'],
      [8, 'call', 0x2000n],
      [12, 'return'],
    ]), plugin(), { callPrototype:{ noreturn:true } });
    assert.equal(multiple.length, 1, 'function-global prototype must not mark unrelated calls noreturn');
  });

  test(`${route}: resolver is evaluated once per callsite inside CFG construction`, () => {
    let calls = 0;
    const blocks = partition(decoded([
      [0, 'call', 0x1000n],
      [4, 'return'],
    ]), plugin(), {
      callPrototypeFor() {
        calls += 1;
        return { noreturn:true };
      },
    });
    assert.equal(calls, 1);
    assert.equal(blocks.length, 2);
  });
}

for (const [route, partition] of partitions) {
  test(`${route}: missing/invalid decoded collections keep the canonical decoded-instructions contract`, () => {
    for (const bad of [undefined, null, 'bl 0x1000', 7, {}, true]) {
      assert.throws(() => partition(bad, plugin(), {}), /semantic-function-decoded-instructions-required/);
    }
    assert.throws(() => partition([], plugin(), {}), /semantic-function-decoded-instructions-required/);
  });

  test(`${route}: duplicate call addresses fail canonical validation before callsite authority construction`, () => {
    let resolverCalls = 0;
    assert.throws(
      () => partition(decoded([
        [0, 'call', 0x1000n],
        [0, 'call', 0x2000n],
      ]), plugin(), {
        callPrototypeFor() {
          resolverCalls += 1;
          return { noreturn:true };
        },
      }),
      /semantic-function-duplicate-instruction-address/,
    );
    assert.equal(resolverCalls, 0, 'prototype authority must not evaluate before canonical decoded-input validation');
  });
}

test('issue 3749 validation order: analyze entrypoints validate decoded collections before authority construction', () => {
  const envelope = {
    architecture:'arm64',
    abiId:'aapcs64',
    platform:'linux',
    decoderSemanticVersion:'issue-3749-decoder-1',
    binaryId:'issue-3749-binary',
    sliceId:'issue-3749-slice',
  };
  assert.throws(
    () => analyzeSemanticFunction({ ...envelope }),
    /semantic-function-decoded-instructions-required/,
    'public route must not surface a raw non-iterable failure for missing instructions',
  );
  assert.throws(
    () => analyzeSemanticFunction({ ...envelope, instructions:'bl 0x1000' }),
    /semantic-function-decoded-instructions-required/,
  );
  assert.throws(
    () => analyzeSemanticFunction({ ...envelope, instructions:[{ address:0n, length:4n }, { address:0n, length:4n }] }),
    /semantic-function-duplicate-instruction-address/,
  );
  assert.throws(
    () => analyzeDecodedSemanticFunction({ ...envelope, instructions:[{ address:0n, length:4n }, { address:0n, length:4n }] }),
    /semantic-function-duplicate-instruction-address/,
  );
  assert.throws(
    () => analyzeDecodedSemanticFunction({ ...envelope, instructions:[] }),
    /semantic-function-decoded-instructions-required/,
  );
});

const addressTarget = (value) => ({
  kind:'absolute-address',
  value:`0x${BigInt(value).toString(16)}`,
  widthBits:64,
});
const testRegister = { kind:'register', registerId:'state0', widthBits:32 };
const integrationPlugin = Object.freeze({
  id:'x86_64',
  semanticVersion:'issue-3749-test-semantics-1',
  fixedInstructionSize:4,
  classifyControlFlow(instruction) { return instruction.kind; },
  directControlTarget(instruction) { return instruction.target; },
  liftExact(instruction) {
    const base = {
      instructionId:instruction.instructionId,
      architectureId:'x86_64',
      mode:instruction.mode,
      possibleFaults:[],
      origin:instruction.origin,
    };
    if (instruction.kind === 'call') return createMachineEffectBundle({
      ...base,
      operations:[],
      controlEffect:{ kind:'call', target:addressTarget(instruction.target) },
      completeness:'exact',
    });
    if (instruction.kind === 'work') return createMachineEffectBundle({
      ...base,
      operations:[
        {
          id:`${instruction.instructionId}:state-write`,
          kind:'register-write',
          register:testRegister,
          value:{ kind:'bitvector', widthBits:32, value:String(instruction.value ?? 1) },
        },
        {
          id:`${instruction.instructionId}:memory-write`,
          kind:'memory-write',
          access:{
            space:'memory',
            addressExpr:{ kind:'bitvector', widthBits:64, value:String(0x5000 + Number(instruction.address)) },
            widthBits:32,
            endian:'little',
          },
          value:{ kind:'bitvector', widthBits:32, value:String(instruction.value ?? 1) },
        },
      ],
      controlEffect:{ kind:'fallthrough' },
      completeness:'exact',
    });
    if (instruction.kind === 'return') return createMachineEffectBundle({
      ...base,
      operations:[],
      controlEffect:{ kind:'return' },
      completeness:'exact',
    });
    return null;
  },
});

const abiSeenPrototypes = [];
const integrationAbi = registerABIPlugin(new ABIPlugin({
  id:'issue-3749-shared-authority-test',
  semanticVersion:'1',
  semanticIdentity:'issue-3749-shared-authority-test@1',
  architectureId:'x86_64',
  platformPredicate:() => true,
  classifyArguments(instruction) {
    abiSeenPrototypes.push(instruction.callPrototype);
    return {
      srcs:[],
      arguments:[],
      stackArguments:[],
      stackArgsUnknown:false,
      stackArgsMayContainPointers:false,
      completeness:'exact',
      partial:false,
      evidence:'issue-3749-test',
    };
  },
  classifyCallReturn:() => null,
  classifyFunctionReturn:() => null,
}));

test('issue 3749 integration: CFG and ABI consume one cached callsite prototype through SSA/MemorySSA/decompiler', () => {
  abiSeenPrototypes.length = 0;
  const returningPrototype = Object.freeze({ noreturn:false, returnType:'void', args:[] });
  const fatalPrototype = Object.freeze({ noreturn:true, returnType:'void', args:[] });
  const globalPrototype = Object.freeze({ noreturn:true, returnType:'void', args:[] });
  const instructions = decoded([
    [0, 'call', 0x1000n],
    [4, 'work'],
    [8, 'call', 0x2000n],
    [12, 'work'],
    [16, 'return'],
  ]).map((instruction, index) => ({ ...instruction, value:index + 1 }));
  let resolverCalls = 0;
  const callsites = instructions.filter((instruction) => instruction.kind === 'call').map((instruction) => ({
    instruction,
    address:instruction.address,
    target:instruction.target,
  }));
  const authority = createSemanticCallPrototypeAuthority(callsites, {
    callPrototype:globalPrototype,
    callPrototypeFor(target, call) {
      resolverCalls += 1;
      if (target === 0x1000n) {
        assert.equal(call.address, 0n);
        return returningPrototype;
      }
      if (target === 0x2000n) {
        assert.equal(call.address, 8n);
        return fatalPrototype;
      }
      return null;
    },
  });

  const cfgOptions = { callPrototypeAuthority:authority };
  const blocks = partitionBase(instructions, integrationPlugin, cfgOptions);
  assert.equal(resolverCalls, 2, 'CFG resolves every callsite exactly once');
  assert.equal(blocks.length, 2);
  assert.deepEqual(blockAt(blocks, 0).instructions.map(({ decoded:instruction }) => instruction.address), [0n, 4n, 8n]);
  assert.deepEqual(blockAt(blocks, 0).successors, [], 'fatal second call terminates the live block');
  assert.deepEqual(blockAt(blocks, 12).instructions.map(({ decoded:instruction }) => instruction.address), [12n, 16n]);
  const unknowns = semanticControlUnknowns(blocks, integrationPlugin, cfgOptions);
  assert.equal(resolverCalls, 2, 'control-completeness pass must reuse the cached authority');

  const abiAdapter = semanticAbiAdapter(integrationAbi, {
    architecture:'x86_64',
    platform:'linux',
  }, { callPrototypeAuthority:authority });
  const pipeline = buildSemanticV2CompatibilityPipeline({
    architecturePlugin:integrationPlugin,
    decoderSemanticVersion:'issue-3749-decoder-1',
    binaryId:'issue-3749-binary',
    sliceId:'issue-3749-slice',
    addressWidthBits:64,
    mode:'test',
    entryBlockKey:blocks[0].key,
    blocks,
    completeness:unknowns.length ? 'partial' : 'complete',
    unknowns,
    abiAdapter,
  }, { abiAdapter });

  assert.equal(resolverCalls, 2, 'ABI projection must consume the exact cached resolver results');
  assert.deepEqual(abiSeenPrototypes, [returningPrototype, fatalPrototype]);
  assert.ok(pipeline.ssa.definitions.length > 0, 'focused route must execute scalar SSA');
  assert.ok(pipeline.memorySsa.definitions.length > 0, 'focused route must execute MemorySSA');
  assert.equal(pipeline.cfg.blocks[0].successors.length, 0, 'noreturn topology must survive canonical CFG construction');

  const maximumRow = Math.max(...pipeline.legacyV1.instructions.map((instruction) => instruction.row));
  const model = {
    name:'issue_3749_pipeline',
    instructions:Array.from({ length:maximumRow + 1 }, (_unused, row) => ({
      row,
      address:BigInt(row * 4),
      size:4,
      mn:'nop',
      ops:'',
    })),
    switches:[],
  };
  const decompiler = decompileSemantic(model, {
    ir:pipeline.legacyV1,
    abiAdapter,
    decoderSemanticVersion:'issue-3749-decoder-1',
    binaryId:'issue-3749-binary',
    sliceId:'issue-3749-slice',
    addr:0n,
    name:model.name,
  });
  assert.ok(decompiler?.semantic, 'focused route must reach the shared semantic decompiler');
  assert.equal(resolverCalls, 2, 'decompiler reuse must not re-evaluate call prototype authority');
});
