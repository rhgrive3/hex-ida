#!/usr/bin/env python3
import pathlib
import shutil
import subprocess
import sys

REPO = pathlib.Path('.').resolve()
TARGET = 'fix/reopened-ai-project-contracts'
EXPECTED_TARGET = 'c728482ffcca28939df805af184117b50d29f5d9'
BASE = '818bc11c8ef6cd8f7a57f468fe0a0f321fd158b7'
FILES = [
    'js/ai/context/broker.js',
    'js/ai/control/turn-executor.js',
    'js/ai/evidence.js',
    'js/ai/runtime.js',
    'js/ai/session-core/index.js',
    'js/ai/ui/assistant.js',
    'js/ai/ui/bridge.js',
    'js/ai/ui/session.js',
    'js/names.js',
    'js/project/index.js',
    'js/project/migrations.js',
    'js/workspace.js',
    'tests/migration-guardrails.mjs',
    'tests/reopened-ai-project-contracts.mjs',
]
CONFLICT_OWNERS = {'js/names.js', 'js/workspace.js'}


def run(*args, check=True, capture=False):
    cmd = [str(x) for x in args]
    print('+', ' '.join(cmd), flush=True)
    return subprocess.run(cmd, check=check, text=True, capture_output=capture)


def git(*args, capture=False):
    return run('git', *args, capture=capture)


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected exactly one source match, got {count}')
    return text.replace(old, new, 1)


def target_file(path):
    proc = git('show', f'origin/{TARGET}:{path}', capture=True)
    return proc.stdout


def write(path, text):
    dest = REPO / path
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(text)


