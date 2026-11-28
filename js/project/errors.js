import {
  MAX_COMMENT_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PROJECT_BYTES,
  MAX_TYPE_LENGTH,
  MAX_VAR_KEY_LENGTH,
} from './limits.js';

const MAX_PROJECT_MIB = Math.round(MAX_PROJECT_BYTES / (1024 * 1024));

const MESSAGES = {
  HEX_PROJECT_TOO_LARGE: {
    ja: `プロジェクトデータが上限（${MAX_PROJECT_MIB} MiB）を超えています。不要なデータを減らしてから保存・読み込みしてください。`,
    en: `Project data exceeds the ${MAX_PROJECT_MIB} MiB safety limit. Reduce the data size and try again.`,
  },
  TOO_LARGE: {
    ja: `保存データが上限（${MAX_PROJECT_MIB} MiB）を超えています。プロジェクトファイルに書き出してバックアップしてください。`,
    en: `Saved data exceeds the ${MAX_PROJECT_MIB} MiB limit. Export your project file to back up your work.`,
  },
  HEX_PROJECT_BINARY_MISMATCH: {
    ja: 'このプロジェクトファイルは現在開いているバイナリ（またはスライス）とは異なるファイル用です。元のバイナリを開いてから読み込んでください。',
    en: 'This project file belongs to a different binary or architecture slice. Open the matching binary before importing.',
  },
  HEX_PROJECT_INVALID_PATCH: {
    ja: 'プロジェクトファイル内に不正または重複したパッチが含まれているため、読み込みを中止しました。',
    en: 'Import aborted because the project file contains invalid or overlapping patch entries.',
  },
  HEX_PROJECT_PATCH_OUT_OF_RANGE: {
    ja: 'パッチの適用先がバイナリのファイルサイズを超えているため、読み込みを中止しました。',
    en: 'Import aborted because a patch extends beyond the binary file size.',
  },
  HEX_PROJECT_NAME_TOO_LONG: {
    ja: `名前が長すぎます（上限は ${MAX_NAME_LENGTH} 文字です）。`,
    en: `A name entry is too long (maximum ${MAX_NAME_LENGTH} characters).`,
  },
  HEX_PROJECT_COMMENT_TOO_LONG: {
    ja: `メモが長すぎます（上限は ${MAX_COMMENT_LENGTH} 文字です）。`,
    en: `A comment entry is too long (maximum ${MAX_COMMENT_LENGTH} characters).`,
  },
  HEX_PROJECT_TYPE_TOO_LONG: {
    ja: `型の記述が長すぎます（上限は ${MAX_TYPE_LENGTH} 文字、キーは ${MAX_VAR_KEY_LENGTH} 文字までです）。`,
    en: `A type entry is too long (maximum ${MAX_TYPE_LENGTH} characters; key maximum ${MAX_VAR_KEY_LENGTH} characters).`,
  },
  HEX_PROJECT_VAR_TOO_LONG: {
    ja: `変数名が長すぎます（上限は ${MAX_NAME_LENGTH} 文字、キーは ${MAX_VAR_KEY_LENGTH} 文字までです）。`,
    en: `A variable name entry is too long (maximum ${MAX_NAME_LENGTH} characters; key maximum ${MAX_VAR_KEY_LENGTH} characters).`,
  },
  HEX_PROJECT_INVALID_UTF8: {
    ja: 'プロジェクトファイルの文字コード（UTF-8）が壊れているため読み込めませんでした。',
    en: 'The project file contains invalid UTF-8 bytes and could not be read.',
  },
  HEX_PROJECT_FUTURE_VERSION: {
    ja: 'このプロジェクトファイルは新しいバージョンの Hex で作成されているため読み込めません。アプリを更新してから再度お試しください。',
    en: 'This project file was created with a newer version of Hex. Update the app and try again.',
  },
  HEX_PROJECT_TOO_DEEP: {
    ja: 'プロジェクトファイルの構造が深すぎるため、安全のため読み込みを中止しました。',
    en: 'The project file is nested too deeply and was rejected for safety.',
  },
  HEX_PROJECT_BIGINT_ENCODING_INVALID: {
    ja: 'プロジェクトファイル内の数値・アドレス表現が壊れているため読み込めませんでした。',
    en: 'The project file contains a malformed address or integer encoding.',
  },
  HEX_PROJECT_BIGINT_ENCODING_UNSUPPORTED: {
    ja: 'プロジェクトファイル内にサポートされていない数値表現が含まれているため読み込めませんでした。',
    en: 'The project file contains an unsupported integer encoding.',
  },
  HEX_PROJECT_BIGINT_ENCODING_COLLISION: {
    ja: 'プロジェクトファイル内の予約キー形式が不正なため読み込めませんでした。',
    en: 'The project file contains a conflicting reserved key encoding.',
  },
  HEX_PROJECT_INVALID: {
    ja: 'プロジェクトファイルの形式が正しくないため読み込めませんでした。',
    en: 'The project file format is invalid and could not be loaded.',
  },
  'resource-limit': {
    ja: 'プロジェクトファイル内のデータ量が安全上限を超えているため読み込めませんでした。',
    en: 'The project file exceeds safety resource limits and could not be loaded.',
  },
  QUOTA_EXCEEDED: {
    ja: 'ブラウザの保存容量が上限に達しました。現在の作業はメモリ上に保持されているため、プロジェクトファイル (.hexproj) に書き出して保存してください。',
    en: 'Browser storage quota is full. Your current work is still in memory—export a .hexproj file to save it safely.',
  },
  QuotaExceededError: {
    ja: 'ブラウザの保存容量が上限に達しました。現在の作業はメモリ上に保持されているため、プロジェクトファイル (.hexproj) に書き出して保存してください。',
    en: 'Browser storage quota is full. Your current work is still in memory—export a .hexproj file to save it safely.',
  },
  STORAGE_ERROR: {
    ja: 'ブラウザへの自動保存に失敗しました。ストレージ設定を確認するか、プロジェクトファイル (.hexproj) に書き出してください。',
    en: 'Failed to save to browser storage. Check storage permissions or export a .hexproj file.',
  },
  IDB_ERROR: {
    ja: 'データベース（IndexedDB）への保存に失敗しました。プロジェクトファイル (.hexproj) に書き出してバックアップしてください。',
    en: 'Failed to save to browser IndexedDB. Export a .hexproj file to back up your work.',
  },
  DELTA_SCAN_INCOMPLETE: {
    ja: '保存領域の一部の読み込みが完了できなかったため、安全のため上書きを停止しました。プロジェクトを書き出してバックアップしてください。',
    en: 'Could not read all saved delta entries; overwriting was paused for safety. Export your project as a backup.',
  },
  INVALID_SNAPSHOT: {
    ja: '保存されていたスナップショットデータが破損しているため復元できませんでした。',
    en: 'The stored snapshot data is corrupted and could not be restored.',
  },
  SNAPSHOT_READ_ERROR: {
    ja: '保存されていたデータの読み込みに失敗しました。',
    en: 'Failed to read stored project snapshot data.',
  },
  HEX_WORKSPACE_STALE: {
    ja: '別のファイルまたはスライスへ切り替わったため、処理を取り消しました。もう一度お試しください。',
    en: 'The operation was cancelled because the active file or slice changed. Please try again.',
  },
  'project-unbound': {
    ja: 'ファイルがまだ開かれていないため、プロジェクト操作を実行できません。',
    en: 'No binary file is currently open for this project operation.',
  },
  'notes-unavailable': {
    ja: 'メモ・名前の保存先が初期化されていないため、操作を完了できませんでした。',
    en: 'The note store is not ready yet, so the operation could not be completed.',
  },
};

