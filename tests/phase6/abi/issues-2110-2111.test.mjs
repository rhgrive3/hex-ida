import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAAPCS64Arguments } from '../../../js/targets/abi/aapcs64.js';
import { classifyAAPCS64Arguments as classifyCore } from '../../../js/targets/abi/aapcs64-core.js';
import { abiPhysicalIntervalsValid, normalizeAbiPieces } from '../../../js/targets/abi/evidence.js';

const classify = (args) => classifyAAPCS64Arguments({ callPrototype:{ args } });
const aggregate = (bits) => ({
  type:`struct ${bits}`,
  aggregate:true,
  bits,
  members:Array.from({ length:bits / 64 }, (_unused, index) => ({
    type:'uint64_t', bits:64, byteOffset:index * 8,
  })),
});

test('#2110 aggregate does not split across x7 and stack', () => {
  const six = classify([...Array.from({length:6},()=>({type:'uint64_t',bits:64})),aggregate(128)]);
  assert.deepEqual(six.arguments[6].regs,['x6','x7']);
  const seven = classify([...Array.from({length:7},()=>({type:'uint64_t',bits:64})),aggregate(128)]);
  assert.equal(seven.arguments[7].location,'stack');
  assert.equal(seven.arguments[7].offset,0);
  assert.equal(seven.arguments[7].bytes,16);
  assert.equal(seven.srcs.some((source)=>source.reg==='x7'), false);
  const eightByte = classify([...Array.from({length:7},()=>({type:'uint64_t',bits:64})),aggregate(64)]);
  assert.deepEqual(eightByte.arguments[7].regs,['x7']);
});

test('#2111 FP/SIMD stack fallbacks align NSAA', () => {
  const fpExhaust = Array.from({length:8},()=>({type:'double',bits:64}));
  const vector = classify([{type:'uint64_t',bits:64}, ...fpExhaust, {abiClass:'vector',bits:128}]);
  assert.equal(vector.arguments.at(-1).alignment,16);
  const double = classify([...fpExhaust,{type:'double',bits:64}]);
  assert.equal(double.arguments.at(-1).alignment,8);
  const withStackLead = classify([
    ...Array.from({length:8},()=>({type:'uint64_t',bits:64})),
    {type:'uint64_t',bits:64},
    ...fpExhaust,
    {abiClass:'vector',bits:128},
  ]);
  assert.equal(withStackLead.arguments[8].offset,0);
  assert.equal(withStackLead.arguments.at(-1).offset,16);
});

test('#2111 nested canonical HVA layout preserves natural alignment at spill', () => {
  const fpExhaust = Array.from({length:8},()=>({type:'double',bits:64}));
  const gpAndStackLead = Array.from({length:9},()=>({type:'uint64_t',bits:64}));
  const hva = {
    type:'aggregate',
    hva:true,
    layout:{
      bits:256,
      bytes:32,
      alignment:16,
      members:[
        {bits:128,bytes:16,byteOffset:0,alignment:16},
        {bits:128,bytes:16,byteOffset:16,alignment:16},
      ],
    },
  };
  const result = classify([...fpExhaust, ...gpAndStackLead, hva, {type:'uint64_t',bits:64}]);
  const lead = result.arguments[16];
  const spilled = result.arguments[17];
  const tail = result.arguments[18];
  assert.equal(lead.offset, 0);
  assert.equal(spilled.homogeneousLayoutProven, true);
  assert.equal(spilled.alignment, 16);
  assert.equal(spilled.offset, 16);
  assert.equal(spilled.bytes, 32);
  assert.deepEqual(spilled.pieces.map((piece)=>piece.stackOffset), [16,32]);
  assert.equal(tail.offset, 48);
});

function nestedHva() {
  return {
    type:'aggregate', hva:true,
    layout:{
      bits:256, bytes:32,
      members:[
        {bits:128,bytes:16,byteOffset:0,alignment:16},
        {bits:128,bytes:16,byteOffset:16,alignment:16},
      ],
    },
  };
}

function spillArguments(hva) {
  return [
    ...Array.from({length:8},()=>({type:'double',bits:64})),
    ...Array.from({length:9},()=>({type:'uint64_t',bits:64})),
    hva,
    {type:'uint64_t',bits:64},
  ];
}

function assertCoreSpill(hva, alignment) {
  // Check the allocator that consumes nested evidence before the public
  // wrapper independently normalizes vector-sized stack slots.
  const result = classifyCore({callPrototype:{args:spillArguments(hva)}});
  const spilled = result.arguments[17];
  assert.equal(spilled.homogeneousLayoutProven, true);
  assert.equal(spilled.alignment, alignment);
  assert.equal(spilled.offset, alignment);
  assert.deepEqual(spilled.pieces.map((piece)=>piece.stackOffset), [alignment, alignment + 16]);
  assert.equal(result.arguments[18].offset, alignment + 32);
}

function assertUnprovenAlignment(parameter) {
  for (const classifier of [classifyCore, classifyAAPCS64Arguments]) {
    for (const args of [[parameter], spillArguments(parameter)]) {
      const result = classifier({callPrototype:{args}});
      const index = args.length === 1 ? 0 : 17;
      assert.equal(result.partial, true);
      assert.equal(result.stackArgsUnknown, true);
      for (const argument of result.arguments.slice(index)) {
        assert.equal(argument.location, 'unknown');
        assert.equal(argument.exact, false);
        assert.equal(argument.mustUse, false);
        assert.equal(argument.certainty, 'unknown');
        assert.equal(argument.offset, undefined);
        assert.equal(argument.reg, undefined);
        assert.equal(argument.pieces, undefined);
      }
      assert.ok(result.stackArguments.every((argument) => argument.index < index));
    }
  }
}

