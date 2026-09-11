/**
 * Knowledge-plane constants: IndexedDB homes, record-id snippets,
 * sentinels and API paths (single source, `D20`).
 * Hash truncations reuse `@polymorpha/business-logic` limits
 * (`HASH_PREFIX_LEN` 16 / `HASH_SHORT_LEN` 12 / `HASH_TINY_LEN` 8).
 */

export const IDB_EMBEDDINGS = {
  db: "polymorpha-embeddings",
  store: "embeddings",
  version: 1,
} as const;
export const IDB_KNOWLEDGE = {
  db: "polymorpha-knowledge",
  store: "knowledge",
  version: 2,
} as const;
export const IDB_VECTORS = {
  db: "polymorpha-vectors",
  store: "vectors",
  version: 1,
} as const;
export const IDB_NOTEBOOKS = {
  db: "polymorpha-notebooks",
  stores: { notebooks: "notebooks", outputs: "outputs" },
  version: 1,
} as const;

/** Record-id / description truncation lengths (moved verbatim). */
export const SNIPPET_ID = 80;
export const SNIPPET_TITLE = 80;
export const SNIPPET_PROFILE = 100;
export const SNIPPET_BRAIN_OUTPUT = 180;
export const SNIPPET_CELL_NOTE = 200;
export const SNIPPET_OUTPUT = 300;
export const SNIPPET_NOTE = 400;
export const SNIPPET_REP = 50;
export const IPYNB_TRUNCATE = 2_000;
export const IPYNB_ERROR_TRUNCATE = 500;

/** Cross-dataset / guest / system sentinels. */
export const SENTINEL_SINGLE = "__single__";
export const SENTINEL_GUEST = "guest";
export const SENTINEL_SYSTEM = "system";

/** Stella chat API path (mirrored by the UI worker proxy). */
export const STELLA_CHAT_PATH = "/api/stella/chat";

/** Timeline section label in notebook context. */
export const TIMELINE_LABEL = "recent operations";

/** Rows hashed into the lightweight dataset fingerprint. */
export const RAG_HASH_ROWS = 3;

/** Top-N insight lists in dataset knowledge providers. */
export const DATASET_TOP_INSIGHTS = 5;
export const DATASET_TOP_QUALITY = 3;

/** Vector size-estimate overheads (moved verbatim per store). */
export const EMBED_CACHE_OVERHEAD = 200;
export const VECTOR_CACHE_OVERHEAD = 300;
