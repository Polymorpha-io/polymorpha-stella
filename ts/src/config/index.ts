// Stella library config — no firebase here (polymorpha UI injects via StellaConfig). Mirror EMBED_* from polymorpha/src/config for standalone builds.

export const LARGE_FILE_THRESHOLD = Number(
  (import.meta as unknown as { env: Record<string, string> }).env
    ?.VITE_LARGE_FILE_THRESHOLD ?? "5000",
);
export const ANON_MAX_ROWS = 10_000;
export const SKIP_GZIP_BYTES = 1024;
export const COMPRESS_LEVEL = 6;

/** 50 MB — IndexedDB T3 cap + Storage upload limit (storage.rules). */
export const MAX_T3_BYTES = 50 * 1024 * 1024;
/** Alias for upload guard — same 50 MB as storage.rules. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** 100 MB — warning threshold, not a hard block (D20 G18). */
export const WARN_FILE_SIZE = 100 * 1024 * 1024;
/** Max T1 memory entries for LRU. */
export const MAX_MEM_ENTRIES = 50;
/** Max session keys before LRU eviction (avoid 5MB quota). */
export const MAX_SESSION_KEYS = 100;
/** Preview slice — first 100 rows for paint; full is on Storage. */
export const PREVIEW_MAX_ROWS = 100;
/** Threshold above which preview+background load is used. */
export const PREVIEW_ROW_THRESHOLD = 100;
/** Dynamic dataset re-sync TTL (5 min). */
export const DYNAMIC_SYNC_TTL_MS = 5 * 60 * 1000;
/** Cover image max (5 MB). */
export const COVER_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** Threshold above which resumable upload is used (10 MB). */
export const RESUMABLE_THRESHOLD_BYTES = 10 * 1024 * 1024;
/** Quota cache TTL (30 s, mirrors CACHE_TTL.quota). */
export const QUOTAS_CACHE_TTL_MS = 30_000;
/** 100 MB — max saved bytes per user (D20 single source for FirestoreService). */
export const MAX_QUOTA_BYTES = 100 * 1024 * 1024;

/** Embedding — model + dims + chunking (D20 single source for G24) */
export const EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBED_DIM = 384;
export const EMBED_TOP_K = 5;
export const EMBED_PER_COLUMN_LIMIT = 12;
export const EMBED_DATA_SAMPLE_N = 200;
export const EMBED_CHUNK_TOKENS = 512;
export const EMBED_CACHE_TTL = 30_000;
/** Embedding — representation sampling versioned contract (Addendum §2 G24) */
export const EMBED_SAMPLING_VERSION = "v1-head-tail-quantile-rare";
export const EMBED_SAMPLING_SEED = "polymorpha-v1";
export const EMBED_VECTOR_IDB = "polymorpha-vectors";
export const EMBED_VECTOR_MAX_BYTES = 20 * 1024 * 1024;
export const EMBED_VECTOR_MAX_ENTRIES = 10_000;
export type RepresentationMode = "representative" | "exact";
export type SampleCoverage = "sample" | "exact";
export const EMBED_DEFAULT_REPRESENTATION_MODE: RepresentationMode =
  "representative";
export const EMBED_COLUMN_CHUNK_SIZE = 12;
export const EMBED_DATASET_DESCRIPTION = true;
