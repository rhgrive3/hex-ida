import assert from 'node:assert/strict';
import { analyzeFunction } from '../js/analyze.js';
import { CHUNK_ROWS } from '../js/backend.js';

function analysisBackend(lines) {
  const mn = [];
  const ops = [];
  for (let i = 0; i < lines.length; i++) {
    const text = String(lines[i]).trim();
    const split = text.indexOf(' ');
    mn[i] = split < 0 ? text : text.slice(0, split);
    ops[i] = split < 0 ? '' : text.slice(split + 1);
  }
  return {
    fetchChunk: async (_regionId, chunk) => chunk === 0 ? { mn, ops } : { mn: [], ops: [] },
    readAt: async () => ({ found: false, bytes: new Uint8Array() }),
  };
}

const BASE = 0x1000n;
async function analyzeLines(lines) {
  const region = { id: 'issue-3718', vmAddr: BASE, size: BigInt(CHUNK_ROWS * 4) };
  return analyzeFunction(analysisBackend(lines), region, 0, lines.length - 1, null, null, { texts: false });
}
const addrAt = (row) => BASE + BigInt(row) * 4n;
const hexAt = (row) => '0x' + addrAt(row).toString(16);

// A backward-layout branch into a shared epilogue that has no path back to its
// source forms no CFG cycle, so it must not be reported as a loop.
{
  const acyclic = await analyzeLines([
    `b #${hexAt(2)}`,
    'ret',
    `b #${hexAt(1)}`,
  ]);
  assert.equal(acyclic.loops.length, 0, `backward edge without a cycle must not be a loop: ${JSON.stringify(acyclic.loops.map((l) => [String(l.from), String(l.to)]))}`);
}

// A genuine natural loop (latch branches back to a dominating header) must be
// detected as a loop.
{
  const loop = await analyzeLines([
    'subs x0, x0, #1',
    `b.ne #${hexAt(0)}`,
    'ret',
  ]);
  assert.equal(loop.loops.length, 1, `natural loop must be reported: ${JSON.stringify(loop.loops.map((l) => [String(l.from), String(l.to)]))}`);
  assert.equal(loop.loops[0].to, addrAt(0), 'the loop must be attributed to its header');
}

// Forward-only control flow has no backward branch and no loop.
{
  const forward = await analyzeLines([
    `b #${hexAt(2)}`,
    'ret',
    'nop',
    'ret',
  ]);
  assert.equal(forward.loops.length, 0, 'forward-only CFG must not report a loop');
}

console.log('  ok 3718 loop summary requires CFG cycle evidence, not address order');
