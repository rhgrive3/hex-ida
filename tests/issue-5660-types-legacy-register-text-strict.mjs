import assert from 'node:assert/strict';
import test from 'node:test';

import { inferTypes, widthOfRegisterName } from '../js/types-legacy.js';

const STRUCURED_MOV_MODEL = {
  argRegs: [0],
  instructions: [
    {
      row: 0,
      mnemonic: 'mov',
      ops: [
        { k: 'reg', text: ['x19'] },
        { k: 'reg', text: ['x0'] },
      ],
      reads: ['x0'],
      writes: ['x19'],
      isCall: false,
      memory: null,
    },
    {
      row: 1,
      mnemonic: 'ldr',
      ops: [{ k: 'reg', text: 'x1' }],
      reads: ['x19'],
      writes: ['x1'],
      isCall: false,
      memory: { kind: 'load', base: 'x19', disp: 0n, size: 8, stack: false },
    },
  ],
  calls: [],
};

test('#5660 structured register text must not become argument alias evidence', () => {
  const result = inferTypes(STRUCURED_MOV_MODEL);
  // The schema-invalid ['x19']/['x0'] operand text must be ignored entirely:
  // x0 must not launder into a pointer/alias argument identity through the
  // mov-alias path, and the x19-based load must not mint pointer evidence.
  const x0 = result.args.find((arg) => arg.reg === 'x0');
  assert.ok(x0, 'argRegs:[0] must still project an x0 argument record');
  assert.equal(x0.type, 'unknown');
  assert.equal(x0.conf, 0.2);
});

test('#5660 primitive string operand text keeps 64-bit MOV alias tracking', () => {
  const model = {
    argRegs: [0],
    instructions: [
      {
        row: 0,
        mnemonic: 'mov',
        ops: [
          { k: 'reg', text: 'x19' },
          { k: 'reg', text: 'x0' },
        ],
        reads: ['x0'],
        writes: ['x19'],
        isCall: false,
        memory: null,
      },
      {
        row: 1,
        mnemonic: 'ldr',
        ops: [{ k: 'reg', text: 'x1' }],
        reads: ['x19'],
        writes: ['x1'],
        isCall: false,
        memory: { kind: 'load', base: 'x19', disp: 0n, size: 8, stack: false },
      },
    ],
    calls: [],
  };
  const result = inferTypes(model);
  const x0 = result.args.find((arg) => arg.reg === 'x0');
  assert.ok(x0, 'entry argument x0 must be tracked');
  assert.equal(x0.type, 'void *');
  assert.equal(x0.conf, 0.6);
});

test('#5660 W/X width distinction and float width inference stay intact', () => {
  assert.deepEqual(widthOfRegisterName('w0'), { bytes: 4 });
  assert.deepEqual(widthOfRegisterName('x0'), { bytes: 8 });
  assert.deepEqual(widthOfRegisterName(' s0 '), { bytes: 4, float: true });
  assert.deepEqual(widthOfRegisterName('d31'), { bytes: 8, float: true });
  assert.deepEqual(widthOfRegisterName('q0'), { bytes: 16, vector: true });
  assert.equal(widthOfRegisterName('x'), null);
  assert.equal(widthOfRegisterName(''), null);
});

test('#5660 non-string register text must fail closed instead of raw TypeError', () => {
  assert.equal(widthOfRegisterName({ text: 'x0' }), null);
  assert.equal(widthOfRegisterName(['x0']), null);
  assert.equal(widthOfRegisterName(0), null);
  assert.equal(widthOfRegisterName(true), null);
  assert.equal(widthOfRegisterName(null), null);
  assert.equal(widthOfRegisterName(undefined), null);

  // The load-width path inside inferTypes previously raised
  // `(text || "").trim is not a function` for object operand text.
  assert.doesNotThrow(() => {
    inferTypes({
      argRegs: [],
      instructions: [
        {
          row: 0,
          mnemonic: 'ldr',
          ops: [{ k: 'reg', text: {} }],
          reads: [],
          writes: [],
          isCall: false,
          memory: { kind: 'load', base: 'x0', disp: 0n, size: 0, stack: false },
        },
      ],
      calls: [],
    });
  });
});

test('#5660 stringified junk shapes must not mint register identity', () => {
  // 'x0' as a number-ish or nested shape previously laundered through
  // String(text) into canonical register identity.
  assert.equal(widthOfRegisterName(['x0']), null);
  const model = {
    argRegs: [0],
    instructions: [
      {
        row: 0,
        mnemonic: 'mov',
        ops: [
          { k: 'reg', text: { toString() { return 'x0'; } } },
          { k: 'reg', text: 'x19' },
        ],
        reads: ['x19'],
        writes: ['x0'],
        isCall: false,
        memory: null,
      },
    ],
    calls: [],
  };
  const result = inferTypes(model);
  const x0 = result.args.find((arg) => arg.reg === 'x0');
  assert.ok(x0);
  // No alias evidence may be minted for the structured operand.
  assert.equal(x0.type, 'unknown');
});
