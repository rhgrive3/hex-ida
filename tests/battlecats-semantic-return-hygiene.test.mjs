import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSemanticModel } from '../js/blocks.js';
import { irFor, OP } from '../js/ir.js';
import { decompileSemantic } from '../js/decompiler/semantic-core.js';

const BASE = 0x100000000n;

function modelOf(lines) {
  const rows = lines.map((line, i) => {
    const s = line.trim();
    const p = s.indexOf(' ');
    return {
      row: i,
      address: BASE + BigInt(i * 4),
      mn: p < 0 ? s : s.slice(0, p),
      ops: p < 0 ? '' : s.slice(p + 1),
    };
  });
  const rowOfAddress = (addr) => {
    const d = addr - BASE;
    if (d < 0n || d >= BigInt(lines.length * 4)) return null;
    return Number(d / 4n);
  };
  return buildSemanticModel(rows, { startRow: 0, endRow: rows.length - 1, rowOfAddress });
}

function makeNotes(retType) {
  return {
    typeOf: (_addr, slot) => (slot === 'ret' ? retType : null),
  };
}

function makeTailCallIr(calleeName, { callPrototype = null, extraCallPrototype = null } = {}) {
  const ir = {
    instructions: [
      {
        id: 1,
        op: OP.BR,
        row: 0,
        address: BASE,
        args: [],
        extra: {
          isTailCall: true,
          name: calleeName,
          target: BASE + 0x1000n,
          ...(extraCallPrototype ? { callPrototype: extraCallPrototype } : {}),
        },
        ...(callPrototype ? { callPrototype } : {}),
      },
    ],
    blocks: [
      {
        index: 0,
        startRow: 0,
        endRow: 0,
        succ: [],
        pred: [],
        phis: [],
        insts: [],
      },
    ],
    values: [],
    entry: 0,
  };
  ir.blocks[0].insts.push(ir.instructions[0]);
  return ir;
}

function makeEmptyReturnIr() {
  const ir = {
    instructions: [
      {
        id: 1,
        op: OP.RET,
        row: 0,
        address: BASE,
        args: [],
        extra: {},
      },
    ],
    blocks: [
      {
        index: 0,
        startRow: 0,
        endRow: 0,
        succ: [],
        pred: [],
        phis: [],
        insts: [],
      },
    ],
    values: [],
    entry: 0,
  };
  ir.blocks[0].insts.push(ir.instructions[0]);
  return ir;
}

function bodyLines(result) {
  return (result?.lines || []).map((l) => l.text.trim());
}

const arm64AbiAdapter = {
  returnLocations: ({ returnType }) => {
    if (!returnType || /^void\s*$/i.test(returnType)) return [];
    if (/^(?:float|double|__fp16)\b/i.test(returnType)) return [{ kind: 'register', reg: 'v0' }];
    return [{ kind: 'register', reg: 'x0' }];
  },
};

test('void function OP.RET never emits valued return even when x0 is written', () => {
  const model = modelOf([
    'mov x0, #42',
    'ret',
  ]);
  const res = decompileSemantic(model, {
    addr: BASE,
    abiAdapter: arm64AbiAdapter,
    notes: makeNotes('void'),
  });
  const lines = bodyLines(res);
  assert.match(res.signature, /^void /);
  assert.ok(lines.includes('return;'), `expected bare return; in ${JSON.stringify(lines)}`);
  assert.ok(!lines.some((l) => /^return\s+.+;/.test(l)), `unexpected valued return in ${JSON.stringify(lines)}`);
});

test('void function OP.RET in faithfulCfg mode also emits bare return;', () => {
  const model = modelOf([
    'mov x0, #42',
    'ret',
  ]);
  const ir = irFor(model);
  const res = decompileSemantic(model, {
    addr: BASE,
    ir,
    faithfulCfg: true,
    notes: makeNotes('void'),
  });
  const lines = bodyLines(res);
  assert.ok(lines.includes('return;'), `expected bare return; in ${JSON.stringify(lines)}`);
  assert.ok(!lines.some((l) => /^return\s+.+;/.test(l)), `unexpected valued return in ${JSON.stringify(lines)}`);
});

test('void function tail-call emits call; return; regardless of callee return type', () => {
  const model = modelOf(['b #0x100001000']);
  const nonVoidCalleeIr = makeTailCallIr('malloc');
  const res1 = decompileSemantic(model, {
    addr: BASE,
    ir: nonVoidCalleeIr,
    notes: makeNotes('void'),
  });
  const lines1 = bodyLines(res1);
  assert.ok(lines1.some((l) => /malloc\(.*\);\s*return;$/.test(l)), `expected call; return; in ${JSON.stringify(lines1)}`);
  assert.ok(!lines1.some((l) => /^return\s+malloc/.test(l)), `unexpected return malloc in ${JSON.stringify(lines1)}`);

  const voidCalleeIr = makeTailCallIr('free');
  const res2 = decompileSemantic(model, {
    addr: BASE,
    ir: voidCalleeIr,
    notes: makeNotes('void'),
  });
  const lines2 = bodyLines(res2);
  assert.ok(lines2.some((l) => /free\(.*\);\s*return;$/.test(l)), `expected free(...); return; in ${JSON.stringify(lines2)}`);
});

