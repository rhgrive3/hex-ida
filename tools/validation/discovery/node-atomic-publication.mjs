import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { registerCanonicalRebuildPublicationAdapter } from '../../../js/rebuild/transaction-v2.js';

function requiredPath(value) {
  const target = String(value ?? '').trim();
  if (!target) throw new TypeError('rebuild-publication-target-required');
  return path.resolve(target);
}

function readExact(fd, length) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = fs.readSync(fd, bytes, offset, length - offset, offset);
    if (count === 0) break;
    offset += count;
  }
  if (offset !== length) throw new Error('rebuild-publication-staged-read-incomplete');
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice();
}

function sameBytes(left, right) {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/**
 * Node-only verifier adapter for F6 evidence. It is deliberately outside the
 * browser runtime: staging, byte verification, and rename all remain owned by
 * this repository adapter, while transaction-v2 owns the one-use commit gate.
 */
export function createNodeAtomicPublicationAdapter({ targetPath } = {}) {
  const target = requiredPath(targetPath);
  const directory = path.dirname(target);
  const directoryStat = fs.statSync(directory);
  if (!directoryStat.isDirectory()) throw new TypeError('rebuild-publication-target-directory-invalid');

  const adapter = (request) => {
    if (!(request?.bytes instanceof Uint8Array)) throw new TypeError('rebuild-publication-bytes-required');
    if (request.bytes.length !== request.expectedLength || request.expectedLength > request.maxBytes) {
      throw new TypeError('rebuild-publication-byte-budget-invalid');
    }
    const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let fd = null;
    let renamed = false;
    try {
      fd = fs.openSync(temporary, 'wx+', 0o600);
      let written = 0;
      while (written < request.bytes.length) {
        const count = fs.writeSync(fd, request.bytes, written, request.bytes.length - written, written);
        if (count === 0) throw new Error('rebuild-publication-staged-write-incomplete');
        written += count;
      }
      fs.fsyncSync(fd);
      if (fs.fstatSync(fd).size !== request.expectedLength) throw new Error('rebuild-publication-staged-size-mismatch');
      const stagedBytes = readExact(fd, request.expectedLength);
      if (!sameBytes(stagedBytes, request.bytes)) throw new Error('rebuild-publication-staged-bytes-mismatch');
      const stagedFd = fd;
      fd = null;
      fs.closeSync(stagedFd);

      request.authorizeCommit({
        stagedBytes,
        protocol: 'temp-then-atomic-rename',
        publicationIdentity: target,
        commit: () => {
          fs.renameSync(temporary, target);
          renamed = true;
        },
      });
    } finally {
      if (fd != null) fs.closeSync(fd);
      if (!renamed) {
        try { fs.unlinkSync(temporary); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      }
    }
  };
  return registerCanonicalRebuildPublicationAdapter(adapter);
}