test('#2111 malformed nested alignment never invokes numeric coercion', () => {
  let coercions = 0;
  const coercible = { valueOf() { coercions++; return 16; } };
  const throwing = { [Symbol.toPrimitive]() { coercions++; throw new Error('unexpected alignment coercion'); } };
  for (const value of ['16', [16], new Number(16), coercible, throwing, Symbol('alignment'), 16n,
    true, null, undefined, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const hva = nestedHva();
    hva.layout.alignment = value;
    assertUnprovenAlignment(hva);
  }
  assert.equal(coercions, 0);
});

test('#2111 nested alignment aliases require consistent primitive evidence', () => {
  for (const owner of ['layout', 'returnAggregate', 'returnAggregate.layout']) {
    for (const alias of ['alignment', 'align', 'alignmentBytes']) {
      for (const value of [8, 16, '16', null]) {
        const hva = nestedHva();
        hva.returnAggregate = { layout:{} };
        const record = owner === 'layout' ? hva.layout
          : owner === 'returnAggregate' ? hva.returnAggregate : hva.returnAggregate.layout;
        record[alias] = value;
        if (typeof value === 'number') assertCoreSpill(hva, value);
        else assertUnprovenAlignment(hva);
      }
    }
  }
  for (const alias of [16, 8, '16', [16], null, undefined]) {
    const hva = nestedHva();
    hva.layout.alignment = 16;
    hva.returnAggregate = { alignmentBytes:alias };
    if (alias === 16) assertCoreSpill(hva, 16);
    else assertUnprovenAlignment(hva);
  }
});

test('#2111 direct alignment metadata retains precedence over nested evidence', () => {
  for (const alias of ['alignment', 'align', 'alignmentBytes']) {
    for (const [direct, nested] of [[8, 16], [16, 8], [16, Symbol('ignored nested alignment')]]) {
      const hva = nestedHva();
      hva[alias] = direct;
      hva.layout.alignment = nested;
      assertCoreSpill(hva, direct);
    }
  }
});

test('#2111 public HFA spill preserves recovered alignment, pieces and the following slot', () => {
  for (const owner of ['layout', 'returnAggregate', 'returnAggregate.layout']) {
    for (const alias of ['alignment', 'align', 'alignmentBytes']) {
      const hfa = {
        type:'aggregate', hfa:true,
        layout:{bits:128,bytes:16,members:Array.from({length:4}, (_unused,index) =>
          ({bits:32,bytes:4,byteOffset:index * 4,alignment:4}))},
        returnAggregate:{layout:{}},
      };
      const record = owner === 'layout' ? hfa.layout
        : owner === 'returnAggregate' ? hfa.returnAggregate : hfa.returnAggregate.layout;
      record[alias] = 16;
      const result = classify(spillArguments(hfa));
      const [lead, spilled, tail] = result.arguments.slice(16);
      assert.equal(result.partial, false);
      assert.equal(lead.offset, 0);
      assert.equal(lead.bytes, 8);
      assert.equal(spilled.alignment, 16);
      assert.equal(spilled.offset, 16);
      assert.deepEqual(spilled.pieces.map((piece) => piece.stackOffset), [16,20,24,28]);
      assert.equal(tail.offset, 32);
      assert.ok(normalizeAbiPieces(spilled, spilled.pieces));
      assert.equal(abiPhysicalIntervalsValid({arguments:result.arguments.slice(16)}), true);
      assert.equal(result.stackArguments[1], spilled);
    }
  }
});

test('#2111 public vector-slot normalization relocates every HVA piece', () => {
  const result = classify(spillArguments(nestedHva()));
  const spilled = result.arguments[17];
  assert.equal(spilled.offset, 16);
  assert.deepEqual(spilled.pieces.map((piece) => piece.stackOffset), [16,32]);
  assert.equal(result.arguments[18].offset, 48);
  assert.ok(normalizeAbiPieces(spilled, spilled.pieces));
  assert.equal(abiPhysicalIntervalsValid({arguments:result.arguments.slice(16)}), true);
});

test('#2111 public normalization relocates wide-integer pieces after an aggregate spill', () => {
  const result = classify([
    ...Array.from({length:7},()=>({type:'uint64_t',bits:64})),
    aggregate(128), {type:'uint64_t',bits:64}, {type:'__int128',bits:128}, {type:'uint64_t',bits:64},
  ]);
  const wide = result.arguments[9];
  assert.equal(wide.offset, 32);
  assert.deepEqual(wide.pieces.map((piece) => piece.stackOffset), [32]);
  assert.equal(result.arguments[10].offset, 48);
  assert.equal(abiPhysicalIntervalsValid({arguments:result.arguments.slice(7)}), true);
});

test('#2111 unsupported natural alignments never produce certain core or public geometry', () => {
  for (const owner of ['direct', 'layout', 'returnAggregate', 'returnAggregate.layout']) {
    for (const alias of ['alignment', 'align', 'alignmentBytes']) {
      for (const value of [3, 12, 24, Number.MAX_SAFE_INTEGER]) {
        for (const parameter of [nestedHva(), aggregate(128)]) {
          parameter.layout ||= {bits:parameter.bits,bytes:parameter.bits / 8,members:parameter.members};
          parameter.returnAggregate = {layout:{}};
          const record = owner === 'direct' ? parameter : owner === 'layout' ? parameter.layout
            : owner === 'returnAggregate' ? parameter.returnAggregate : parameter.returnAggregate.layout;
          record[alias] = value;
          assertUnprovenAlignment(parameter);
        }
      }
    }
  }
});
