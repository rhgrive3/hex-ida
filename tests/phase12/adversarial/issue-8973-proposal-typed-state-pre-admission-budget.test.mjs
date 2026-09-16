import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProposalStore } from '../../../js/ai/proposals.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function store() {
  return new ProposalStore({ evidenceStore: { has: (id) => id === 'e1' } });
}

function createWith(s, before, extra = {}) {
  return s.create({
    kind: 'project-annotation',
    target: { id: 'typed-state' },
    before,
    after: 'changed',
    evidenceIds: ['e1'],
    ...extra,
  });
}

// (1) A binary state over the admitted byte budget fails closed at admission,
//     deterministically, with no partial record and no worker OOM.
{
  const s = store();
  let err = null;
  assert.throws(
    () => createWith(s, new Uint8Array(262_145)),
    (e) => { err = e; return e.name === 'AIError' && e.type === 'tool_failed' && /admitted size budget/.test(e.message); },
    'oversized typed-array state must be rejected by the pre-admission byte budget',
  );
  assert.equal(s.records.size, 0, 'a rejected proposal must not leave a record behind');
  assert.equal(s.audit.length, 0, 'a rejected proposal must not be audited as created');
}

// (2) Nested binary payload is bounded too, and the aggregate across target +
//     before + after cannot slip past the gate on any single container.
assert.throws(
  () => createWith(store(), { envelope: { bytes: new Uint8Array(300_000) } }),
  (e) => e.name === 'AIError' && e.type === 'tool_failed' && /admitted size budget/.test(e.message),
  'nested oversized binary state must be rejected',
);

// (3) Small, genuinely supported typed / binary state (the #6215 contract) is
//     still admitted and receives a stable fingerprint revision.
{
  const s = store();
  const snapshot = createWith(s, new Uint8Array(1024).fill(0x7f));
  assert.ok(snapshot && typeof snapshot.id === 'string');
  const record = s.records.get(snapshot.id);
  assert.ok(typeof record.revision === 'string' && record.revision.length > 0,
    'an admitted small binary state must still be fingerprinted');
  const s2 = store();
  createWith(s2, new DataView(new ArrayBuffer(2048)));
  createWith(s2, new ArrayBuffer(4096));
}

// (4) End-to-end tie to the reported counterexample: a 2 MiB Uint8Array under a
//     128 MiB heap must be rejected deterministically, not crash the process.
//     On the pre-fix head this child process dies with a V8 heap OOM (rc 134).
{
  const script = [
    "import { ProposalStore } from './js/ai/proposals.js';",
    "const s = new ProposalStore({ evidenceStore: { has: (id) => id === 'e1' } });",
    "try {",
    "  s.create({ kind:'project-annotation', target:{ id:'typed-state' }, before:new Uint8Array(2*1024*1024), after:'x', evidenceIds:['e1'] });",
    "  console.log('ACCEPTED');",
    "} catch (e) {",
    "  console.log('REJECTED:' + e.name + ':' + e.type);",
    "}",
  ].join('\n');
  const out = execFileSync(process.execPath, ['--max-old-space-size=128', '--input-type=module', '-e', script], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.match(out.trim(), /^REJECTED:AIError:tool_failed$/,
    'a 2 MiB proposal state must fail closed under a 128 MiB heap instead of exhausting the worker');
}

console.log('issue #8973 proposal typed-state pre-admission budget: PASS');
