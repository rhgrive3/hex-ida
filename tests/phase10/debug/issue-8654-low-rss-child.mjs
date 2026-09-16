import { DEBUG_PROTOCOL_VERSION } from '../../../js/debug/adapter.js';
import { validateRemotePacket } from '../../../js/debug/remote-protocol.js';

if (typeof process.setMemoryAllocationThreshold === 'function') process.setMemoryAllocationThreshold?.(0);

function build() {
  const length = 65_536;
  const payload = new Array(length);
  const entry = { v: 'x'.repeat(512) };
  for (let i = 0; i < length; i++) payload[i] = entry;
  return { version: DEBUG_PROTOCOL_VERSION, type: 'event', epoch: 0, event: 'probe', data: payload };
}

// Warm up so V8 baseline code is stable before we measure.
const warm = build();
try { validateRemotePacket(warm); } catch { /* expected rejection */ }

if (global.gc) global.gc();
const memBefore = process.memoryUsage().rss;
const t0 = process.hrtime.bigint();
const packet = build();
let rejectedCode = null;
try { validateRemotePacket(packet); }
catch (err) { rejectedCode = err.code ?? null; }
const t1 = process.hrtime.bigint();
const memAfter = process.memoryUsage().rss;
const rssDeltaKb = Math.max(0, Math.round((memAfter - memBefore) / 1024));
const wallMs = Number(t1 - t0) / 1e6;

process.stdout.write(JSON.stringify({ rejectedCode, rssDeltaKb, wallMs }) + '\n');
