import assert from "node:assert/strict";
import { parseObjcExtendedMetadata, buildObjcRuntimeModel } from "../js/objc.js";

console.log("Testing Issue #2602 ObjC metadata cancellation and demand regressions...");

{
  const mem = new Uint8Array(0x5000);
  const dv = new DataView(mem.buffer);
  const p64 = (at, v) => dv.setBigUint64(at, BigInt(v), true);
  const p32 = (at, v) => dv.setUint32(at, Number(v) >>> 0, true);
  const str = (at, s) => { for (let i = 0; i < s.length; i++) mem[at + i] = s.charCodeAt(i); mem[at + s.length] = 0; };
  const read = async (addr, len) => {
    const at = Number(addr);
    if (at < 0 || at >= mem.length) return null;
    return mem.subarray(at, Math.min(mem.length, at + len));
  };

  // Setup protocol list
  p64(0x100, 0x1000);
  p64(0x1000 + 8, 0x1800);       // name
  p64(0x1000 + 16, 0);           // inherited protocol list
  p64(0x1000 + 24, 0x1100);      // instance methods
  str(0x1800, "CoinProviding");

  p32(0x1100, 24); p32(0x1104, 1);
  p64(0x1108, 0x1820);           // selector
  p64(0x1110, 0x1840);           // types
  p64(0x1118, 0);
  str(0x1820, "coinCount");
  str(0x1840, "q16@0:8");

  const sections = {
    protocolList: { vmAddr: 0x100n, size: 8n },
    categoryList: null,
  };

  // 1. Successful parse
  const res = await parseObjcExtendedMetadata(read, sections);
  assert.equal(res.protocols.length, 1);
  assert.equal(res.protocols[0].name, "CoinProviding");

  // 2. Cancelled parse
  const controller = new AbortController();
  controller.abort();
  const abortedRes = await parseObjcExtendedMetadata(read, sections, { signal: controller.signal });
  assert.equal(abortedRes.completeness.complete, false, "Aborted parse must be marked incomplete");
}

console.log("Issue #2602 regressions PASS!");
