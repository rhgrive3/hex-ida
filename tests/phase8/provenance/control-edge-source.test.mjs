import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildSemanticModel } from '../../../js/blocks.js';
import { decompile } from '../../../js/decompile.js';

const sourceText = fs.readFileSync(new URL('../../../js/decompiler/semantic-core.js', import.meta.url), 'utf8');

function assertHas(pattern, label) {
  assert.match(sourceText, pattern, `${label} must carry canonical provenance`);
}

// Rare structured paths are pinned at the source boundary so future refactors
// cannot silently reintroduce sourceless break/continue/goto claims.
test('C4-03 every residual control-flow emission binds source evidence', () => {
  assertHas(/continue;',\s*term2\.row,\s*term2\.address,\s*\{\s*source:\s*controlSource\(term2,\s*ctx\)\s*\}/s,
    'loop continue');
  assertHas(/break;',\s*term2\.row,\s*term2\.address,\s*\{\s*source:\s*controlSource\(term2,\s*ctx\)\s*\}/s,
    'loop break');
  assertHas(/goto loc_\$\{hex\(ctx\.blockAddress\(next\)\)\};`,\s*term2\.row,\s*term2\.address,\s*\{\s*source:\s*mergeSource\(controlSource\(term2,\s*ctx\),\s*jumpTargetSource\(next,\s*ctx\)\)\s*\}/s,
    'structured residual BR goto');
  assertHas(/goto loc_\$\{hex\(ctx\.blockAddress\(no\)\)\};`,\s*term2\.row,\s*term2\.address,\s*\{\s*source:\s*mergeSource\(controlSource\(term2,\s*ctx\),\s*jumpTargetSource\(no,\s*ctx\)\)\s*\}/s,
    'structured residual CBR false-edge goto');
  assertHas(/goto loc_\$\{hex\(ctx\.blockAddress\(no\)\)\};`,\s*term\.row,\s*term\.address,\s*\{\s*source:\s*mergeSource\(controlSource\(term,\s*ctx\),\s*jumpTargetSource\(no,\s*ctx\)\)\s*\}/s,
    'faithful CFG CBR false-edge goto');
  assertHas(/goto loc_\$\{hex\(ctx\.blockAddress\(next\)\)\};`,\s*term\.row,\s*term\.address,\s*\{\s*source:\s*mergeSource\(controlSource\(term,\s*ctx\),\s*jumpTargetSource\(next,\s*ctx\)\)\s*\}/s,
    'faithful CFG BR goto');
});

function makeModel(rows) {
  const raw = rows.map((r, row) => ({ row, address: BigInt(r.address), mn: r.mn, ops: r.ops || '' }));
  const rowByAddress = new Map(raw.map((r) => [r.address.toString(), r.row]));
  const rowOfAddress = (addr) => rowByAddress.get(BigInt(addr).toString()) ?? null;
  const addrOfRow = (row) => raw[row]?.address ?? null;
  const opts = {
    startRow: 0,
    endRow: raw.length - 1,
    rowOfAddress,
    addrOfRow,
    symbolFor: () => null,
    name: 'c4_03_control_edge_source',
  };
  return { raw, opts, model: buildSemanticModel(raw, opts) };
}

function hasCanonicalOrigin(source) {
  return !!source && ['addresses', 'rows', 'ir', 'ssaDefs', 'ssaUses']
    .some((key) => Array.isArray(source[key]) && source[key].length > 0);
}

test('C4-03 a real shared-cleanup residual goto is never emitted sourceless', () => {
  const { raw, opts, model } = makeModel([
    { address: 0x1000, mn: 'cbnz', ops: 'x0, 0x100c' },
    { address: 0x1004, mn: 'mov',  ops: 'x0, #0' },
    { address: 0x1008, mn: 'ret',  ops: '' },
    { address: 0x100c, mn: 'mov',  ops: 'x1, #1' },
    { address: 0x1010, mn: 'b',    ops: '0x1004' },
  ]);
  const result = decompile(model, { ...opts, addr: raw[0].address, beginner: false });
  const gotos = result.lines.filter((line) => /^goto loc_1004;$/i.test(line.text || ''));
  assert.ok(gotos.length > 0, 'fixture must retain the shared-cleanup edge explicitly');
  assert.ok(gotos.every((line) => hasCanonicalOrigin(line.source)), 'every rendered residual goto must retain a canonical origin');
});