test('non-void function with unrenderable return value emits return 0; or return 0.0;', () => {
  const model = modelOf(['ret']);
  for (const [retType, expected] of [
    ['void *', 'return 0;'],
    ['uint64', 'return 0;'],
    ['unknown', 'return 0;'],
    ['float', 'return 0.0;'],
    ['double', 'return 0.0;'],
    ['__fp16', 'return 0.0;'],
  ]) {
    const res = decompileSemantic(model, {
      addr: BASE,
      ir: makeEmptyReturnIr(),
      notes: makeNotes(retType),
    });
    const lines = bodyLines(res);
    assert.ok(lines.includes(expected), `for ${retType} expected ${expected} in ${JSON.stringify(lines)}`);
    assert.ok(!lines.includes('return;'), `for ${retType} unexpected bare return; in ${JSON.stringify(lines)}`);

    const resCfg = decompileSemantic(model, {
      addr: BASE,
      ir: makeEmptyReturnIr(),
      faithfulCfg: true,
      notes: makeNotes(retType),
    });
    const cfgLines = bodyLines(resCfg);
    assert.ok(cfgLines.includes(expected), `for ${retType} faithfulCfg expected ${expected} in ${JSON.stringify(cfgLines)}`);
    assert.ok(!cfgLines.includes('return;'), `for ${retType} faithfulCfg unexpected bare return; in ${JSON.stringify(cfgLines)}`);
  }
});

test('non-void function tail-calling void callee emits call; return 0; or return 0.0;', () => {
  const model = modelOf(['b #0x100001000']);

  for (const [retType, expectedZero] of [
    ['uint64', '0'],
    ['void *', '0'],
    ['float', '0.0'],
    ['double', '0.0'],
    ['__fp16', '0.0'],
  ]) {
    const resKnown = decompileSemantic(model, {
      addr: BASE,
      ir: makeTailCallIr('free'),
      notes: makeNotes(retType),
    });
    const linesKnown = bodyLines(resKnown);
    assert.ok(
      linesKnown.some((l) => l.endsWith(`return ${expectedZero};`) && l.includes('free(')),
      `for ${retType} + free expected call; return ${expectedZero}; in ${JSON.stringify(linesKnown)}`,
    );

    const resProto = decompileSemantic(model, {
      addr: BASE,
      ir: makeTailCallIr('sub_custom', { callPrototype: { returnsValue: false } }),
      notes: makeNotes(retType),
    });
    const linesProto = bodyLines(resProto);
    assert.ok(
      linesProto.some((l) => l.endsWith(`return ${expectedZero};`) && l.includes('sub_custom(')),
      `for ${retType} + returnsValue:false expected call; return ${expectedZero}; in ${JSON.stringify(linesProto)}`,
    );

    const resExtraProto = decompileSemantic(model, {
      addr: BASE,
      ir: makeTailCallIr('sub_extra', { extraCallPrototype: { returnType: 'void' } }),
      notes: makeNotes(retType),
    });
    const linesExtra = bodyLines(resExtraProto);
    assert.ok(
      linesExtra.some((l) => l.endsWith(`return ${expectedZero};`) && l.includes('sub_extra(')),
      `for ${retType} + extra.callPrototype.returnType:void expected call; return ${expectedZero}; in ${JSON.stringify(linesExtra)}`,
    );
  }
});

test('non-void function tail-calling non-void callee still emits return call();', () => {
  const model = modelOf(['b #0x100001000']);
  const res = decompileSemantic(model, {
    addr: BASE,
    ir: makeTailCallIr('malloc'),
    notes: makeNotes('void *'),
  });
  const lines = bodyLines(res);
  assert.ok(lines.some((l) => /^return\s+malloc\(/.test(l)), `expected return malloc(...) in ${JSON.stringify(lines)}`);
});

test('void * return type is treated as non-void and returns x0 value when defined', () => {
  const model = modelOf([
    'mov x0, #7',
    'ret',
  ]);
  const res = decompileSemantic(model, {
    addr: BASE,
    abiAdapter: arm64AbiAdapter,
    notes: makeNotes('void *'),
  });
  const lines = bodyLines(res);
  assert.match(res.signature, /^void \*/);
  assert.ok(lines.some((l) => l === 'return 7;' || l === 'return 0x7;'), `expected return 7; in ${JSON.stringify(lines)}`);
});
