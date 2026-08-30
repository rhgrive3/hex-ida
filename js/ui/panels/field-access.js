import { Sheet, el, list, kvRow, tapRow, noteBox } from '../../ui.js';
import { addrHex } from '../../format.js';
import { pick } from '../../i18n.js';
import { fieldAccessAcrossExecutableRegions } from '../../analysis/field-access-artifact.js';

function fieldName(name) {
  return String(name || '?').replace(/^_+/, '');
}

function offsetHex(value) {
  const n = BigInt(value);
  return (n < 0n ? '-0x' + (-n).toString(16).toUpperCase() : '+0x' + n.toString(16).toUpperCase());
}

function typeText(type) {
  return type == null ? '' : String(type);
}

function functionLabel(app, address) {
  return app?.symbols?.nameAt?.(address) || app?.symbols?.label?.(address) || `sub_${BigInt(address).toString(16).toUpperCase()}`;
}

function groupSites(app, className, sites, program) {
  const byFunction = new Map();
  for (const site of sites || []) {
    const address = BigInt(site.addr);
    const functionAddress = program?.functionStartOf?.(address) ?? null;
    const key = functionAddress != null ? functionAddress.toString() : `site:${address}`;
    if (!byFunction.has(key)) {
      const owner = functionAddress != null ? app?.fields?.ownerOf?.(functionAddress) ?? null : null;
      byFunction.set(key, {
        addr:functionAddress,
        owner,
        first:address,
        loads:0,
        stores:0,
        sameClass:Boolean(owner && owner.className === className),
      });
    }
    const row = byFunction.get(key);
    if (site.kind === 'load') row.loads++;
    else row.stores++;
  }
  return Array.from(byFunction.values()).sort((a, b) =>
    Number(b.sameClass) - Number(a.sameClass)
    || b.stores - a.stores
    || b.loads - a.loads
    || (a.first < b.first ? -1 : a.first > b.first ? 1 : 0));
}

function renderResults(app, sheet, host, className, field, aggregate, program) {
  host.replaceChildren();
  const sites = aggregate?.results || [];
  const complete = aggregate?.complete === true;
  const unsupported = aggregate?.unsupported === true;
  const unscanned = aggregate?.unscannedRegionIds || [];

  if (!complete) {
    host.append(noteBox(pick(
      unsupported
        ? `このarchitecture/regionではアクセス解析を完了できません（${aggregate?.reason || 'unsupported'}）。未解析を「アクセスなし」とは扱いません。`
        : `解析途中です。確認済み region: ${(aggregate?.scannedRegionIds || []).length}、未確認: ${unscanned.length}。未確認範囲を「アクセスなし」とは扱いません。`,
      unsupported
        ? `Field-access analysis is unsupported/incomplete here (${aggregate?.reason || 'unsupported'}). Missing coverage is not treated as evidence of absence.`
        : `Analysis is partial. Scanned regions: ${(aggregate?.scannedRegionIds || []).length}; unscanned: ${unscanned.length}. Unscanned code is not treated as evidence of absence.`)));
  }

  if (!sites.length) {
    host.append(el('div', 'hint', complete
      ? pick('コード全体を確認しましたが、この位置への直接アクセスは見つかりませんでした。', 'The executable regions were checked and no direct access to this offset was found.')
      : pick('確認済み範囲では直接アクセスはまだ見つかっていません。', 'No direct access has been found in the scanned regions yet.')));
    return;
  }

  const grouped = groupSites(app, className, sites, program);
  const totalWrites = grouped.reduce((sum, row) => sum + row.stores, 0);
  host.append(el('div', 'hint', pick(
    `${sites.length} か所を検出。書き込み ${totalWrites} か所。${complete ? '対象 executable region の走査は完了しています。' : '残り region を続けて確認しています。'}`,
    `${sites.length} accesses found, including ${totalWrites} writes. ${complete ? 'Relevant executable regions are complete.' : 'Remaining regions are still being checked.'}`)));

  const rows = list();
  for (const row of grouped.slice(0, 60)) {
    const parts = [];
    if (row.stores) parts.push(pick(`書き込み ${row.stores} か所`, `${row.stores} writes`));
    if (row.loads) parts.push(pick(`読み出し ${row.loads} か所`, `${row.loads} reads`));
    rows.append(tapRow(
      row.owner
        ? `${row.owner.kind || '-'}[${row.owner.className} ${row.owner.sel || '?'}]`
        : (row.addr != null ? functionLabel(app, row.addr) : addrHex(row.first)),
      {
        sub:`${parts.join('  ·  ')}  ·  ${addrHex(row.first)}`,
        tag:row.sameClass ? pick('このクラス', 'this class') : (row.owner ? pick('別のクラス', 'another class') : pick('クラス不明', 'unknown class')),
        tagClass:row.sameClass ? 'tag-fact' : 'tag-infer',
        right:row.stores ? '✎' : '',
        onTap:() => {
          sheet.close();
          if (row.addr != null && typeof app.openFunctionReport === 'function') app.openFunctionReport(row.addr);
          else app.goToAddress(row.first, { announce:true });
        },
      }));
  }
  host.append(rows);
  host.append(el('div', 'sub', pick(
    `同じ offset（${offsetHex(field.offset)}）を触る命令を全 executable region から集めています。別クラスの同一offsetは区別して表示します。`,
    `Instructions touching offset ${offsetHex(field.offset)} are collected across executable regions; same-offset accesses from other classes are labelled separately.`)));
}

