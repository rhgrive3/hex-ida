import { Sheet, el, list, groupRow, tapRow, noteBox } from '../../ui.js';
import { addrHex } from '../../format.js';
import { pick } from '../../i18n.js';
import { recoverSchemasForUi } from '../../analysis/schema-recovery-task.js';
import { showDataTable } from '../../panels-base.js';

function shapeText(best) {
  const parts = [];
  if (best?.columns != null) parts.push(pick(`${best.columns} 列`, `${best.columns} columns`));
  if (best?.columnStride) parts.push(pick(`1 列 ${best.columnStride} バイト`, `${best.columnStride} bytes each`));
  if (best?.recordStride != null) parts.push(pick(`1 件 ${addrHex(BigInt(best.recordStride))} バイト`, `${addrHex(BigInt(best.recordStride))} per record`));
  if (best?.records != null) parts.push(pick(`${best.records} 件`, `${best.records} records`));
  return parts.join('  ·  ');
}

function schemaRow(app, sheet, schema) {
  const files = (schema.files || []).slice(0, 3).join(', ') + ((schema.files || []).length > 3 ? ' …' : '');
  return tapRow(files || pick('名前不明の表', 'Unnamed table'), {
    sub:shapeText(schema.best),
    right:'›',
    onTap:() => { sheet.close(); showDataTable(app, schema); },
  });
}

function renderSchemas(app, sheet, host, schemas) {
  host.replaceChildren();
  if (!schemas?.length) {
    host.append(noteBox(pick(
      '確認できた範囲では、データファイルを読み込む処理を特定できませんでした。',
      'No data-file loader could be identified in the analysed scope.')));
    return;
  }
  const sure = schemas.filter((schema) => schema?.best?.consistent === true);
  const rest = schemas.filter((schema) => schema?.best?.consistent !== true);
  if (sure.length) {
    const rows = list();
    rows.append(groupRow(pick('形まで確かめられた表', 'Tables whose shape checks out')));
    for (const schema of sure) rows.append(schemaRow(app, sheet, schema));
    host.append(rows);
  }
  if (rest.length) {
    const rows = list();
    rows.append(groupRow(pick(`追加確認が必要な表（${rest.length}）`, `Tables needing more evidence (${rest.length})`)));
    for (const schema of rest.slice(0, 60)) rows.append(schemaRow(app, sheet, schema));
    host.append(rows);
  }
  const complete = schemas.complete !== false && schemas.unsupported !== true;
  if (!complete) {
    host.append(noteBox(pick(
      `解析範囲はpartialです${schemas.incompleteReason ? `（${schemas.incompleteReason}）` : ''}。見つからなかった表を「存在しない」とは扱いません。`,
      `Schema recovery is partial${schemas.incompleteReason ? ` (${schemas.incompleteReason})` : ''}. Missing tables are not treated as evidence of absence.`)));
  }
}

export function showDataTables(app) {
  if (!app?.store?.get?.('fileInfo')) return;
  const controller = new AbortController();
  const sheet = new Sheet(pick('データの表', 'Data tables'), {
    onClose:() => controller.abort('schema-sheet-closed'),
  });
  const status = el('div', 'hint', pick('文字列・呼び出し関係・loader命令を確認しています…', 'Checking strings, call relationships, and loader instructions…'));
  const host = el('div');
  sheet.body.append(
    el('div', 'hint', pick(
      '文字列とProgramIndexは独立に準備し、両方が揃った時点でloader recoveryへ進みます。画面を閉じるとこのconsumerは即離脱します。',
      'Strings and ProgramIndex are prepared independently; loader recovery begins when both are ready. Closing this view detaches its consumer immediately.')),
    status,
    host,
  );

  recoverSchemasForUi(app, {
    signal:controller.signal,
    priority:'interactive',
    onProgress:(progress) => {
      if (controller.signal.aborted || !sheet.root.isConnected) return;
      const phase = progress?.phase;
      status.textContent = phase === 'strings'
        ? pick('文字列を確認しています…', 'Collecting strings…')
        : phase === 'program'
          ? pick('呼び出し・参照関係を確認しています…', 'Building call/reference relationships…')
          : phase === 'recover'
            ? pick('loader命令から表の形を復元しています…', 'Recovering table shapes from loader instructions…')
            : status.textContent;
    },
  }).then((schemas) => {
    if (controller.signal.aborted || !sheet.root.isConnected) return;
    status.textContent = pick('解析が完了しました。', 'Analysis complete.');
    renderSchemas(app, sheet, host, schemas);
  }).catch((error) => {
    if (error?.name === 'AbortError' || controller.signal.aborted) return;
    status.textContent = pick('データ表の解析を完了できませんでした。', 'Data-table analysis could not complete.');
    host.append(noteBox(error?.message || String(error)));
  });

  return sheet;
}