def merge_names():
    p = REPO / 'js/names.js'
    s = p.read_text()

    old = """    this.migratedFrom = null;
    this.legacyCandidate = null;
    this.lastSaveError = null;
    this.lastMutationSaved = true;
    this.names = new Map();      // addr -> 名前
"""
    new = """    this.migratedFrom = null;
    this.legacyCandidate = null;
    this.lastSaveError = null;
    this.lastMutationSaved = true;
    this._snapshotBytes = 0;
    this._deltaBytes = new Map();
    this._deltaTotalBytes = 0;
    this._deltaPrefix = this.id ? `${PREFIX}${this.id}.delta.` : null;
    this.names = new Map();      // addr -> 名前
"""
    s = replace_once(s, old, new, 'NoteStore constructor delta state')

    old = """    if (raw) {
      try {
        const o = JSON.parse(raw);
"""
    new = """    if (raw) {
      try {
        this._snapshotBytes = new TextEncoder().encode(raw).byteLength;
        const o = JSON.parse(raw);
"""
    s = replace_once(s, old, new, 'strong snapshot byte accounting')

    old = """        this._applyPayload(o || {});
      } catch { }
      return;
"""
    new = """        this._applyPayload(o || {});
        this._loadDeltas();
      } catch { }
      return;
"""
    s = replace_once(s, old, new, 'strong snapshot delta replay')

    marker = """  _saveFailure(code, error = null, detail = {}) {
"""
    helpers = """  _mapForDelta(kind) {
    return kind === 'names' ? this.names : kind === 'comments' ? this.comments : kind === 'vars' ? this.vars : kind === 'types' ? this.types : null;
  }

  _deltaKey(kind, recordKey) {
    return `${this._deltaPrefix}${encodeURIComponent(kind)}.${encodeURIComponent(String(recordKey))}`;
  }

  _loadDeltas() {
    if (!this._deltaPrefix || typeof localStorage === 'undefined') return;
    this._deltaBytes.clear(); this._deltaTotalBytes = 0;
    const keys = [];
    try {
      for (let index = 0; index < localStorage.length; index++) {
        const storageKey = localStorage.key(index);
        if (storageKey?.startsWith(this._deltaPrefix)) keys.push(storageKey);
      }
      keys.sort();
      for (const storageKey of keys) {
        const raw = localStorage.getItem(storageKey);
        if (raw == null) continue;
        const bytes = new TextEncoder().encode(raw).byteLength;
        this._deltaBytes.set(storageKey, bytes); this._deltaTotalBytes += bytes;
        const delta = JSON.parse(raw);
        const map = this._mapForDelta(delta?.kind);
        if (!map || typeof delta?.key !== 'string') continue;
        if (delta.deleted) map.delete(delta.key); else map.set(delta.key, String(delta.value ?? ''));
      }
    } catch { /* base snapshot remains valid if a delta is unreadable */ }
  }

  _clearDeltas() {
    for (const storageKey of this._deltaBytes.keys()) { try { localStorage.removeItem(storageKey); } catch { /* stale overlay is idempotent */ } }
    this._deltaBytes.clear(); this._deltaTotalBytes = 0;
  }

  _persistDelta(kind, recordKey, value) {
    if (!this.id || !this._deltaPrefix) return this._saveFailure('NO_ID');
    // A delta overlay needs a durable base. The first mutation of a fresh store
    // creates that base once; subsequent ordinary mutations stay record-local.
    if (this._snapshotBytes === 0) return this.save();
    const storageKey = this._deltaKey(kind, recordKey);
    const text = JSON.stringify({ kind, key:String(recordKey), deleted:value == null, ...(value == null ? {} : { value:String(value) }) });
    const bytes = new TextEncoder().encode(text).byteLength;
    const previousBytes = this._deltaBytes.get(storageKey) || 0;
    const projected = this._snapshotBytes + this._deltaTotalBytes - previousBytes + bytes;
    if (projected > MAX_BYTES) return this.save();
    try {
      localStorage.setItem(storageKey, text);
      this._deltaBytes.set(storageKey, bytes);
      this._deltaTotalBytes += bytes - previousBytes;
      this.dirty = false; this.lastSaveError = null; this.lastMutationSaved = true;
      return true;
    } catch (error) { return this._saveFailure(error?.name || 'STORAGE_ERROR', error); }
  }

"""
    s = replace_once(s, marker, helpers + marker, 'delta helpers insertion')

    old = """      localStorage.setItem(PREFIX + this.id, text);
      this.dirty = false;
"""
    new = """      localStorage.setItem(PREFIX + this.id, text);
      this._snapshotBytes = bytes;
      this._clearDeltas();
      this.dirty = false;
"""
    s = replace_once(s, old, new, 'snapshot compaction bookkeeping')

    method_rewrites = [
        ('setName', "return this._persistDelta('names', k, clean || null);"),
        ('setComment', "return this._persistDelta('comments', k, clean || null);"),
        ('setVarName', "return this._persistDelta('vars', kk, clean || null);"),
        ('setType', "return this._persistDelta('types', kk, clean || null);"),
    ]
    for method, replacement in method_rewrites:
        start = s.index(f'  {method}(')
        next_section = s.index('\n  }', start) + 4
        block = s[start:next_section]
        if block.count('return this.save();') != 1:
            raise RuntimeError(f'{method}: expected exactly one direct save')
        block = block.replace('return this.save();', replacement, 1)
        s = s[:start] + block + s[next_section:]

    old = """      localStorage.setItem(PREFIX + this.id, JSON.stringify({ v: 2, cleared: true }));
      this.dirty = false;
"""
    new = """      const tombstone = JSON.stringify({ v: 2, cleared: true });
      localStorage.setItem(PREFIX + this.id, tombstone);
      this._snapshotBytes = new TextEncoder().encode(tombstone).byteLength;
      this._clearDeltas();
      this.dirty = false;
"""
    s = replace_once(s, old, new, 'clear tombstone compaction')

    p.write_text(s)


