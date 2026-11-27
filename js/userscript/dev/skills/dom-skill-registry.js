import { executeAutomationProgram, validateAutomationProgram } from './automation-program.js';

const SKILL_ID = /^[a-z0-9][a-z0-9._-]{1,95}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PROGRAM_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_SKILLS = 32;
const MAX_PROGRAMS = 48;

export class DomSkillRegistry {
  constructor({ document = globalThis.document, location = globalThis.location, now = () => new Date().toISOString() } = {}) {
    this.document = document || null;
    this.location = location || null;
    this.now = now;
    this.records = new Map();
  }

  installCandidate(manifest) {
    const normalized = normalizeSkillManifest(manifest);
    if (!this.records.has(normalized.skillId) && this.records.size >= MAX_SKILLS) {
      throw skillError('skill-limit', `At most ${MAX_SKILLS} DOM Skills may be installed.`);
    }
    const existing = this.records.get(normalized.skillId) || emptyRecord(normalized.skillId);
    if (existing.active?.version === normalized.version) {
      throw skillError('skill-version-active', 'Candidate version is already active.');
    }
    const record = Object.freeze({
      ...existing,
      candidate: normalized,
      candidateValidation: null,
      updatedAt: this.now(),
    });
    this.records.set(normalized.skillId, record);
    return summarizeRecord(record);
  }

  async validateCandidate({ skillId, programs = null, signal = null } = {}) {
    const record = this.requireRecord(skillId);
    if (!record.candidate) throw skillError('candidate-missing', 'DOM Skill candidate is not installed.');
    const candidate = record.candidate;
    const names = normalizeValidationPrograms(candidate, programs);
    const results = {};
    for (const name of names) {
      const program = candidate.programs[name];
      validateAutomationProgram(program, { requireReadOnly: true });
      results[name] = await executeAutomationProgram(program, {
        document: this.document,
        location: this.location,
        signal,
        requireReadOnly: true,
      });
    }
    const validation = Object.freeze({
      ok: true,
      version: candidate.version,
      programs: names,
      results,
      validatedAt: this.now(),
    });
    const current = this.requireRecord(record.skillId);
    if (current.candidate !== candidate) throw skillError('candidate-superseded', 'DOM Skill candidate changed during validation.');
    const next = Object.freeze({ ...current, candidateValidation: validation, updatedAt: this.now() });
    this.records.set(record.skillId, next);
    return { skill: summarizeRecord(next), validation };
  }

  activate({ skillId } = {}) {
    const record = this.requireRecord(skillId);
    const candidate = record.candidate;
    if (!candidate) throw skillError('candidate-missing', 'DOM Skill candidate is not installed.');
    if (!record.candidateValidation?.ok || record.candidateValidation.version !== candidate.version) {
      throw skillError('candidate-not-validated', 'DOM Skill candidate must pass live read-only validation before activation.');
    }
    const next = Object.freeze({
      ...record,
      previous: record.active || record.previous || null,
      active: candidate,
      activeValidation: record.candidateValidation,
      candidate: null,
      candidateValidation: null,
      activatedAt: this.now(),
      updatedAt: this.now(),
    });
    this.records.set(record.skillId, next);
    return summarizeRecord(next);
  }

  rollback({ skillId } = {}) {
    const record = this.requireRecord(skillId);
    if (!record.previous) throw skillError('rollback-unavailable', 'No previously active DOM Skill version is available.');
    const oldActive = record.active;
    const next = Object.freeze({
      ...record,
      active: record.previous,
      previous: oldActive || null,
      activeValidation: null,
      candidate: null,
      candidateValidation: null,
      activatedAt: this.now(),
      updatedAt: this.now(),
    });
    this.records.set(record.skillId, next);
    return summarizeRecord(next);
  }

