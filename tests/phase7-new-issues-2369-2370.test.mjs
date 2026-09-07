import assert from "node:assert/strict";
import test from "node:test";
import { createSemanticCfg } from "../js/semantics/cfg/index.js";
import { createSemanticIrFunction } from "../js/semantics/ir/function.js";
import { buildSemanticSsa } from "../js/semantics/ssa/build.js";
import { analyzeLocalPointsTo } from "../js/analysis/pointsto/local.js";
import { createFunctionSummary } from "../js/analysis/summary/contract.js";
import { parseMachO } from "../js/binary/macho.js";
import { loaderProducer } from "../js/analysis/discovery/producers.js";

const origin = (id) => ({ instructionIds: [`instruction_${id}`] });

// Issue #2369: call node recovers return pointer provenance from complete callee summary
test("Issue #2369: call node recovers return pointer provenance from complete callee summary", () => {
  const calleeSummary = createFunctionSummary({
    functionId: "fn_identity",
    inputs: ["p"],
    returnValues: ["ret_p"],
    returnProvenance: [{ kind: "arg", argIndex: 0, offset: "16" }],
    status: {
      snapshotId: "snapshot-1",
      analyzerId: "summary-test",
      analyzerVersion: "1.0.0",
      completeness: "complete",
    },
  });

  const ir = createSemanticIrFunction({
    functionId: "fn_caller",
    entryBlockId: "entry",
    origin: origin("fn_caller"),
    blocks: [
      { id: "entry", nodeIds: ["node_base", "node_call"], origin: origin("entry") },
    ],
    values: [
      { id: "base", kind: "definition", definitionNodeId: "node_base", machineType: { kind: "bitvector", widthBits: 64 }, origin: origin("val_base") },
      { id: "call_ret", kind: "definition", definitionNodeId: "node_call", machineType: { kind: "bitvector", widthBits: 64 }, origin: origin("val_call_ret") },
    ],
    nodes: [
      {
        id: "node_base",
        kind: "state-read",
        blockId: "entry",
        inputs: [],
        outputs: ["base"],
        variable: { key: "state:x0", kind: "physical-state", scope: "function" },
        origin: origin("node_base"),
      },
      {
        id: "node_call",
        kind: "call",
        blockId: "entry",
        inputs: ["base"],
        outputs: ["call_ret"],
        call: {
          targetEntityIds: ["fn_identity"],
          completeness: "complete",
          memoryRead: { scope: "none" },
          memoryWrite: { scope: "none" },
          determinism: "deterministic",
          noreturn: false,
          mayThrow: false,
          summarySource: "test",
        },
        origin: origin("node_call"),
      },
    ],
  });
  const cfg = createSemanticCfg({
    functionId: "fn_caller",
    entryBlockId: "entry",
    blocks: [{ id: "entry", successors: [] }],
  });
  const ssa = buildSemanticSsa(ir, cfg);

  const res = analyzeLocalPointsTo(ir, cfg, ssa, {
    snapshotId: "snapshot-caller",
    summaries: new Map([["fn_identity", calleeSummary]]),
  });
  const callPointsTo = res.pointsTo.get("call_ret");
  assert.ok(callPointsTo, "call_ret points-to must exist");
  assert.equal(callPointsTo.top, false);
  assert.equal(callPointsTo.targets.length, 1);
  const basePointsTo = res.pointsTo.get("base");
  assert.equal(callPointsTo.targets[0].rootEntityId, basePointsTo.targets[0].rootEntityId);
  assert.equal(callPointsTo.targets[0].offsetRange.min, 16n);
});

// Issue #2370: Mach-O compact unwind entries generate canonical unwindEntries and function starts
test("Issue #2370: Mach-O compact unwind entries generate canonical unwindEntries and function starts", () => {
  const buf = new Uint8Array(1024);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0xfeedfacf, true); // MH_MAGIC_64
  dv.setUint32(4, 0x0100000c, true); // ARM64
  dv.setUint32(8, 0x00000000, true);
  dv.setUint32(12, 2, true); // MH_EXECUTE
  dv.setUint32(16, 1, true); // ncmds
  dv.setUint32(20, 152, true); // sizeofcmds
  dv.setUint32(24, 0, true);

  // LC_SEGMENT_64
  dv.setUint32(32, 0x19, true);
  dv.setUint32(36, 152, true);
  for (let i = 0; i < 6; i++) dv.setUint8(40 + i, "__TEXT".charCodeAt(i));
  dv.setBigUint64(56, 0x100000000n, true);
  dv.setBigUint64(64, 0x1000n, true);
  dv.setBigUint64(72, 0n, true);
  dv.setBigUint64(80, 1024n, true);
  dv.setUint32(88, 5, true);
  dv.setUint32(92, 5, true);
  dv.setUint32(96, 1, true);
  dv.setUint32(100, 0, true);

  // Section 1 (__TEXT,__unwind_info)
  for (let i = 0; i < 13; i++) dv.setUint8(104 + i, "__unwind_info".charCodeAt(i));
  for (let i = 0; i < 6; i++) dv.setUint8(120 + i, "__TEXT".charCodeAt(i));
  dv.setBigUint64(136, 0x100000200n, true);
  dv.setBigUint64(144, 128n, true);
  dv.setUint32(152, 0x200, true);
  dv.setUint32(156, 2, true);

  // __unwind_info at 0x200 (512)
  const uOff = 512;
  dv.setUint32(uOff, 1, true);
  dv.setUint32(uOff + 20, 32, true);
  dv.setUint32(uOff + 24, 2, true);

  // First level index
  dv.setUint32(uOff + 32, 0x400, true);
  dv.setUint32(uOff + 36, 64, true);
  dv.setUint32(uOff + 40, 0, true);
  dv.setUint32(uOff + 44, 0x500, true);
  dv.setUint32(uOff + 48, 0, true);
  dv.setUint32(uOff + 52, 0, true);

  // 2nd level page: regular
  const pOff = uOff + 64;
  dv.setUint32(pOff, 2, true);
  dv.setUint16(pOff + 4, 8, true);
  dv.setUint16(pOff + 6, 1, true);
  dv.setUint32(pOff + 8, 0x400, true);
  dv.setUint32(pOff + 12, 0, true);

  const img = parseMachO(buf);
  assert.equal(img.unwindEntries.length, 1);
  assert.equal(img.unwindEntries[0].start, 0x100000400n);

  const discovery = loaderProducer.produce({ image: img });
  const unwindEvidence = discovery.filter(e => e.kind === "unwind-entry");
  assert.equal(unwindEvidence.length, 1);
  assert.equal(unwindEvidence[0].start, "4294968320");
});