export function showField(app, className, field) {
  const controller = new AbortController();
  const sheet = new Sheet(`${className}.${fieldName(field.name)}`, {
    onClose:() => controller.abort('field-access-sheet-closed'),
  });
  const body = sheet.body;

  body.append(el('div', 'bigval', fieldName(field.name)));
  const facts = list();
  facts.append(kvRow(pick('持ち主', 'Belongs to'), className));
  const type = typeText(field.type);
  if (type) facts.append(kvRow(pick('種類', 'Type'), type));
  facts.append(kvRow(pick('置かれている位置', 'Position'), `${offsetHex(field.offset)} ${pick('（オブジェクトの先頭から）', 'from object start')}`));
  if (field.size) facts.append(kvRow(pick('大きさ', 'Size'), `${field.size} ${pick('バイト', 'bytes')}`));
  body.append(facts);

  body.append(el('div', 'hint', pick(
    '現在のregionを先に確認し、その後ほかの executable region を最大2本ずつ確認します。未走査範囲は明示します。',
    'The current region is checked first, then other executable regions are scanned with bounded concurrency. Unscanned scope remains explicit.')));
  const status = el('div', 'hint', pick('アクセスを探しています…', 'Searching for accesses…'));
  const results = el('div');
  body.append(status, results);

  let latest = { results:[], complete:false, unsupported:false, scannedRegionIds:[], unscannedRegionIds:[] };
  let program = null;
  const render = (aggregate) => {
    latest = aggregate;
    if (controller.signal.aborted || !sheet.root.isConnected) return;
    renderResults(app, sheet, results, className, field, aggregate, program);
  };

  // Function ownership is enrichment only. Do not make first field-access evidence
  // wait for the global ProgramIndex; redraw once it becomes available.
  Promise.resolve(app.ensureProgram?.({ signal:controller.signal }))
    .then((value) => {
      if (controller.signal.aborted || !sheet.root.isConnected) return;
      program = value || null;
      render(latest);
    })
    .catch(() => {});

  fieldAccessAcrossExecutableRegions(app, field.offset, field.size || 0, {
    signal:controller.signal,
    concurrency:2,
    onPartial:render,
  }).then((aggregate) => {
    if (controller.signal.aborted || !sheet.root.isConnected) return;
    status.textContent = aggregate.complete
      ? pick('コード全体の確認が完了しました。', 'Executable-region scan complete.')
      : pick(`一部の解析が不完全です（${aggregate.reason || 'unknown'}）。`, `Some analysis remains incomplete (${aggregate.reason || 'unknown'}).`);
    render(aggregate);
  }).catch((error) => {
    if (error?.name === 'AbortError' || controller.signal.aborted) return;
    status.textContent = pick('アクセス解析を完了できませんでした。', 'Field-access analysis could not complete.');
    render({ ...latest, complete:false, reason:error?.message || 'field-access-failed' });
  });

  return sheet;
}
