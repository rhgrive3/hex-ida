import assert from "node:assert/strict";
import * as facade from "../js/arm64.js";
import * as directOperands from "../js/ui/explain/arm64-operands.js";
import * as directAapcs from "../js/abi/aapcs64/presentation.js";
import { analyzeFunction } from "../js/analyze.js";

console.log("Testing ARM64 presentation compatibility...");

// 1. Operand corpus
const OPERAND_CORPUS = [
  "",
  "x0",
  "w8",
  "sp",
  "wsp",
  "xzr",
  "wzr",
  "lr",
  "fp",
  "#0",
  "#9",
  "#10",
  "#-1",
  "#0x20",
  "#-0x20",
  "#1.5",
  "x1, x2, lsl #3",
  "x1, w2, sxtw #2",
  "[x0]",
  "[x0, #0x10]",
  "[x0, #-16]!",
  "[x0], #8",
  "[x0, x1]",
  "[x0, w1, uxtw #2]",
  "{v0.16b, v1.16b}",
  "v2.s[3]",
  "eq",
  "ne",
];

for (const input of OPERAND_CORPUS) {
  const fromFacade = facade.parseOperands(input);
  const fromDirect = directOperands.parseOperands(input);
  assert.deepEqual(fromFacade, fromDirect, `parseOperands mismatch on: "${input}"`);
}
console.log("  ok 1 operand corpus deep equality");

// 2. Immediate and display corpus
const IMM_TESTS = [
  { k: "imm", text: "#0", value: 0n },
  { k: "imm", text: "#9", value: 9n },
  { k: "imm", text: "#10", value: 10n },
  { k: "imm", text: "#-1", value: -1n },
  { k: "imm", text: "#0x20", value: 32n },
  { k: "imm", text: "#-0x20", value: -32n },
  { k: "imm", text: "#1.5", value: null, float: 1.5 },
  { k: "imm", text: "#0xffff", value: 0xffffn },
  { k: "imm", text: "#0x10000", value: 0x10000n },
  { k: "imm", text: "#0x100000000", value: 0x100000000n },
];

for (const imm of IMM_TESTS) {
  assert.equal(facade.immText(imm), directOperands.immText(imm));
  assert.equal(facade.opShort(imm), directOperands.opShort(imm));
}
console.log("  ok 2 immediate/display corpus");

// 3. Condition corpus
const COND_CODES = ["eq", "ne", "cs", "hs", "cc", "lo", "mi", "pl", "vs", "vc", "hi", "ls", "ge", "lt", "gt", "le", "al", "nv"];
for (const cond of COND_CODES) {
  assert.deepEqual(facade.condInfo(cond), directOperands.condInfo(cond), `condInfo mismatch on: "${cond}"`);
}
console.log("  ok 3 condition corpus");

// 4. Register role corpus
for (let num = 0; num < 32; num++) {
  assert.deepEqual(facade.registerRole(num), directAapcs.registerRole(num));
}
assert.deepEqual(facade.registerRole(31, true, false), directAapcs.registerRole(31, true, false));
assert.deepEqual(facade.registerRole(31, false, true), directAapcs.registerRole(31, false, true));

assert.equal(directAapcs.registerRole(31, true, false).id, "sp");
assert.equal(directAapcs.registerRole(31, false, true).id, "zr");
assert.equal(directAapcs.registerRole(0).id, "arg");
assert.equal(directAapcs.registerRole(8).id, "x8");
assert.equal(directAapcs.registerRole(9).id, "temp");
assert.equal(directAapcs.registerRole(16).id, "ip");
assert.equal(directAapcs.registerRole(18).id, "x18");
assert.equal(directAapcs.registerRole(19).id, "saved");
assert.equal(directAapcs.registerRole(29).id, "fp");
assert.equal(directAapcs.registerRole(30).id, "lr");
for (const invalid of ["1", -1, 1.5, NaN, Infinity, -Infinity, 32, 99, null, undefined]) {
  assert.equal(directAapcs.registerRole(invalid).id, "gp", `invalid register number must remain generic: ${String(invalid)}`);
}
assert.equal(directAapcs.registerRole("invalid", true, false).id, "sp", "explicit SP role must keep precedence");
assert.equal(directAapcs.registerRole("invalid", false, true).id, "zr", "explicit ZR role must keep precedence");
console.log("  ok 4 register role corpus");

// 5. Public facade smoke coverage
assert.equal(facade.referenceTarget("b", "#0x1000"), 0x1000n);
assert.equal(facade.isBranch("b"), true);
assert.equal(facade.isCall("bl"), true);
assert.equal(facade.isReturn("ret"), true);
assert.equal(typeof facade.categoryOf("add"), "string");
assert.equal(typeof facade.categoryLabel("arith"), "string");
assert.equal(typeof facade.explain("add", "x0, x1, x2"), "object");
assert.equal(typeof facade.brief("add", "x0, x1, x2"), "string");
facade.clearBriefCache();
console.log("  ok 5 public facade smoke");

