import assert from 'node:assert/strict';
import { queryFunctions, queryStrings } from '../../js/ui/explorer-index.js';

const functions = Array.from({ length:601 }, (_, i) => ({ address:BigInt(0x1000 + i * 4), name:`function_${i}`, size:4n }));
let snapshots = 0;
const requests = [];
const app = { analysisQueries:{
  async snapshot() { return { id:++snapshots }; },
  async functions(snapshot, filter, page) {
    requests.push({ snapshot, filter, page });
    if (requests.length === 1) throw Object.assign(new Error('lazy discovery advanced identity'), { code:'analysis-snapshot-stale' });
    const source = filter.address != null ? functions.filter(row => row.address === filter.address) : functions;
    const value = source.slice(page.offset, page.offset + page.limit);
    return { value, completeness:'partial', status:{ reason:'function-discovery-incomplete' },
      page:{ ...page, returned:value.length, total:null, next:page.offset + value.length < source.length ? page.offset + value.length : null } };
  },
} };
const first = await queryFunctions(app, '', { limit:200 });
assert.equal(first.length, 200);
assert.equal(snapshots, 2, 'first-use stale snapshots are replaced with a fresh canonical snapshot');
assert.equal(first.queryPage.next, 200);
assert.equal(first.completeness, 'partial', 'paging does not promote source completeness');
assert.equal(first[0].size, 4n, 'function sizes reach the view');
const second = await queryFunctions(app, '', { offset:first.queryPage.next, limit:200 });
const third = await queryFunctions(app, '', { offset:second.queryPage.next, limit:200 });
const last = await queryFunctions(app, '', { offset:third.queryPage.next, limit:200 });
assert.deepEqual([...first, ...second, ...third, ...last].map(row => row.addr), functions.map(row => row.address), 'all 601 functions are reachable without gaps or duplicates');
assert.equal(last.queryPage.next, null);
const exact = await queryFunctions(app, 'sub_1004');
assert.equal(exact[0].addr, 0x1004n);

let retries = 0;
const stale = { analysisQueries:{ async snapshot(){ return {}; }, async functions(){ retries++; throw Object.assign(new Error('stale'), {code:'analysis-snapshot-stale'}); } } };
await assert.rejects(queryFunctions(stale, ''), /stale/);
assert.equal(retries, 2, 'identity churn cannot create an unlimited retry loop');
const broken = { analysisQueries:{ async snapshot(){ return {}; }, async functions(){ throw new Error('producer failure'); } } };
await assert.rejects(queryFunctions(broken, ''), /producer failure/);
const aborted = new AbortController();
const cancelling = { analysisQueries:{ async snapshot(){ return {}; }, async functions(){ aborted.abort(); throw Object.assign(new Error('stale'), {code:'analysis-snapshot-stale'}); } } };
await assert.rejects(queryFunctions(cancelling, '', {signal:aborted.signal}), error => error.name === 'AbortError');

const strings = Array.from({length:1500}, (_, i) => ({addr:BigInt(i), text:i % 2 ? `needle-${i}` : `other-${i}`}));
Object.defineProperty(strings, 'complete', {value:false});
const collected = [];
let offset = 0;
do {
  const page = await queryStrings(strings, 'needle', {offset, limit:200});
  collected.push(...page);
  assert.equal(page.complete, false, 'partial collection disclosure survives every filtered page');
  assert.equal(page.queryPage.total, null, 'partial collections never advertise a global total');
  offset = page.queryPage.next;
} while (offset != null);
assert.deepEqual(collected, strings.filter(row => row.text.includes('needle')), 'every filtered string remains reachable');
assert.equal(await queryStrings(strings, ''), strings, 'the unfiltered list retains its lazy bounded DOM source');
console.log('ok — explorer paging, bounded stale recovery and source completeness');
