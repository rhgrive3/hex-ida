import {
  X86_LONG64_CANONICAL_EFFECT_OWNERS,
  classifyX86Long64WitnessPrefix,
} from "./x86-long64-decoder-denominator.mjs";

export const X86_LONG64_CLOSURE_MATRIX_SCHEMA = "x86-long64-closure-matrix/v1";
export const X86_LONG64_CLOSURE_MATRIX_ID = "x86_64:long-64:1487-witnesses-semantic-closure-matrix:v1";

const CANONICAL_OWNERS_SET = new Set(X86_LONG64_CANONICAL_EFFECT_OWNERS);

function extractFaultKinds(bundle) {
  if (!bundle || !Array.isArray(bundle.possibleFaults)) return [];
  return [...new Set(bundle.possibleFaults.map((f) => f?.kind).filter(Boolean))].sort();
}

function extractRegisterAccesses(bundle) {
  const reads = new Set();
  const writes = new Set();
  if (bundle && Array.isArray(bundle.operations)) {
    for (const op of bundle.operations) {
      if (op.kind === "register-read" && op.register?.registerId) reads.add(op.register.registerId);
      if (op.kind === "register-write" && op.register?.registerId) writes.add(op.register.registerId);
    }
  }
  return {
    reads: [...reads].sort(),
    writes: [...writes].sort(),
  };
}

function extractMemoryAccesses(bundle) {
  let reads = 0;
  let writes = 0;
  if (bundle && Array.isArray(bundle.operations)) {
    for (const op of bundle.operations) {
      if (op.kind === "memory-read") reads++;
      if (op.kind === "memory-write") writes++;
    }
  }
  return { reads, writes };
}

function inferRequiredFeature(name, prefixKind, rawBytes) {
  const lower = name.toLowerCase();
  if (prefixKind === "evex") return "avx512f";
  if (prefixKind === "xop") return "xop";
  if (prefixKind === "3dnow") return "3dnow";
  if (prefixKind === "vex2" || prefixKind === "vex3") {
    if (/^v(aes|pclmulqdq)/.test(lower)) return "vaes";
    if (/^v(sha)/.test(lower)) return "sha";
    if (/^v(fma|fmadd|fmsub|fnmadd|fnmsub)/.test(lower)) return "fma";
    if (/^v(p?andn?|p?or|p?xor|padd|psub|pmul|pdiv|blend|perm|gather)/.test(lower) && prefixKind === "vex3") return "avx2";
    return "avx";
  }
  if (/^aes/.test(lower)) return "aes";
  if (/^sha/.test(lower)) return "sha";
  if (/^pclmulqdq/.test(lower)) return "pclmulqdq";
  if (/^rdrand/.test(lower)) return "rdrand";
  if (/^rdseed/.test(lower)) return "rdseed";
  if (/^(popcnt|lzcnt|tzcnt|andn|bextr|blsi|blsmsk|blsr)/.test(lower)) return "bmi1";
  if (/^(bzhi|mulx|pdep|pext|rorx|sarx|shlx|shrx)/.test(lower)) return "bmi2";
  if (/^(adcx|adox)/.test(lower)) return "adx";
  if (/^cmpxchg16b/.test(lower)) return "cx16";
  if (/^cmpxchg8b/.test(lower)) return "cx8";
  return "base";
}

