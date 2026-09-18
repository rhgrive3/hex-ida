#!/usr/bin/env node
/** Offline source/denominator gate; no downloads, engine installs or model API.
 * A binding packet can be normalized with the EXISTING competitive contracts;
 * no absent toolchain is silently replaced by a host architecture build.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { normalizePostBManifest, postBCells, bindPostBProtocol } from '../../js/analysis/benchmark/post-b.js';
import { checkU64Add7 } from './source-oracle.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = path.join(root, 'tests/competitive-arm64/manifest');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function read(file, maximum = 1048576) {
  const stat = fs.statSync(file); if (!stat.isFile() || stat.size > maximum) throw new TypeError('manifest-file-budget');
  return fs.readFileSync(file);
}
try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--bindings')) throw new TypeError('usage: node tools/competitive-arm64/manifest.mjs [--bindings local.json]');
  const bytes = read(path.join(dir, 'post-b.json'), 262144), manifest = normalizePostBManifest(JSON.parse(bytes));
  for (const recipe of manifest.recipes) {
    const file = path.join(dir, recipe.source), actual = fs.realpathSync(file);
    if (!actual.startsWith(dir + path.sep) || sha(read(actual, 65536)) !== recipe.sourceSha256) throw new TypeError('manifest-source-identity:' + recipe.id);
  }
  const good = checkU64Add7([{ input: '18446744073709551615', output: '6' }, { input: '0', output: '7' }]);
  const bad = checkU64Add7([{ input: '18446744073709551615', output: '7' }]);
  if (good.status !== 'verified' || bad.status !== 'rejected') throw new Error('wrong-known-oracle-sentinel-not-rejected');
  const cells = postBCells(manifest);
  let bound = null;
  if (args.length) {
    const packet = bindPostBProtocol(manifest, JSON.parse(read(path.resolve(args[1]))), { manifestSha256: sha(bytes),
      metricSha256: Object.fromEntries(manifest.metrics.map(row => [row.id, sha(JSON.stringify(row))])) });
    bound = { protocolId: packet.protocol.id, matrixId: packet.matrix.id, expectedCells: packet.matrix.expectedCells,
      cells: packet.cells.length, admission: packet.admission };
  }
  console.log(JSON.stringify({ schema: 'scpa-post-b-source-gate/v1', status: 'source-and-denominator-checked', manifestSha256: sha(bytes),
    caseCount: manifest.cases.length, languages: manifest.recipes.map(row => row.language), toolchainSlots: manifest.toolchainSlots.length,
    metricCount: manifest.metrics.length, expectedCells: cells.length, unmeasuredCells: cells.length,
    wrongOracleRejected: true, binaryTwinsVerified: false, nativeCompetitorsRun: false, victoryEstablished: false, bound }, null, 2));
} catch (error) { console.error(JSON.stringify({ status: 'failed', reason: error.message })); process.exitCode = 1; }
