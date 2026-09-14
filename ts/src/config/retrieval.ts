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
/** Dictionary records surviving query prefilter into the embedding stage. */
export const DICTIONARY_QUERY_TOP = 12;
/** Functionality records surviving query prefilter into the embedding stage. */
export const FUNCTIONALITY_QUERY_TOP = 12;
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

/** Stella chat-harness budgets (Phase 1 hardening — bounds per-turn tokens). */
/** Max history messages forwarded to the LLM (most recent first). */
export const STELLA_HISTORY_LIMIT = 20;
/** Anchor messages kept from session start when the window compacts. */
export const STELLA_HISTORY_HEAD_KEEP = 1;
/** Completion cap sent as `max_tokens` (worker passthrough honors it). */
export const STELLA_MAX_TOKENS = 800;
/** Chat fetch timeout applied when the caller supplies no signal. */
export const STELLA_REQUEST_TIMEOUT_MS = 60_000;
/** Retries on network-error/5xx only (never abort/4xx/mid-stream). */
export const STELLA_MAX_RETRIES = 1;
/** Base delay before the single retry. */
export const STELLA_RETRY_BASE_MS = 500;
/** EmbeddingCache namespace — bump to invalidate cached vectors (S14). */
export const EMBED_CACHE_VERSION = "v1";

/** Hybrid retrieval (Phase 2): BM25 + dense cosine fused via RRF. */
/** Master switch — false restores pure-dense ranking. */
export const HYBRID_ENABLED = true;
/** BM25 saturation (k1) and length-normalization (b) — literature defaults. */
export const HYBRID_BM25_K1 = 1.2;
export const HYBRID_BM25_B = 0.75;
/** RRF rank constant — scale-free fusion, no score normalization needed. */
export const HYBRID_RRF_K = 60;
/** Rerank stage (Phase 2B): false skips rerank+MMR, keeps fused order. */
export const RERANK_ENABLED = true;
/** Candidates rescored by the reranker before the final limit applies. */
export const RERANK_CANDIDATES = 24;
/** MMR diversity trade-off (1 = pure relevance, 0 = pure diversity). */
export const RERANK_MMR_LAMBDA = 0.7;
/** Query expansion (Phase 2C): false searches the raw query only. */
export const QUERY_EXPANSION_ENABLED = true;
/** Builder evidence records merged into context (deduped vs search hits). */
export const NOTEBOOK_EVIDENCE_TOP = 4;

/** Phase 3 harness: agentic tool loop (default OFF until live-measured). */
export const STELLA_TOOLS_ENABLED = false;
export const STELLA_MAX_TOOL_ITERS = 2;
/** Per-tool result chars stuffed back into context. */
export const STELLA_TOOL_RESULT_BUDGET = 1500;
/** Model routing (Phase 3): upgrade signals for the strong model. */
export const STELLA_ROUTE_STRONG_MIN_CHARS = 300;
export const STELLA_ROUTE_STRONG_MIN_HISTORY = 12;
/** Semantic answer cache: TTL + cap (stable-context queries only). */
export const STELLA_SEMANTIC_CACHE_ENABLED = true;
export const STELLA_SEMANTIC_CACHE_TTL_MS = 5 * 60_000;
export const STELLA_SEMANTIC_CACHE_MAX = 100;
/** Paraphrase-level cache hits via query-vector cosine (default ON). */
export const STELLA_SEMANTIC_SIM_ENABLED = true;
export const STELLA_SEMANTIC_SIM_THRESHOLD = 0.95;
/** LLM expansion terms (Phase 3F): extra rewrite call, default OFF. */
export const QUERY_LLM_EXPANSION_ENABLED = false;
export const QUERY_LLM_EXPANSION_MAX_TOKENS = 120;