  async run({ skillId, program, candidate = false, args = {}, signal = null } = {}) {
    const record = this.requireRecord(skillId);
    const isCandidate = !!candidate;
    const manifest = isCandidate ? record.candidate : record.active;
    if (!manifest) throw skillError(isCandidate ? 'candidate-missing' : 'active-skill-missing', isCandidate ? 'DOM Skill candidate is not installed.' : 'DOM Skill is not active.');
    if (isCandidate && (!record.candidateValidation?.ok || record.candidateValidation.version !== manifest.version)) {
      throw skillError('candidate-not-validated', 'DOM Skill candidate must pass live read-only validation before running.');
    }
    const name = normalizeProgramName(program);
    const base = Object.hasOwn(manifest.programs, name) ? manifest.programs[name] : null;
    if (!base) throw skillError('program-missing', `DOM Skill program is unavailable: ${name}`);
    const bound = bindProgramArgs(base, args);
    if (isCandidate) validateAutomationProgram(bound, { requireReadOnly: true });
    return {
      skillId: manifest.skillId,
      version: manifest.version,
      program: name,
      candidate: isCandidate,
      result: await executeAutomationProgram(bound, {
        document: this.document,
        location: this.location,
        signal,
        requireReadOnly: isCandidate,
      }),
    };
  }

  list() {
    return [...this.records.values()].map(summarizeRecord);
  }

  describe({ skillId } = {}) {
    const record = this.requireRecord(skillId);
    return {
      ...summarizeRecord(record),
      active: record.active ? publicManifest(record.active) : null,
      candidate: record.candidate ? publicManifest(record.candidate) : null,
      previous: record.previous ? publicManifest(record.previous) : null,
      candidateValidation: record.candidateValidation,
    };
  }

  requireRecord(skillId) {
    const id = normalizeSkillId(skillId);
    const record = this.records.get(id);
    if (!record) throw skillError('skill-missing', `DOM Skill is not installed: ${id}`);
    return record;
  }
}

export function normalizeSkillManifest(manifest) {
  if (!plainRecord(manifest)) throw new TypeError('DOM Skill manifest must be a plain object.');
  const skillId = normalizeSkillId(manifest.skillId);
  const version = normalizeVersion(manifest.version);
  const programsInput = manifest.programs;
  if (!plainRecord(programsInput)) throw new TypeError('DOM Skill manifest programs must be an object.');
  const names = Object.keys(programsInput);
  if (!names.length || names.length > MAX_PROGRAMS) throw new TypeError(`DOM Skill must contain 1-${MAX_PROGRAMS} programs.`);
  const programs = Object.create(null);
  for (const name of names) {
    const normalizedName = normalizeProgramName(name);
    programs[normalizedName] = validateAutomationProgram(programsInput[name]);
  }
  const validationPrograms = normalizeValidationNames(manifest.validationPrograms, programs);
  return deepFreeze({
    schema: 'hex-dom-skill-v1',
    skillId,
    version,
    description: String(manifest.description || '').slice(0, 600),
    validationPrograms,
    programs,
  });
}

function normalizeValidationPrograms(manifest, requested) {
  const names = requested == null ? manifest.validationPrograms : requested;
  if (!Array.isArray(names) || !names.length) throw skillError('validation-programs-missing', 'DOM Skill validation requires at least one read-only program.');
  return names.map((name) => {
    const normalized = normalizeProgramName(name);
    if (!Object.hasOwn(manifest.programs, normalized)) throw skillError('program-missing', `Validation program is unavailable: ${normalized}`);
    return normalized;
  });
}

function normalizeValidationNames(value, programs) {
  const fallback = Object.entries(programs).filter(([, program]) => program.readOnly === true).map(([name]) => name);
  const source = value == null ? fallback : value;
  if (!Array.isArray(source)) throw new TypeError('validationPrograms must be an array.');
  const names = [...new Set(source.map(normalizeProgramName))];
  if (!names.length) throw new TypeError('DOM Skill requires at least one read-only validation program.');
  for (const name of names) {
    if (!Object.hasOwn(programs, name)) throw new TypeError(`Validation program is unavailable: ${name}`);
    validateAutomationProgram(programs[name], { requireReadOnly: true });
  }
  return names;
}