def merge_workspace():
    p = REPO / 'js/workspace.js'
    s = p.read_text()
    old = """  notes.names.clear();notes.comments.clear();notes.types.clear();notes.vars.clear();
  for(const entry of project.user.names||[])if(entry?.address!=null&&entry.value)notes.names.set(BigInt(entry.address).toString(),String(entry.value));
  for(const entry of project.user.comments||[])if(entry?.address!=null&&entry.value)notes.comments.set(BigInt(entry.address).toString(),String(entry.value));
  for(const entry of project.user.types||[])if(entry?.key)notes.types.set(String(entry.key),String(entry.value||''));
  for(const entry of (project.user.vars||project.user.varNames||[]))if(entry?.key)notes.vars.set(String(entry.key),String(entry.value||''));
"""
    new = """  const replaceVars = project.user?.varsPresent !== false;
  notes.names.clear();notes.comments.clear();notes.types.clear();if(replaceVars)notes.vars.clear();
  for(const entry of project.user.names||[])if(entry?.address!=null&&entry.value)notes.names.set(BigInt(entry.address).toString(),String(entry.value));
  for(const entry of project.user.comments||[])if(entry?.address!=null&&entry.value)notes.comments.set(BigInt(entry.address).toString(),String(entry.value));
  for(const entry of project.user.types||[])if(entry?.key)notes.types.set(String(entry.key),String(entry.value||''));
  if(replaceVars)for(const entry of (project.user.vars||project.user.varNames||[]))if(entry?.key)notes.vars.set(String(entry.key),String(entry.value||''));
"""
    s = replace_once(s, old, new, 'workspace legacy vars preservation')
    p.write_text(s)


def main():
    git('fetch', 'origin', 'main', TARGET)
    remote = git('rev-parse', f'origin/{TARGET}', capture=True).stdout.strip()
    if remote != EXPECTED_TARGET:
        raise RuntimeError(f'target moved: expected {EXPECTED_TARGET}, got {remote}')

    overlap_out = git('diff', '--name-only', f'{BASE}..origin/main', '--', *FILES, capture=True).stdout
    overlaps = {line.strip() for line in overlap_out.splitlines() if line.strip()}
    unexpected = overlaps - CONFLICT_OWNERS
    if unexpected:
        raise RuntimeError(f'new main overlap requires review: {sorted(unexpected)}')
    print('main overlaps:', sorted(overlaps), flush=True)

    saved = pathlib.Path('/tmp/pr2677-files')
    if saved.exists(): shutil.rmtree(saved)
    for path in FILES:
        dest = saved / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(target_file(path))

    git('reset', '--hard', 'origin/main')

    for path in FILES:
        if path in CONFLICT_OWNERS:
            continue
        src = saved / path
        dest = REPO / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)

    merge_names()
    merge_workspace()

    # The semantic PR must not carry temporary workflow/runner files.
    for path in ['.github/workflows/reopened-ai-project-repair.yml', '.github/workflows/tmp-pr2677-ci-repair.yml']:
        q = REPO / path
        if q.exists(): q.unlink()

    git('add', '-A')
    git('diff', '--cached', '--check')

    run('node', 'tests/migration-guardrails.mjs')
    run('node', 'tests/reopened-ai-project-contracts.mjs')
    if (REPO / 'tests/issues-2613-2612-2609-ai-sessions-broker.mjs').exists():
        run('node', 'tests/issues-2613-2612-2609-ai-sessions-broker.mjs')
    run('npm', 'run', 'ai:test')

    git('config', 'user.name', 'github-actions[bot]')
    git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com')
    git('commit', '-m', 'fix(ai,project): restack reopened persistence contracts on current main')
    new_head = git('rev-parse', 'HEAD', capture=True).stdout.strip()
    git('push', f'--force-with-lease=refs/heads/{TARGET}:{EXPECTED_TARGET}', 'origin', f'HEAD:refs/heads/{TARGET}')
    print('RESTACK_HEAD=' + new_head, flush=True)

if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('RESTACK_FAILED:', exc, file=sys.stderr)
        raise
