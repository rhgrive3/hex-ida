// ARM64 Intra-Function Value Slicer DI Adapter (§13.2 `HexIntraSliceEdge24` parity).
// Backward slicing properly kills redefined `dstPort` per instruction.
// INV-005: Lives under js/targets/architecture/arm64/, ZERO imports from js/targets/abi/.

export const INTRA_SLICE_MAX_NODES = 512;

export const SLICE_EDGE_ROLE = Object.freeze({
  REG_DEF_USE: 0,
  STACK_LOAD: 1,
  STACK_STORE: 2,
  FIELD_LOAD: 3,
  FIELD_STORE: 4,
});

function readU32(bytes, off) {
  return (
    (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0
  );
}

function normalizeRegPort(port) {
  const s = String(port ?? '').toLowerCase();
  const m = /^[xw](\d+)$/.exec(s);
  if (m) return `x${parseInt(m[1], 10)}`;
  if (s === 'arg0') return 'x0';
  if (s === 'arg1') return 'x1';
  if (s === 'arg2') return 'x2';
  if (s === 'arg3') return 'x3';
  if (s === 'ret') return 'x0';
  return s;
}

function decodeInsnDefUse(w, insnVa) {
  const edges = [];

  // MOVZ/MOVN (defines Rd with constant — no register source, kills previous Rd!)
  if ((w & 0x1f800000) === 0x12800000) {
    const opc = (w >>> 29) & 3;
    const rd = w & 0x1f;
    if (rd !== 31 && (opc === 0 || opc === 2)) {
      edges.push({
        insnVa,
        srcPort: 'imm',
        dstPort: `x${rd}`,
        role: SLICE_EDGE_ROLE.REG_DEF_USE,
        accessWidth: ((w >>> 31) & 1) ? 8 : 4,
        fieldOff: 0,
      });
    }
    return edges;
  }

  // ADD/SUB immediate: Rd = Rn +/- imm
  if ((w & 0x1f800000) === 0x11000000) {
    const rd = w & 0x1f;
    const rn = (w >>> 5) & 0x1f;
    const setFlags = Boolean((w >>> 29) & 1);
    if (!(rd === 31 && setFlags)) {
      edges.push({
        insnVa,
        srcPort: rn === 31 ? 'sp' : `x${rn}`,
        dstPort: rd === 31 ? 'sp' : `x${rd}`,
        role: SLICE_EDGE_ROLE.REG_DEF_USE,
        accessWidth: ((w >>> 31) & 1) ? 8 : 4,
        fieldOff: 0,
      });
    }
    return edges;
  }

  // ADD/SUB/AND/ORR/EOR shifted register: Rd = op(Rn, Rm)
  if ((w & 0x1f200000) === 0x0b000000 || (w & 0x1f000000) === 0x0a000000) {
    const rd = w & 0x1f;
    const rn = (w >>> 5) & 0x1f;
    const rm = (w >>> 16) & 0x1f;
    const width = ((w >>> 31) & 1) ? 8 : 4;
    if (rd !== 31) {
      if (rn !== 31) {
        edges.push({ insnVa, srcPort: `x${rn}`, dstPort: `x${rd}`, role: SLICE_EDGE_ROLE.REG_DEF_USE, accessWidth: width, fieldOff: 0 });
      }
      if (rm !== 31) {
        edges.push({ insnVa, srcPort: `x${rm}`, dstPort: `x${rd}`, role: SLICE_EDGE_ROLE.REG_DEF_USE, accessWidth: width, fieldOff: 0 });
      }
    }
    return edges;
  }

  // LDR / STR unsigned offset: [Rn, #uimm]
  if ((w & 0x3f000000) === 0x39000000) {
    const size = (w >>> 30) & 3;
    const width = 1 << size;
    const isLoad = Boolean((w >>> 22) & 1);
    const imm = ((w >>> 10) & 0xfff) * width;
    const rn = (w >>> 5) & 0x1f;
    const rt = w & 0x1f;
    if (rn === 31) {
      const slot = `stack:${imm}`;
      if (isLoad) {
        edges.push({ insnVa, srcPort: slot, dstPort: `x${rt}`, role: SLICE_EDGE_ROLE.STACK_LOAD, accessWidth: width, fieldOff: imm });
      } else {
        edges.push({ insnVa, srcPort: `x${rt}`, dstPort: slot, role: SLICE_EDGE_ROLE.STACK_STORE, accessWidth: width, fieldOff: imm });
      }
    } else if (isLoad) {
      edges.push({ insnVa, srcPort: `x${rn}`, dstPort: `x${rt}`, role: SLICE_EDGE_ROLE.FIELD_LOAD, accessWidth: width, fieldOff: imm });
    } else {
      edges.push({ insnVa, srcPort: `x${rt}`, dstPort: `x${rn}`, role: SLICE_EDGE_ROLE.FIELD_STORE, accessWidth: width, fieldOff: imm });
    }
    return edges;
  }

  return edges;
}

/**
 * Intra-function backward or forward ARM64 slice adapter (`hex_slice_intra_arm64` parity).
 * Backward slicing kills redefined `dstPort` per instruction so dead prior definitions do not leak in.
 */
export function sliceIntraArm64(codeBytes, funcVa = 0n, seedPort = 'x0', direction = 'backward', maxNodes = INTRA_SLICE_MAX_NODES) {
  const bytes = codeBytes instanceof Uint8Array ? codeBytes : new Uint8Array(codeBytes || 0);
  const baseVa = BigInt(funcVa);
  const limit = Math.max(1, Math.min(INTRA_SLICE_MAX_NODES, maxNodes));
  const totalWords = Math.floor(bytes.length / 4);

  const insnGroups = [];
  for (let i = 0; i < totalWords; i++) {
    const w = readU32(bytes, i * 4);
    const va = baseVa + BigInt(i * 4);
    const edges = decodeInsnDefUse(w, va);
    if (edges.length > 0) insnGroups.push(edges);
  }

  const activePorts = new Set([normalizeRegPort(seedPort)]);
  const outEdges = [];

  if (direction === 'backward') {
    for (let g = insnGroups.length - 1; g >= 0 && outEdges.length < limit; g--) {
      const group = insnGroups[g];
      const matched = group.filter((e) => activePorts.has(e.dstPort));
      if (matched.length === 0) continue;

      // Kill redefined dstPorts, then add all source ports for this instruction
      const killed = new Set(matched.map((e) => e.dstPort));
      for (const d of killed) activePorts.delete(d);

      for (const e of matched) {
        if (outEdges.length >= limit) break;
        outEdges.push(e);
        if (e.srcPort !== 'imm') {
          activePorts.add(e.srcPort);
        }
      }
    }
    outEdges.reverse();
  } else {
    for (let g = 0; g < insnGroups.length && outEdges.length < limit; g++) {
      const group = insnGroups[g];
      const matched = group.filter((e) => activePorts.has(e.srcPort));
      if (matched.length === 0) continue;
      for (const e of matched) {
        if (outEdges.length >= limit) break;
        outEdges.push(e);
        activePorts.add(e.dstPort);
      }
    }
  }

  const boundaryPorts = [...activePorts].filter((p) => /^x[0-7]$/.test(p));
  return {
    direction,
    seedPort: normalizeRegPort(seedPort),
    edges: outEdges,
    boundaryPorts,
  };
}

export const arm64IntraSliceAdapter = Object.freeze({
  arch: 'arm64',
  sliceIntra: sliceIntraArm64,
});