function bindProgramArgs(program, args) {
  if (args == null) return program;
  if (!plainRecord(args)) throw new TypeError('DOM Skill program args must be a plain object.');
  const cloned = JSON.parse(JSON.stringify(program));
  cloned.steps = substitute(cloned.steps, args);
  return cloned;
}

const MAX_SUBSTITUTE_DEPTH = 64;
const MAX_ARG_JSON_BYTES = 256 * 1024;
const FORBIDDEN_SUBSTITUTE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function substitute(value, args, depth = 0) {
  if (depth >= MAX_SUBSTITUTE_DEPTH) throw skillError('invalid-program', 'DOM Skill template exceeds maximum nesting depth.');
  if (Array.isArray(value)) return value.map((item) => substitute(item, args, depth + 1));
  if (plainRecord(value)) {
    if (typeof value.arg === 'string' && Object.keys(value).length === 1) {
      if (!Object.prototype.hasOwnProperty.call(args, value.arg)) throw skillError('argument-missing', `DOM Skill argument is missing: ${value.arg}`);
      const serialized = JSON.stringify(args[value.arg]);
      if (typeof serialized === 'string' && serialized.length > MAX_ARG_JSON_BYTES) {
        throw skillError('invalid-argument', `DOM Skill argument exceeds size limit: ${value.arg}`);
      }
      return serialized === undefined ? undefined : JSON.parse(serialized);
    }
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_SUBSTITUTE_KEYS.has(key)) continue;
      Object.defineProperty(out, key, {
        value: substitute(item, args, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

function summarizeRecord(record) {
  return {
    skillId: record.skillId,
    activeVersion: record.active?.version || null,
    candidateVersion: record.candidate?.version || null,
    previousVersion: record.previous?.version || null,
    candidateValidated: !!record.candidateValidation?.ok,
    updatedAt: record.updatedAt || null,
    activatedAt: record.activatedAt || null,
  };
}
function publicManifest(manifest) {
  return {
    schema: manifest.schema,
    skillId: manifest.skillId,
    version: manifest.version,
    description: manifest.description,
    validationPrograms: manifest.validationPrograms,
    programs: Object.fromEntries(Object.entries(manifest.programs).map(([name, program]) => [name, { name: program.name, readOnly: program.readOnly, version: program.version, stepCount: countSteps(program.steps) }])),
  };
}
function countSteps(steps) {
  let count = 0;
  for (const step of steps) {
    count += 1;
    if (step.op === 'if') count += countSteps(step.then || []) + countSteps(step.else || []);
    if (step.op === 'forEach') count += countSteps(step.steps || []);
  }
  return count;
}
function emptyRecord(skillId) { return Object.freeze({ skillId, active: null, previous: null, candidate: null, candidateValidation: null, activeValidation: null, updatedAt: null, activatedAt: null }); }
function normalizeSkillId(value) { const text = String(value || '').trim(); if (!SKILL_ID.test(text)) throw new TypeError(`Invalid DOM Skill ID: ${value}`); return text; }
function normalizeVersion(value) { const text = String(value || '').trim(); if (!VERSION.test(text)) throw new TypeError(`Invalid DOM Skill version: ${value}`); return text; }
function normalizeProgramName(value) { const text = String(value || '').trim(); if (!PROGRAM_NAME.test(text)) throw new TypeError(`Invalid DOM Skill program name: ${value}`); return text; }
function plainRecord(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) return false; const proto = Object.getPrototypeOf(value); return proto === Object.prototype || proto === null; }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; Object.freeze(value); for (const item of Object.values(value)) deepFreeze(item); return value; }
function skillError(code, message) { const error = new Error(message); error.code = code; return error; }
