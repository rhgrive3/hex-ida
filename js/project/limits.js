/**
 * Shared project & annotation safety limits.
 * Leaf module with zero internal dependencies so both NoteStore and
 * project validation can import these constants without cycles.
 */

export const MAX_PROJECT_BYTES = 16 * 1024 * 1024;
export const MAX_NAME_LENGTH = 256;
export const MAX_COMMENT_LENGTH = 2000;
export const MAX_TYPE_LENGTH = 128;
export const MAX_VAR_KEY_LENGTH = 256;
export const MAX_PATCH_ENTRIES = 100_000;