export function evaluateX86Long64ClosureMatrix(decodedWitnessRows, dispatchFunction) {
  if (!Array.isArray(decodedWitnessRows)) throw new TypeError("x86-closure-matrix-decoded-rows-required");
  if (typeof dispatchFunction !== "function") throw new TypeError("x86-closure-matrix-dispatch-function-required");

  const rows = [];
  const byCompleteness = { exact: 0, "exact-with-intrinsic": 0, partial: 0, unowned: 0 };
  const byOwner = Object.fromEntries(X86_LONG64_CANONICAL_EFFECT_OWNERS.map((owner) => [owner, 0]));
  const completenessByOwner = Object.fromEntries(
    X86_LONG64_CANONICAL_EFFECT_OWNERS.map((owner) => [owner, { exact: 0, "exact-with-intrinsic": 0, partial: 0, unowned: 0 }])
  );
  const blockingGaps = [];

  for (const item of decodedWitnessRows) {
    const id = Number(item.id);
    const name = String(item.name);
    const hex = String(item.hex);
    const instruction = item.instruction;
    const prefixKind = classifyX86Long64WitnessPrefix(instruction.rawBytes);

    const outcome = dispatchFunction(instruction);
    const isDispatch = outcome != null && typeof outcome === "object" && "ownerId" in outcome && "result" in outcome;
    const effect = isDispatch ? outcome.result : outcome;
    const ownerId = isDispatch ? outcome.ownerId : (effect ? String(effect.metadata?.family || "unowned").toLowerCase() : "unowned");

    const validOwner = CANONICAL_OWNERS_SET.has(ownerId);
    const completeness = effect?.completeness ?? (validOwner && effect != null ? "exact" : "unowned");

    if (byCompleteness[completeness] != null) byCompleteness[completeness]++;
    else byCompleteness.unowned++;

    if (validOwner) {
      byOwner[ownerId]++;
      if (completenessByOwner[ownerId][completeness] != null) {
        completenessByOwner[ownerId][completeness]++;
      }
    }

    const regAccess = extractRegisterAccesses(effect);
    const memAccess = extractMemoryAccesses(effect);
    const faults = extractFaultKinds(effect);
    const requiredFeature = inferRequiredFeature(name, prefixKind, instruction.rawBytes);

    const row = Object.freeze({
      id,
      name,
      hex,
      prefixKind,
      ownerId: validOwner ? ownerId : "unowned",
      completeness,
      partialReason: completeness === "partial" ? (effect?.unknownEffects?.reason ?? "unknown-effects") : null,
      requiredFeature,
      registersRead: regAccess.reads,
      registersWritten: regAccess.writes,
      memoryReads: memAccess.reads,
      memoryWrites: memAccess.writes,
      controlEffectKind: effect?.controlEffect?.kind ?? "none",
      faultKinds: faults,
    });
    rows.push(row);

    if (completeness === "partial" || completeness === "unowned" || !validOwner) {
      blockingGaps.push(Object.freeze({
        id,
        name,
        ownerId: validOwner ? ownerId : "unowned",
        completeness,
        reason: row.partialReason ?? "unowned-or-invalid-owner",
      }));
    }
  }

  const exactTotal = byCompleteness.exact + byCompleteness["exact-with-intrinsic"];
  const closed = rows.length > 0 && blockingGaps.length === 0 && byCompleteness.partial === 0 && byCompleteness.unowned === 0;

  return Object.freeze({
    schemaVersion: X86_LONG64_CLOSURE_MATRIX_SCHEMA,
    matrixId: X86_LONG64_CLOSURE_MATRIX_ID,
    profileId: "x86_64:long-64",
    totalWitnessCount: rows.length,
    exactCount: byCompleteness.exact,
    exactWithIntrinsicCount: byCompleteness["exact-with-intrinsic"],
    exactTotal,
    partialCount: byCompleteness.partial,
    unownedCount: byCompleteness.unowned,
    blockingGapCount: blockingGaps.length,
    closed,
    byCompleteness: Object.freeze(byCompleteness),
    byOwner: Object.freeze(byOwner),
    completenessByOwner: Object.freeze(completenessByOwner),
    blockingGaps: Object.freeze(blockingGaps),
    rows: Object.freeze(rows),
  });
}

export function validateX86Long64ClosureMatrix(matrix) {
  if (!matrix || matrix.schemaVersion !== X86_LONG64_CLOSURE_MATRIX_SCHEMA) {
    throw new TypeError("x86-closure-matrix-schema-invalid");
  }
  if (matrix.matrixId !== X86_LONG64_CLOSURE_MATRIX_ID) {
    throw new TypeError("x86-closure-matrix-id-mismatch");
  }
  if (matrix.totalWitnessCount !== 1487) {
    throw new TypeError("x86-closure-matrix-total-witness-count-drift:" + matrix.totalWitnessCount);
  }
  if (matrix.unownedCount !== 0) {
    throw new TypeError("x86-closure-matrix-unowned-witnesses-present:" + matrix.unownedCount);
  }
  if (matrix.exactCount + matrix.exactWithIntrinsicCount + matrix.partialCount !== matrix.totalWitnessCount) {
    throw new TypeError("x86-closure-matrix-completeness-partition-drift");
  }
  return true;
}
