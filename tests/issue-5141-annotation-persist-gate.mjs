import assert from 'node:assert/strict';
import { createCapabilityCatalog } from '../js/ai/capabilities/catalog.js';
import { CapabilityExecutor } from '../js/ai/capabilities/executor.js';

const approval = { kind: 'proposal', token: 'test-token-123' };

// Mimics the NoteStore boolean contract: in-memory mutation applies, but the
// storage write fails and `false` is returned.
function failingNotes() {
  const state = {
    names: new Map([['0x1000', 'old_name']]),
    comments: new Map(),
    structs: [],
    dirty: false,
    renamed: [],
  };
  return {
    state,
    nameOf: (addr) => state.names.get(addr.toString()) ?? null,
    comment: (addr) => state.comments.get(addr.toString()) ?? null,
    setName(addr, name, { save = true } = {}) {
      if (save) {
        state.names.set(addr.toString(), String(name));
        state.dirty = true;
        return false;
      }
      if (String(name)) state.names.set(addr.toString(), String(name));
      else state.names.delete(addr.toString());
      return true;
    },
    setComment(addr, text, { save = true } = {}) {
      if (save) {
        state.comments.set(addr.toString(), String(text));
        state.dirty = true;
        return false;
      }
      state.comments.set(addr.toString(), String(text));
      return true;
    },
    save() { state.dirty = true; return false; },
  };
}

function executorFor(app) {
  return new CapabilityExecutor({ catalog: createCapabilityCatalog(), app });
}

// rename: persistence failure must not return ok:true, and symbols.rename must
// not run on top of an unpersisted note.
{
  const notes = failingNotes();
  const app = { notes, symbols: { rename: (addr, name) => notes.state.renamed.push([addr.toString(), name]) } };
  await assert.rejects(
    () => executorFor(app).execute('annotation.rename', { address: '0x1000', value: 'new_name' }, { authorization: approval }),
    (error) => error?.type === 'tool_failed',
  );
  assert.equal(notes.state.renamed.length, 0, 'symbols.rename must not run after a failed note persist');
  assert.equal(notes.state.names.get('0x1000'), 'old_name', 'the unpersisted rename must be rolled back');
}

// comment: same fail-closed contract.
{
  const notes = failingNotes();
  const app = { notes };
  await assert.rejects(
    () => executorFor(app).execute('annotation.comment', { address: '0x1000', value: 'note' }, { authorization: approval }),
    (error) => error?.type === 'tool_failed',
  );
  assert.equal(notes.state.comments.get('0x1000'), undefined, 'the unpersisted comment must be rolled back');
}

// struct-field: save() === false must not return ok:true.
{
  const notes = failingNotes();
  const app = { notes };
  await assert.rejects(
    () => executorFor(app).execute(
      'annotation.struct-field',
      { struct: 'S', offset: 0, field: 'f', type: 'int' },
      { authorization: approval },
    ),
    (error) => error?.type === 'tool_failed',
  );
  assert.equal(notes.state.structs.length, 0, 'the unpersisted struct must be rolled back');
}

// Success paths still work when persistence succeeds.
{
  const state = { names: new Map(), renamed: [] };
  const app = {
    notes: {
      nameOf: () => null,
      setName: (addr, name) => { state.names.set(addr.toString(), String(name)); return true; },
      setComment: () => true,
      structs: [],
      save: () => true,
    },
    symbols: { rename: (addr, name) => state.renamed.push([addr.toString(), name]) },
  };
  const executor = executorFor(app);
  const renamed = await executor.execute('annotation.rename', { address: '0x1000', value: 'v' }, { authorization: approval });
  assert.equal(renamed.ok, true);
  const commented = await executor.execute('annotation.comment', { address: '0x1000', value: 'c' }, { authorization: approval });
  assert.equal(commented.ok, true);
  const field = await executor.execute('annotation.struct-field', { struct: 'S', offset: 0, field: 'f', type: 'int' }, { authorization: approval });
  assert.equal(field.ok, true);
}

console.log('issue-5141-annotation-persist-gate: ok');
