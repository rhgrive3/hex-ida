#!/usr/bin/env node

import fs from 'node:fs/promises';

async function edit(path, transform) {
  const before = await fs.readFile(path, 'utf8');
  const after = transform(before);
  if (after === before) return false;
  await fs.writeFile(path, after);
  return true;
}

function replaceOnce(text, before, after, label) {
  const count = text.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}:expected-one-match:found-${count}`);
  return text.replace(before, after);
}

function replaceOrVerify(text, before, after, label) {
  if (text.includes(after)) return text;
  return replaceOnce(text, before, after, label);
}

const changed = [];

if (await edit('js/binary/macho-dyld.js', (source) => {
  let out = source;
  out = replaceOrVerify(
    out,
    "if(!budget.take({objects:2,operations:1,estimatedHeapBytes:320},'classic-bind-output')){fail('shared metadata budget exhausted while recording bind');return;}",
    "if(!budget.take({objects:2,operations:1,stringBytes:template.name.length*2,estimatedHeapBytes:320+template.name.length*2},'classic-bind-output')){fail('shared metadata budget exhausted while recording threaded bind');return;}",
    'threaded-retained-name-budget',
  );
  out = replaceOrVerify(
    out,
    "if (!symbol) { fail('bind encountered before a symbol was set'); return; }",
    "if (!symbol) { fail('bind encountered before a symbol was set'); return false; }",
    'bind-missing-symbol-result',
  );
  out = replaceOrVerify(
    out,
    "if (threadedTable.length < threadedTableLimit) { threadedTable.push(snapshotImport()); return; }",
    "if (threadedTable.length < threadedTableLimit) { threadedTable.push(snapshotImport()); return true; }",
    'threaded-table-bind-result',
  );
  out = replaceOrVerify(
    out,
    "fail(`threaded ordinal table exceeds declared ${threadedTableLimit} entries`);\n      return;",
    "fail(`threaded ordinal table exceeds declared ${threadedTableLimit} entries`);\n      return false;",
    'threaded-table-overflow-result',
  );
  out = replaceOrVerify(
    out,
    "if (!validLocation()) { fail(`bind location is outside segment ${segIndex} at +0x${segOffset.toString(16)}`); return; }",
    "if (!validLocation()) { fail(`bind location is outside segment ${segIndex} at +0x${segOffset.toString(16)}`); return false; }",
    'bind-location-result',
  );
  out = replaceOrVerify(
    out,
    "if(!budget.take({objects:2,operations:1,stringBytes:symbol.length*2,estimatedHeapBytes:320+symbol.length*2},'classic-bind-output')){fail('shared metadata budget exhausted while recording bind');return;}\n    image.imports.push(imp); status.decodedBinds++;",
    "if(!budget.take({objects:2,operations:1,stringBytes:symbol.length*2,estimatedHeapBytes:320+symbol.length*2},'classic-bind-output')){fail('shared metadata budget exhausted while recording bind');return false;}\n    image.imports.push(imp); status.decodedBinds++; return true;",
    'ordinary-bind-budget-result',
  );
  out = replaceOrVerify(
    out,
    "else if (op === 0x90) { bind(); segOffset += ptrSize; }\n    else if (op === 0xa0) { bind(); const x = r.uleb(p, 10, end); p = x.next; segOffset += ptrSize + x.value; }\n    else if (op === 0xb0) { bind(); segOffset += ptrSize + BigInt(imm) * ptrSize; }",
    "else if (op === 0x90) { if (!bind()) break; segOffset += ptrSize; }\n    else if (op === 0xa0) { if (!bind()) break; const x = r.uleb(p, 10, end); p = x.next; segOffset += ptrSize + x.value; }\n    else if (op === 0xb0) { if (!bind()) break; segOffset += ptrSize + BigInt(imm) * ptrSize; }",
    'direct-bind-failure-propagation',
  );
  out = replaceOrVerify(
    out,
    "const maxByBudget=Math.min(budget.remaining('operations'),Math.floor(budget.remaining('objects')/2));\n      const allowed=Math.max(0,Math.min(repeat,maxBySegment,maxByBudget));\n      for(let i=0;i<allowed;i++){bind();segOffset+=step;}",
    "const retainedNameBytes=Math.max(1,symbol.length*2);\n      const maxByBudget=Math.min(budget.remaining('operations'),Math.floor(budget.remaining('objects')/2),Math.floor(budget.remaining('stringBytes')/retainedNameBytes));\n      const allowed=Math.max(0,Math.min(repeat,maxBySegment,maxByBudget));\n      let completed=0;\n      for(;completed<allowed;completed++){if(!bind())break;segOffset+=step;}\n      if(completed<allowed) break;",
    'repeat-bind-failure-propagation',
  );
  return out;
})) changed.push('js/binary/macho-dyld.js');

if (await edit('js/names.js', (source) => {
  let out = source;
  out = replaceOrVerify(
    out,
    "this._deltaTotalBytes = 0;\n    this._deltaPrefix = this.id ? `${PREFIX}${this.id}.delta.` : null;",
    "this._deltaTotalBytes = 0;\n    this._deltaLoadComplete = true;\n    this._deltaPrefix = this.id ? `${PREFIX}${this.id}.delta.` : null;",
    'delta-complete-state',
  );
  out = replaceOrVerify(
    out,
    "  _loadDeltas() {\n    if (!this._deltaPrefix || typeof localStorage === 'undefined') return;\n    this._deltaBytes.clear(); this._deltaTotalBytes = 0;\n    const keys = [];",
    "  _loadDeltas() {\n    if (!this._deltaPrefix || typeof localStorage === 'undefined') { this._deltaLoadComplete = true; return; }\n    this._deltaLoadComplete = false;\n    this._deltaBytes.clear(); this._deltaTotalBytes = 0;\n    const keys = [];\n    let complete = true;",
    'delta-scan-start',
  );
  out = replaceOrVerify(
    out,
    "    } catch { return; }\n    keys.sort();\n    // One unreadable delta",
    "    } catch { return; }\n    keys.sort();\n    // One unreadable delta",
    'delta-key-scan-failure-stays-incomplete',
  );
  out = replaceOrVerify(
    out,
    "      try { raw = localStorage.getItem(storageKey); } catch { continue; }\n      if (raw == null) continue;",
    "      try { raw = localStorage.getItem(storageKey); } catch { complete = false; continue; }\n      if (raw == null) { complete = false; continue; }",
    'delta-record-read-failure',
  );
  out = replaceOrVerify(
    out,
    "        if (!map || typeof delta?.key !== 'string') continue;\n        if (delta.deleted) map.delete(delta.key); else map.set(delta.key, String(delta.value ?? ''));\n      } catch { /* base snapshot remains valid if a delta is unreadable */ }\n    }\n  }",
    "        if (!map || typeof delta?.key !== 'string') continue;\n        if (typeof delta.deleted !== 'boolean') continue;\n        if (!delta.deleted && typeof delta.value !== 'string') continue;\n        if (delta.deleted) map.delete(delta.key); else map.set(delta.key, delta.value);\n      } catch { /* base snapshot remains valid if a delta is unreadable */ }\n    }\n    this._deltaLoadComplete = complete;\n  }",
    'delta-schema-and-completion',
  );
  out = replaceOrVerify(
    out,
    "  _persistDelta(kind, recordKey, value) {\n    if (!this.id || !this._deltaPrefix) return this._saveFailure('NO_ID');",
    "  _persistDelta(kind, recordKey, value) {\n    if (!this.id || !this._deltaPrefix) return this._saveFailure('NO_ID');\n    if (!this._deltaLoadComplete) return this._saveFailure('DELTA_LOAD_INCOMPLETE');",
    'delta-persist-block',
  );
  out = replaceOrVerify(
    out,
    "  save() {\n    if (!this.id) return this._saveFailure('NO_ID');",
    "  save() {\n    if (!this.id) return this._saveFailure('NO_ID');\n    if (!this._deltaLoadComplete) return this._saveFailure('DELTA_LOAD_INCOMPLETE');",
    'snapshot-save-block',
  );
  return out;
})) changed.push('js/names.js');

const moves = [
  ['tests/issue-6302-memoryssa-binding-stale-identity.mjs', 'tests/phase7/issue-6302-memoryssa-binding-stale-identity.test.mjs'],
  ['tests/issue-6307-notestore-delta-resilience.mjs', 'tests/phase7/issue-6307-notestore-delta-resilience.test.mjs'],
];
for (const [from, to] of moves) {
  try {
    await fs.access(from);
    await fs.mkdir(to.slice(0, to.lastIndexOf('/')), { recursive: true });
    await fs.rename(from, to);
    changed.push(`${from} -> ${to}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await fs.access(to);
  }
}

for (const path of ['package.json', ...((await fs.readdir('.github/workflows')).map((name) => `.github/workflows/${name}`))]) {
  let text;
  try { text = await fs.readFile(path, 'utf8'); } catch { continue; }
  let next = text;
  for (const [from, to] of moves) next = next.split(from).join(to);
  if (next !== text) { await fs.writeFile(path, next); changed.push(path); }
}

console.log(JSON.stringify({ changed }, null, 2));
