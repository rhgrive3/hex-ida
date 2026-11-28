/*
 * Input/output probing: run one function in the local sandbox with fixed
 * inputs and report what came back. A rule is reported only when it holds for
 * every row that returned; otherwise no rule is shown.
 */

const MASK32 = 0xFFFFFFFFn;
const MAX_ARITY = 4;

const VECTORS = {
  0: [[]],
  1: [[0n], [1n], [2n], [3n], [10n], [-1n], [100n]],
  2: [[0n, 0n], [1n, 2n], [3n, 4n], [10n, 3n], [-1n, 5n], [100n, 7n]],
  3: [[0n, 0n, 0n], [1n, 2n, 3n], [10n, 3n, 5n], [-1n, 4n, 2n], [7n, 0n, 9n]],
  4: [[0n, 0n, 0n, 0n], [1n, 2n, 3n, 4n], [10n, 3n, 5n, 2n], [-1n, 4n, 2n, 8n]],
};

export function inputVectors(arity) {
  const n = Number.isSafeInteger(arity) ? Math.max(0, Math.min(MAX_ARITY, arity)) : 2;
  return VECTORS[n].map((row) => row.slice());
}

/** Parameter count from a decompiled signature line, or null. */
export function arityFromPseudocode(code) {
  const text = String(code || '');
  const m = /^[^\n;{}#/]*?[\w$\]\-+[]+\s*\(([^()]*)\)\s*\n?\s*\{/m.exec(text);
  if (!m) return null;
  const params = m[1].trim();
  if (!params || params === 'void') return 0;
  return params.split(',').length;
}

/** Return-register value seen as a C int when the upper half is a sign/zero extension. */
export function asReturnInt(value) {
  if (value == null) return null;
  let v;
  try { v = BigInt.asUintN(64, BigInt(value)); } catch { return null; }
  const high = v >> 32n;
  if (high === 0n || high === MASK32) return BigInt.asIntN(32, v & MASK32);
  return BigInt.asIntN(64, v);
}

function fmt(v) { return v == null ? '—' : v.toString(); }

const argName = (i, ja) => (ja ? `引数${i + 1}` : `arg${i + 1}`);

function linearOn(rows, k) {
  const pts = rows.map((r) => [BigInt.asIntN(32, r.args[k]), r.out]);
  const distinct = pts.filter((p, i) => pts.findIndex((q) => q[0] === p[0]) === i);
  if (distinct.length < 3) return null;
  const [[x0, y0], [x1, y1]] = distinct;
  const dy = y1 - y0, dx = x1 - x0;
  if (dx === 0n || dy % dx !== 0n) return null;
  const a = dy / dx;
  const b = y0 - a * x0;
  if (a === 0n) return null;
  return pts.every(([x, y]) => a * x + b === y) ? { a, b } : null;
}

/** Short rule that holds for every returned row, or null. */
export function summarize(rows, { ja = true } = {}) {
  const done = rows.filter((r) => r.stop === 'return' && r.out != null);
  if (done.length < 3 || done.length !== rows.length) return null;
  const outs = done.map((r) => r.out);
  const arity = done[0].args.length;
  if (outs.every((o) => o === outs[0])) return ja ? `いつも ${fmt(outs[0])} を返す` : `always returns ${fmt(outs[0])}`;
  for (let k = 0; k < arity; k++) {
    const line = linearOn(done, k);
    if (!line) continue;
    const x = argName(k, ja);
    if (line.a === 1n && line.b === 0n) return ja ? `${x} をそのまま返す` : `returns ${x} unchanged`;
    const mul = line.a === 1n ? x : line.a === -1n ? `-${x}` : `${x} × ${line.a}`;
    const add = line.b === 0n ? '' : line.b > 0n ? ` + ${line.b}` : ` - ${-line.b}`;
    return ja ? `${mul}${add} を返す` : `returns ${mul}${add}`;
  }
  if (arity >= 2) {
    const a = (r) => BigInt.asIntN(32, r.args[0]);
    const b = (r) => BigInt.asIntN(32, r.args[1]);
    const ops = [
      ['+', (r) => a(r) + b(r)], ['-', (r) => a(r) - b(r)], ['×', (r) => a(r) * b(r)],
    ];
    for (const [op, f] of ops) {
      if (done.every((r) => BigInt.asIntN(32, f(r)) === r.out)) {
        return ja ? `${argName(0, true)} ${op} ${argName(1, true)} を返す` : `returns arg1 ${op} arg2`;
      }
    }
  }
  if (outs.every((o) => o === 0n || o === 1n)) return ja ? '0 か 1 を返す' : 'returns 0 or 1';
  return null;
}

function stopKind(observation) {
  return String(observation?.stop?.kind || 'unknown');
}

/**
 * Run the function once per input vector. `trace(app, addr, options)` is the
 * runtime entry point (traceAppFunction in the product).
 */
export async function probeFunction(app, addr, { trace, arity = null, signal = null, timeoutMs = 1500, maxSteps = 12000 } = {}) {
  if (typeof trace !== 'function') throw new TypeError('trace function is required');
  const vectors = inputVectors(arity ?? 2);
  const rows = [];
  for (const args of vectors) {
    if (signal?.aborted) break;
    try {
      const result = await trace(app, addr, { args, signal, timeoutMs, maxSteps, limit: 4096 });
      const obs = result?.observation || {};
      const writes = (result?.trace?.events || []).filter((e) => e?.type === 'memory-write' && e.region !== 'stack').length;
      rows.push({ args, stop: stopKind(obs), out: stopKind(obs) === 'return' ? asReturnInt(obs.returnValue) : null, writes, error: null });
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') break;
      rows.push({ args, stop: 'error', out: null, writes: 0, error: String(error?.code || error?.message || error).slice(0, 80) });
    }
  }
  return { rows, arity: vectors[0].length };
}

export function formatArgs(args) { return args.length ? args.map((v) => BigInt.asIntN(32, v).toString()).join(', ') : '—'; }
export { fmt as formatValue };
