import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const EVIDENCE = '/mnt/workspace/.dev-state/agent-work/evidence/hex-completion-20260924';
const OUT = path.join(EVIDENCE, 'cxxcmp');
const runs = {
  baselineA: { id: '35952309000', root: path.join(EVIDENCE, 'fbd/baseline-run-35952309000'), sha: 'c34d17ca90b00ffb2e1430413b49e911eb07d319' },
  baselineB: { id: '35952313066', root: path.join(EVIDENCE, 'fbd/baseline-run-35952313066'), sha: 'c34d17ca90b00ffb2e1430413b49e911eb07d319' },
  aa4eA: { id: '36028638482', root: path.join(EVIDENCE, 'fbd/run-36028638482'), sha: 'aa4e29fe41f1b3d9fb9c5e63cbe336e0d81ed170' },
  aa4eB: { id: '36028782957', root: path.join(EVIDENCE, 'fbd/run-36028782957'), sha: 'aa4e29fe41f1b3d9fb9c5e63cbe336e0d81ed170' },
  finalA: { id: '36043298961', root: path.join(EVIDENCE, 'final-20260925/realgame-c-arm64-run-36043298961'), sha: '3180f7914dba48567188eaf2a4ff083906d007f5' },
  finalB: { id: '36043309557', root: path.join(EVIDENCE, 'final-20260925/realgame-c-arm64-run-36043309557'), sha: '3180f7914dba48567188eaf2a4ff083906d007f5' },
};
const games = ['openmw', 'openttd'];
const checkLog = [];
const check = (condition, message) => {
  if (!condition) throw new Error(`FAILED: ${message}`);
  checkLog.push(message);
};
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const readText = (file) => fs.readFileSync(file, 'utf8');
const readJson = (file) => JSON.parse(readText(file));
const gameDir = (run, game) => path.join(run.root, `realgame-${game}`);
const result = (run, game) => readJson(path.join(gameDir(run, game), 'result.json'));
const oracle = (run, game) => readJson(path.join(gameDir(run, game), 'oracle.json'));
const stages = (run, game) => readJson(path.join(gameDir(run, game), 'stages.json')).stages;
const targetRows = (j) => (j.classes || []).filter((row) => row.vtable != null);
const addressMap = (j, label) => {
  const map = new Map();
  for (const row of targetRows(j)) {
    const addr = String(row.vtable);
    if (map.has(addr)) throw new Error(`${label}: duplicate vtable address ${addr}`);
    map.set(addr, row);
  }
  return map;
};
const stableTableSignature = (j) => [...addressMap(j, 'signature').entries()]
  .sort(([a], [b]) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0)
  .map(([address, row]) => [address, row.slots, (row.slotTargets || []).map((t) => [t.index, String(t.address)])]);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const typeinfoTarget = (name) => /typeinfo|_ZTI|_ZTS|vtable for|_ZTV/i.test(name || '');