function normalizeLang(lang) {
  return String(lang || 'ja').toLowerCase().startsWith('en') ? 'en' : 'ja';
}

function resolveErrorCode(error) {
  if (error == null) return null;
  if (typeof error === 'string') {
    const trimmed = error.trim();
    if (Object.prototype.hasOwnProperty.call(MESSAGES, trimmed)) return trimmed;
    if (/quotaexceeded/i.test(trimmed)) return 'QUOTA_EXCEEDED';
    return null;
  }
  if (typeof error === 'object') {
    const candidates = [error.code, error.name, error.reason, error.message, error.cause?.code, error.cause?.name];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      const trimmed = candidate.trim();
      if (Object.prototype.hasOwnProperty.call(MESSAGES, trimmed)) return trimmed;
      if (/quotaexceeded/i.test(trimmed)) return 'QUOTA_EXCEEDED';
    }
  }
  return null;
}

export function formatProjectError(error, lang = 'ja') {
  const locale = normalizeLang(lang);
  const code = resolveErrorCode(error);
  if (code && MESSAGES[code]) {
    return MESSAGES[code][locale];
  }
  return locale === 'en'
    ? 'Could not complete the project operation. Check the file format or storage availability and try again.'
    : 'プロジェクトの保存または読み込みを完了できませんでした。ファイルの形式やブラウザの保存容量を確認して再度お試しください。';
}