// 6. Atomic ordering/size variants must stay in the atomic category (#1827).
for (const mnemonic of [
  "casb", "cash", "casab", "caslh", "casalb",
  "swpb", "swpah", "swplb", "swpalh",
  "ldaddb", "ldaddah", "ldaddlb", "ldaddalh",
  "ldseta", "ldsetalh", "ldclrlb", "ldclral", "ldeorb", "ldeoralh",
]) {
  assert.equal(facade.categoryOf(mnemonic), "atomic", `${mnemonic} must be classified as atomic`);
}
for (const mnemonic of ["casx", "swpaa", "ldaddq", "ldsetall"]) {
  assert.notEqual(facade.categoryOf(mnemonic), "atomic", `${mnemonic} is not a canonical atomic variant`);
}
assert.equal(facade.categoryOf("ldxr"), "load", "exclusive loads retain their established presentation category");
assert.equal(facade.categoryOf("stxr"), "store", "exclusive stores retain their established presentation category");
assert.equal(facade.categoryOf("dmb"), "system", "barriers retain their established presentation category");
console.log("  ok 6 atomic category variants");

// 7. Presentation parser must reject non-existent SIMD/FP registers and lanes (#2068, #2070).
for (const valid of ["b31", "h31", "s31", "d31", "q31", "v31.16b"]) {
  assert.equal(directOperands.parseOperands(valid)[0]?.k, "reg", `${valid} must remain a valid register`);
}
for (const invalid of ["b32", "h32", "s32", "d32", "q32", "q99", "v32.16b", "v99.16b"]) {
  assert.equal(directOperands.parseOperands(invalid)[0]?.k, "other", `${invalid} must fail soft instead of becoming a register`);
}
for (const valid of ["v0.b[15]", "v0.h[7]", "v0.s[3]", "v0.d[1]", "v31.b[0]"]) {
  assert.equal(directOperands.parseOperands(valid)[0]?.k, "elem", `${valid} must remain a valid vector element`);
}
for (const invalid of ["v0.b[16]", "v0.h[8]", "v0.s[4]", "v0.d[2]", "v32.b[0]"]) {
  assert.equal(directOperands.parseOperands(invalid)[0]?.k, "other", `${invalid} must fail soft instead of becoming a vector element`);
}
console.log("  ok 7 SIMD/FP register and vector-lane bounds (#2068 #2070)");

// 8. analyzeFunction must use the architectural effective immediate for ADD/SUB (#2051).
function analyzerBackend(instructions) {
  const mn = [];
  const ops = [];
  instructions.forEach((insn, index) => {
    mn[index] = insn.mn;
    ops[index] = insn.ops;
  });
  return { async fetchChunk() { return { mn, ops, bytes: null }; } };
}

async function analyzeArm64Fixture(instructions) {
  const region = { id: "arm64-shifted-imm", vmAddr: 0x100000n, size: BigInt(instructions.length * 4) };
  return analyzeFunction(analyzerBackend(instructions), region, 0, instructions.length - 1, null, null, { texts: false });
}

for (const [ops, expected] of [
  ["sp, sp, #0x20", 32],
  ["sp, sp, #1, lsl #0", 1],
  ["sp, sp, #1, lsl #12", 4096],
  ["sp, sp, #2, lsl #12", 8192],
]) {
  const result = await analyzeArm64Fixture([{ mn: "sub", ops }]);
  assert.equal(result.frameBytes, expected, `sub ${ops} must produce frameBytes=${expected}`);
}
{
  const result = await analyzeArm64Fixture([
    { mn: "adrp", ops: "x8, #0x100000" },
    { mn: "add", ops: "x8, x8, #1" },
  ]);
  assert.deepEqual(result.stringRefs.map((ref) => ref.addr), [0x100001n]);
}
{
  const result = await analyzeArm64Fixture([
    { mn: "adrp", ops: "x8, #0x100000" },
    { mn: "add", ops: "x8, x8, #1, lsl #12" },
  ]);
  assert.deepEqual(result.stringRefs.map((ref) => ref.addr), [0x101000n]);
}
for (const malformed of ["sp, sp, #1, lsl #1", "sp, sp, #1, lsr #12"]) {
  const result = await analyzeArm64Fixture([{ mn: "sub", ops: malformed }]);
  assert.equal(result.frameBytes, 0, `unsupported shift must not manufacture frame size: ${malformed}`);
}
for (const malformed of ["x8, x8, #1, lsl #1", "x8, x8, #1, lsr #12"]) {
  const result = await analyzeArm64Fixture([
    { mn: "adrp", ops: "x8, #0x100000" },
    { mn: "add", ops: malformed },
  ]);
  assert.equal(result.stringRefs.length, 0, `unsupported shift must not manufacture ADRP+ADD ref: ${malformed}`);
}
console.log("  ok 8 shifted ADD/SUB immediate analyzer regression (#2051)");

console.log("All ARM64 presentation compatibility tests PASS!");
