import assert from 'node:assert/strict';
import { decodeSchema } from '../js/schema.js';

const MOVZ_X2_3 = 0xd2800062;    // movz x2, #3
const MOVZ_X3_3 = 0xd2800063;    // movz x3, #3
const MOV_X2_X3 = 0xaa0303e2;    // mov x2, x3
const ADD_X2_X3_X4 = 0x8b040062; // add x2, x3, x4
const EOR_X2_X3_X4 = 0xca040062; // eor x2, x3, x4
const LDP_X2_X3_X0 = 0xa9400c02; // ldp x2, x3, [x0]
const LDR_X4_X6_X7 = 0xf86768c4; // ldr x4, [x6, x7]
const MUL_X5_X4_X2 = 0x9b027c85; // mul x5, x4, x2
const MUL_X5_X4_X3 = 0x9b037c85; // mul x5, x4, x3
const STR_X0_X6_X7 = 0xf82768c0; // str x0, [x6, x7]
const MOVK_X2_1_LSL16 = 0xf2a00022; // movk x2, #1, lsl 16 (0x10003 = 65539)
const BL_CALL = 0x94000001;      // bl

// 1. movz x2, #3; mov x2, x3; ... mul ..., x2 must NOT output factor 3
{
  const words = [
    MOVZ_X2_3,
    LDR_X4_X6_X7,
    MOV_X2_X3,
    MUL_X5_X4_X2,
    STR_X0_X6_X7,
  ];
  const res = decodeSchema(words, 0x1000n);
  assert.deepEqual(res.best?.scaled || [], [], 'mov overwrite must kill constant');
}

// 2. movz x2, #3; add x2, x3, x4; ... mul ..., x2 must NOT output factor 3
{
  const words = [
    MOVZ_X2_3,
    LDR_X4_X6_X7,
    ADD_X2_X3_X4,
    MUL_X5_X4_X2,
    STR_X0_X6_X7,
  ];
  const res = decodeSchema(words, 0x1000n);
  assert.deepEqual(res.best?.scaled || [], [], 'add overwrite must kill constant');
}

// 3. movz x2, #3; eor x2, x3, x4; ... mul ..., x2 must NOT output factor 3
{
  const words = [
    MOVZ_X2_3,
    LDR_X4_X6_X7,
    EOR_X2_X3_X4,
    MUL_X5_X4_X2,
    STR_X0_X6_X7,
  ];
  const res = decodeSchema(words, 0x1000n);
  assert.deepEqual(res.best?.scaled || [], [], 'eor overwrite must kill constant');
}

// 4. movz x2, #3; ... mul ..., x2 (without overwrite) retains factor 3
{
  const words = [
    MOVZ_X2_3,
    LDR_X4_X6_X7,
    MUL_X5_X4_X2,
    STR_X0_X6_X7,
  ];
  const res = decodeSchema(words, 0x1000n);
  assert.deepEqual(res.best?.scaled, [{ factor: 3, columnStride: 1, loadedReg: 4 }]);
}

// 5. movz x2, #3 followed by movk x2, #1, lsl 16 synthesizes wide constant 65539
{
  const words = [
    MOVZ_X2_3,
    MOVK_X2_1_LSL16,
    LDR_X4_X6_X7,
    MUL_X5_X4_X2,
    STR_X0_X6_X7,
  ];
  const res = decodeSchema(words, 0x1000n);
  assert.deepEqual(res.best?.scaled, [{ factor: 65539, columnStride: 1, loadedReg: 4 }]);
}

// 6. call instruction clobbers caller-saved register constant
{
  const words = [
    MOVZ_X2_3,
    BL_CALL,
    LDR_X4_X6_X7,
    MUL_X5_X4_X2,
    STR_X0_X6_X7,
  ];
  const res = decodeSchema(words, 0x1000n);
  assert.deepEqual(res.best?.scaled || [], [], 'call must clobber x2 constant');
}

// 7. A scalar pair load must invalidate both destinations, including Rt2.
{
  const words = [
    MOVZ_X3_3,
    LDR_X4_X6_X7,
    LDP_X2_X3_X0,
    MUL_X5_X4_X3,
    STR_X0_X6_X7,
  ];
  const res = decodeSchema(words, 0x1000n);
  assert.deepEqual(res.best?.scaled || [], [], 'pair-load Rt2 overwrite must kill x3 constant');
}

console.log('issue #6306 schema stale constant register overwrite regressions PASS');