const escapeCell = (value) => String(value ?? '—').replaceAll('|', '\\|').replaceAll('\n', ' ');
const sortAddress = (a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
const excerptStatus = (row) => {
  if (!row) return 'not sampled; no call-level conclusion';
  const excerpt = row.excerpt || '';
  if (/unknown_call\s*\(/.test(excerpt)) return 'unknown_call visible; no proven virtual target';
  const excerptLength = excerpt.length;
  const codeChars = Number(row.codeChars || 0);
  if (excerptLength < codeChars) return `target not proven; excerpt truncated (${excerptLength}/${codeChars} chars)`;
  return 'target not proven by saved output';
};

const loaded = {};
for (const [tag, run] of Object.entries(runs)) {
  loaded[tag] = {};
  for (const game of games) loaded[tag][game] = result(run, game);
}

const addressComparisons = {};
const markerComparisons = {};
const runStability = {};
const summaries = {};

for (const game of games) {
  const oracleNames = new Set(readText(path.join(gameDir(runs.finalA, game), 'oracle-classes.txt')).split(/\r?\n/).filter(Boolean));
  const old = loaded.baselineA[game];
  const current = loaded.finalA[game];
  const oldVtableStages = stages(runs.baselineA, game).filter((stage) => stage.stage === 'vtables');
  const finalVtableStages = stages(runs.finalA, game).filter((stage) => stage.stage === 'vtables');
  const oldStageTotal = oldVtableStages.at(-1)?.detail?.total ?? null;
  const finalStageTotal = finalVtableStages.at(-1)?.detail?.total ?? null;
  const oldMap = addressMap(old, `${game}/old`);
  const currentMap = addressMap(current, `${game}/current`);
  const allAddresses = [...new Set([...oldMap.keys(), ...currentMap.keys()])].sort(sortAddress);
  let oldSlotsSum = 0;
  let currentSlotsSum = 0;
  let increased = 0;
  let decreased = 0;
  let unchanged = 0;
  let onlyOld = 0;
  let onlyCurrent = 0;
  const boundaryOffsets = {};
  let oracleOwnerMatchesChanged = 0;
  let missingRetainedTargets = 0;
  let changedRetainedTargetAddresses = 0;
  let changedRetainedTargetNames = 0;
  let retainedResolvedComparable = 0;
  const rows = [];

  for (const address of oldMap.keys()) oldSlotsSum += Number(oldMap.get(address).slots || 0);
  for (const address of currentMap.keys()) currentSlotsSum += Number(currentMap.get(address).slots || 0);

  for (const address of allAddresses) {
    const before = oldMap.get(address) || null;
    const after = currentMap.get(address) || null;
    const owner = before?.name ?? after?.name ?? null;
    if (!before) onlyCurrent++;
    if (!after) onlyOld++;
    const delta = before && after ? Number(after.slots || 0) - Number(before.slots || 0) : null;
    if (delta > 0) increased++;
    else if (delta < 0) decreased++;
    else if (delta === 0) unchanged++;

    let boundary = null;
    let boundaryOffset = null;
    if (before && after && delta < 0) {
      boundary = (before.slotTargets || []).filter((target) => Number(target.index) >= Number(after.slots))
        .find((target) => typeinfoTarget(target.name)) || null;
      if (boundary) {
        boundaryOffset = Number(boundary.index) - Number(after.slots);
        boundaryOffsets[boundaryOffset] = (boundaryOffsets[boundaryOffset] || 0) + 1;
      }
      if (oracleNames.has(before.name)) oracleOwnerMatchesChanged++;
    }

    if (before && after) {
      const oldTargets = new Map((before.slotTargets || []).filter((target) => Number(target.index) < Number(after.slots)).map((target) => [Number(target.index), target]));
      const newTargets = new Map((after.slotTargets || []).filter((target) => Number(target.index) < Number(after.slots)).map((target) => [Number(target.index), target]));
      for (const index of new Set([...oldTargets.keys(), ...newTargets.keys()])) {
        const a = oldTargets.get(index);
        const b = newTargets.get(index);
        if (a && !b) missingRetainedTargets++;
        else if (a && b) {
          retainedResolvedComparable++;
          if (String(a.address) !== String(b.address)) changedRetainedTargetAddresses++;
          else if ((a.name || null) !== (b.name || null)) changedRetainedTargetNames++;
        }
      }
    }

    rows.push({
      address,
      owner,
      oldSlots: before ? Number(before.slots || 0) : null,
      newSlots: after ? Number(after.slots || 0) : null,
      delta,
      oldPresent: !!before,
      newPresent: !!after,
      oracleOwnerExact: owner != null && oracleNames.has(owner),
      boundaryIndex: boundary ? Number(boundary.index) : null,
      boundaryOffsetFromNewEnd: boundaryOffset,
      boundaryAddress: boundary ? String(boundary.address) : null,
      boundarySymbol: boundary?.name ?? null,
    });
  }

  check(old.classes.length === 300 && current.classes.length === 300, `${game}: baseline and final result each contain the reported 300-class sample`);
  check(oldSlotsSum === old.totals.vtableSlots, `${game}: baseline per-address slot sum equals totals.vtableSlots`);
  check(currentSlotsSum === current.totals.vtableSlots, `${game}: final per-address slot sum equals totals.vtableSlots`);
  check(onlyOld === 0 && onlyCurrent === 0, `${game}: every recorded vtable address is present on both sides`);
  check(increased === 0, `${game}: no recorded vtable address increases its slot count`);
  check(missingRetainedTargets === 0 && changedRetainedTargetAddresses === 0, `${game}: no resolved target address disappears or changes within the retained slot range`);
  check(Object.keys(boundaryOffsets).every((offset) => offset === '0' || offset === '1') && Object.values(boundaryOffsets).reduce((sum, count) => sum + count, 0) === decreased, `${game}: every changed table has an immediate RTTI marker at the new end or one word after it`);
  check(oldStageTotal === 300 && finalStageTotal === 300, `${game}: stages.json records the same 300-class vtable scan sample`);
  check(equal(stableTableSignature(loaded.baselineA[game]), stableTableSignature(loaded.baselineB[game])), `${game}: both old baseline runs have identical per-address slot and target-address records`);
  check(equal(stableTableSignature(loaded.aa4eA[game]), stableTableSignature(loaded.aa4eB[game])), `${game}: both aa4e runs have identical per-address slot and target-address records`);
  check(equal(stableTableSignature(loaded.finalA[game]), stableTableSignature(loaded.finalB[game])), `${game}: both 3180 runs have identical per-address slot and target-address records`);
  check(equal(stableTableSignature(loaded.aa4eA[game]), stableTableSignature(loaded.finalA[game])), `${game}: aa4e and final 3180 have identical per-address slot and target-address records`);

  const retainedTargetCount = current.totals.resolvedVtableSlots;
  check(retainedResolvedComparable === retainedTargetCount, `${game}: every final resolved target slot is matched to the same old address`);

  const oldRows = new Map(old.decompiled.map((row) => [String(row.address), row]));
  const midRows = new Map(loaded.aa4eA[game].decompiled.map((row) => [String(row.address), row]));
  const finalRows = new Map(current.decompiled.map((row) => [String(row.address), row]));
  const markerRows = [];
  for (const [address, before] of oldRows) {
    const oldMarkers = Number(before.indirectCallMarkers || 0);
    if (oldMarkers <= 0) continue;
    for (const [tag, rowsByAddress] of [['aa4e', midRows], ['3180', finalRows]]) {
      const after = rowsByAddress.get(address) || null;
      const newMarkers = after ? Number(after.indirectCallMarkers || 0) : null;
      markerRows.push({
        address,
        oldName: before.name ?? null,
        oldMarkers,
        comparisonHead: tag,
        newMarkers,
        sampled: !!after,
        newSemantic: after?.semantic ?? null,
        excerptLength: after?.excerpt?.length ?? null,
        codeChars: after?.codeChars ?? null,
        status: !after ? 'not sampled; no call-level conclusion' : (newMarkers >= oldMarkers ? 'marker count retained; no marker loss' : excerptStatus(after)),
        newExcerpt: after?.excerpt ?? null,
      });
    }
  }
  markerComparisons[game] = markerRows;
  addressComparisons[game] = rows;
  summaries[game] = {
    oldTargetSha: old.targetSha,
    finalTargetSha: current.targetSha,
    binarySha256: old.sha256,
    finalBinarySha256: current.sha256,
    vtablesFromResultTotals: { old: old.totals.vtables, final: current.totals.vtables },
    sampledClasses: { old: old.classes.length, final: current.classes.length },
    vtableStageSample: { old: oldStageTotal, final: finalStageTotal },
    recordedVtableAddresses: { old: oldMap.size, final: currentMap.size },
    slotTotals: { old: oldSlotsSum, final: currentSlotsSum, delta: currentSlotsSum - oldSlotsSum },
    addressChanges: { decreased, unchanged, increased, onlyOld, onlyCurrent },
    immediateBoundaryMarkers: boundaryOffsets,
    changedOwnersExactInOracleClassList: oracleOwnerMatchesChanged,
    changedOwnersMissingExactOracleName: decreased - oracleOwnerMatchesChanged,
    retainedResolvedTargetAudit: {
      comparableTargets: retainedResolvedComparable,
      finalResolvedTargets: retainedTargetCount,
      missingOldTargetWithinFinalRange: missingRetainedTargets,
      changedTargetAddressesWithinFinalRange: changedRetainedTargetAddresses,
      sameAddressButChangedName: changedRetainedTargetNames,
    },
    oldMarkers: old.totals.indirectCallMarkers,
    aa4eMarkers: loaded.aa4eA[game].totals.indirectCallMarkers,
    finalMarkers: current.totals.indirectCallMarkers,
    sampleOverlap: {
      oldRows: old.decompiled.length,
      finalRows: current.decompiled.length,
      sharedAddresses: [...oldRows.keys()].filter((address) => finalRows.has(address)).length,
    },
    oracle: oracle(runs.finalA, game),
    oracleClassNameCount: oracleNames.size,
    oracleFilesByteIdenticalOldToFinal: Object.fromEntries(['oracle-classes.txt', 'oracle-dwarf-classes.txt', 'oracle-dwarf-members.txt', 'symbols.txt'].map((file) => {
      const a = fs.readFileSync(path.join(gameDir(runs.baselineA, game), file));
      const b = fs.readFileSync(path.join(gameDir(runs.finalA, game), file));
      return [file, sha256(a) === sha256(b)];
    })),
    markerLosses: markerRows,
  };
}

for (const game of games) {
  check(loaded.baselineA[game].targetSha === runs.baselineA.sha && loaded.baselineB[game].targetSha === runs.baselineB.sha, `${game}: old result artifacts bind the expected c34d baseline SHA`);
  check(loaded.aa4eA[game].targetSha === runs.aa4eA.sha && loaded.aa4eB[game].targetSha === runs.aa4eB.sha, `${game}: intermediate artifacts bind the expected aa4e SHA`);
  check(loaded.finalA[game].targetSha === runs.finalA.sha && loaded.finalB[game].targetSha === runs.finalB.sha, `${game}: final artifacts bind the expected 3180 SHA`);
  const a = oracle(runs.baselineA, game);
  const b = oracle(runs.finalA, game);
  check(a.sha256 === b.sha256 && a.buildId === b.buildId, `${game}: independent oracle confirms old and final artifacts are the same binary build`);
  check(equal(a.dynamic, b.dynamic), `${game}: independent dynamic oracle counts are unchanged`);
  check(equal(oracle(runs.baselineA, game), oracle(runs.finalA, game)), `${game}: oracle.json is identical from old to final`);
  check(Object.values(summaries[game].oracleFilesByteIdenticalOldToFinal).every(Boolean), `${game}: oracle class/DWARF/symbol sidecar bytes are identical old to final`);
}

check(loaded.baselineA.openmw.totals.indirectCallMarkers === 5 && loaded.aa4eA.openmw.totals.indirectCallMarkers === 0 && loaded.finalA.openmw.totals.indirectCallMarkers === 0, 'OpenMW marker totals reproduce 5 → 0 → 0 across baseline, aa4e, and final');
check(loaded.baselineA.openttd.totals.indirectCallMarkers === 4 && loaded.aa4eA.openttd.totals.indirectCallMarkers === 2 && loaded.finalA.openttd.totals.indirectCallMarkers === 1, 'OpenTTD marker totals reproduce 4 → 2 → 1; final run differs from the earlier 2-marker report');

const markdown = [];
markdown.push('# Same-address C++ vtable and indirect-call comparison');
markdown.push('');
markdown.push('Generated from the supplied real-game artifacts only. No game was rerun. The full slot table is address-joined over every vtable record in each `result.json` class sample. `oracleOwnerExact` means the result class label exactly matches a line in independent `oracle-classes.txt`; it is a name check, not a per-address DWARF slot oracle.');
markdown.push('');
markdown.push('## Vtable slot counts by address');
markdown.push('');
markdown.push('`delta = final 3180 slot count − old c34d slot count`. A boundary target is taken from the old row’s `slotTargets` at the first index at or after the final count whose symbol is RTTI/typeinfo. `+0` is a direct RTTI/typeinfo symbol at the first omitted index; `+1` is an RTTI/typeinfo target one word after the new end, consistent with the adjacent offset-to-top/typeinfo header. Full symbol labels are preserved in `address-comparison.json`.');
markdown.push('');
for (const game of games) {
  const summary = summaries[game];
  markdown.push(`### ${game}`);
  markdown.push('');
  markdown.push(`The staged scan and saved result each cover ${summary.vtableStageSample.old}/${summary.vtableStageSample.final} sampled classes. Recorded vtable addresses: ${summary.recordedVtableAddresses.old} old / ${summary.recordedVtableAddresses.final} final; shared ${summary.recordedVtableAddresses.old - summary.addressChanges.onlyOld}. Changed ${summary.addressChanges.decreased}, unchanged ${summary.addressChanges.unchanged}, increased ${summary.addressChanges.increased}, old-only ${summary.addressChanges.onlyOld}, final-only ${summary.addressChanges.onlyCurrent}. Slot sum ${summary.slotTotals.old} → ${summary.slotTotals.final} (${summary.slotTotals.delta}). Immediate RTTI boundary offsets: ${JSON.stringify(summary.immediateBoundaryMarkers)}.`);
  markdown.push('');
  markdown.push('| vtable address | result class label | old slots | final slots | Δ | owner in oracle class list | first post-end RTTI evidence |');
  markdown.push('|---:|---|---:|---:|---:|:---:|---|');
  for (const row of addressComparisons[game]) {
    const deltaText = row.delta == null ? 'n/a' : `${row.delta > 0 ? '+' : ''}${row.delta}`;
    let evidence = 'unchanged / no boundary difference';
    if (row.oldPresent && row.newPresent && row.delta < 0) {
      if (row.boundaryIndex == null) evidence = 'UNKNOWN: no RTTI target in old tail';
      else {
        const side = row.boundaryOffsetFromNewEnd === 0 ? 'at new end (+0)' : 'one word after new end (+1)';
        evidence = `slot ${row.boundaryIndex} (${side}): ${row.boundaryAddress} — ${row.boundarySymbol}`;
      }
    } else if (!row.oldPresent) evidence = 'present only in final';
    else if (!row.newPresent) evidence = 'present only in old';
    markdown.push(`| \`${escapeCell(row.address)}\` | ${escapeCell(row.owner)} | ${row.oldSlots ?? '—'} | ${row.newSlots ?? '—'} | ${deltaText} | ${row.oracleOwnerExact ? 'yes' : 'no exact match'} | ${escapeCell(evidence)} |`);
  }
  markdown.push('');
  markdown.push(`Retained target audit: ${summary.retainedResolvedTargetAudit.comparableTargets} target addresses compared; ${summary.retainedResolvedTargetAudit.missingOldTargetWithinFinalRange} missing and ${summary.retainedResolvedTargetAudit.changedTargetAddressesWithinFinalRange} changed addresses inside the final slot range; ${summary.retainedResolvedTargetAudit.sameAddressButChangedName} labels differ while the target address stays equal. Oracle owner-name matches among changed tables: ${summary.changedOwnersExactInOracleClassList}/${summary.addressChanges.decreased}; unmatched names remain unverified by this sidecar.`);
  markdown.push('');
}

markdown.push('## Indirect-call marker losses by function address');
markdown.push('');
markdown.push('The aa4e column reports the intermediate run used by the earlier lane; the final 3180 column is the requested latest artifact. `n/s` means the function address is absent from that run’s 20-row `decompiled` sample. A zero marker count alone is not a resolved virtual target. The saved result excerpt is truncated where shown; the table does not infer hidden call text.');
markdown.push('');
for (const game of games) {
  const byAddress = new Map();
  for (const row of markerComparisons[game]) {
    const current = byAddress.get(row.address) || { address: row.address, name: row.oldName, oldMarkers: row.oldMarkers };
    current[row.comparisonHead] = row;
    byAddress.set(row.address, current);
  }
  markdown.push(`### ${game}`);
  markdown.push('');
  markdown.push(`Aggregate marker totals: c34d ${summaries[game].oldMarkers} → aa4e ${summaries[game].aa4eMarkers} → final 3180 ${summaries[game].finalMarkers}. Shared decompiled addresses: ${summaries[game].sampleOverlap.sharedAddresses}/${summaries[game].sampleOverlap.oldRows}.`);
  markdown.push('');
  markdown.push('| function address | function label | c34d markers | aa4e markers / call evidence | final markers / call evidence |');
  markdown.push('|---:|---|---:|---|---|');
  for (const row of [...byAddress.values()].sort((a, b) => sortAddress(a.address, b.address))) {
    const render = (observation) => {
      if (!observation) return 'n/s; no target evidence';
      const count = observation.newMarkers == null ? 'n/s' : observation.newMarkers;
      return `${count}; ${observation.status}`;
    };
    markdown.push(`| \`${escapeCell(row.address)}\` | ${escapeCell(row.name)} | ${row.oldMarkers} | ${escapeCell(render(row.aa4e))} | ${escapeCell(render(row['3180']))} |`);
  }
  markdown.push('');
}

markdown.push('## Provenance and limitations');
markdown.push('');
markdown.push('| game | old SHA-256 | final SHA-256 | oracle dynamic counts old/final | oracle class names | debug/DWARF |');
markdown.push('|---|---|---|---|---:|---|');
for (const game of games) {
  const s = summaries[game];
  markdown.push(`| ${game} | \`${s.binarySha256}\` | \`${s.finalBinarySha256}\` | vtables ${s.oracle.dynamic.vtables}/${s.oracle.dynamic.vtables}, typeinfos ${s.oracle.dynamic.typeinfos}/${s.oracle.dynamic.typeinfos} | ${s.oracleClassNameCount} identical names | ${s.oracle.debug.status}, 0 classes / 0 members |`);
}
markdown.push('');
markdown.push('The independent sidecars prove the same binary build and provide an independently produced class-name set and dynamic RTTI counts. They do not contain per-address vtable extents, and the debug sidecars are empty because DWARF is unavailable. Therefore the address-level boundary evidence is the old per-slot target record plus the final emitted count, not an independent debug-symbol slot oracle. The final artifacts retain only 400-character excerpts for many longer decompiles, so the marker target status is unknown where the full call text is not saved.');
markdown.push('');
markdown.push('## Analysis checks');
markdown.push('');
markdown.push(`` + '`node /mnt/workspace/.dev-state/agent-work/evidence/hex-completion-20260924/cxxcmp/compare-addresses.mjs`' + ` — PASS ${checkLog.length}, FAIL 0. Checks are structural assertions over the supplied artifacts; they do not execute product tests.`);
markdown.push('');
markdown.push(checkLog.map((message) => `- PASS — ${message}`).join('\n'));
markdown.push('');

const json = {
  sourceRuns: Object.fromEntries(Object.entries(runs).map(([tag, run]) => [tag, { id: run.id, sha: run.sha, root: run.root }])),
  summaries,
  addressComparisons,
  markerComparisons,
  checks: { passed: checkLog.length, failed: 0, messages: checkLog },
};
const writeAtomic = (file, contents) => {
  const temporary = `${file}.writing-${process.pid}`;
  fs.writeFileSync(temporary, contents);
  fs.renameSync(temporary, file);
};
writeAtomic(path.join(OUT, 'address-comparison.json'), JSON.stringify(json, null, 2) + '\n');
writeAtomic(path.join(OUT, 'address-tables.md'), markdown.join('\n').replace(/\n+$/, '\n'));
console.log(JSON.stringify({ checksPassed: checkLog.length, checksFailed: 0, summaries: Object.fromEntries(games.map((game) => { const s = summaries[game]; return [game, { slotTotals: s.slotTotals, addressChanges: s.addressChanges, immediateBoundaryMarkers: s.immediateBoundaryMarkers, retainedResolvedTargetAudit: s.retainedResolvedTargetAudit, markerTotals: [s.oldMarkers, s.aa4eMarkers, s.finalMarkers], oracleClassNameCount: s.oracleClassNameCount }]; })), outputs: ['address-comparison.json', 'address-tables.md'] }, null, 2));
