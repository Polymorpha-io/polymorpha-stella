/**
 * Retrieval-plane constants (single source, `D20`).
 * Every `topK` / `limit` / scoring literal in VectorStore, KnowledgeService,
 * BrainService and NotebookContextBuilder lives here. Values moved verbatim.
 */

/** Federated vector search default. */
export const RETRIEVAL_TOP_K = 5;
/** Default result limit (VectorStore.search, NotebookContextBuilder). */
export const RETRIEVAL_LIMIT_DEFAULT = 8;
/** Data-context limit (BrainService, data_representative branch, column embeddings). */
export const RETRIEVAL_LIMIT_DATA = 12;
/** Dictionary terms offered to the retrieval plane. */
export const DICTIONARY_TERMS_LIMIT = 80;
/** Preceding notebook cells included as context. */
export const CONTEXT_PRECEDING_CELLS = 5;
/** Categorical insight cap per RAG pipeline. */
export const RAG_CATEGORICAL_TOP_K = 5;
/** Score for records with no vector (metadata-only fallback). */
export const SCORE_FALLBACK = 0.5;
/** KnowledgeService ranking boosts (moved verbatim). */
export const SCORE_BOOSTS = {
  statusActive: 0.15,
  statusStale: 0.05,
  statusSuperseded: -0.1,
  datasetMatch: 0.2,
  activeCell: 0.3,
  columnMatch: 0.2,
  cellDistance: 0.15,
  provenanceDistance: 0.1,
} as const;

/** RAG pipeline insight thresholds (moved verbatim from lib/rag/pipelines). */
export const RAG_HIGH_MISSING_PCT = 20;
export const RAG_MISSING_TOGETHER_TOP = 4;
export const RAG_CORR_FLAG = 0.3;
export const RAG_UNIQUE_RATIO = 0.98;
export const RAG_MAJORITY_RATIO = 0.5;
export const RAG_MIN_COMPOSITE_KEYS = 2;
export const RAG_TOP_CANDIDATE_KEYS = 3;
export const RELATIONSHIP_MISSING_TOP = 10;
export const RELATIONSHIP_LIST_TOP = 5;
