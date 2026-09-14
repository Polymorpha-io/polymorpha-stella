/**
 * Stella Phase 2 — hybrid BM25+RRF, FeatureReranker, MMR, query expansion
 * (`plans/2026-09-13/stella-phase2-hybrid-rerank.md`).
 *
 * Mocks mirror `stella-harness.test.ts`: deterministic spike embeddings,
 * in-memory EmbeddingCache (real key fn), empty dataset/relationship
 * providers, memory KnowledgeStore.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  HYBRID_RRF_K,
  DICTIONARY_QUERY_TOP,
  RERANK_MMR_LAMBDA,
} from "@/config/retrieval";
import {
  tokenizeText,
  bm25Scores,
  rankIndices,
  rrfFuse,
} from "@/knowledge/hybridSearch";
import { featureScore, FeatureReranker, mmrSelect } from "@/knowledge/reranker";
import {
  expandQueryTerms,
  singularForm,
  pluralForm,
} from "@/knowledge/queryExpansion";
import type { KnowledgeRecord, KnowledgeResult } from "@/knowledge/types";
import { knowledgeService } from "@/knowledge/KnowledgeService";
import { knowledgeStore } from "@/knowledge/KnowledgeStore";
import { notebookRepository } from "@/notebook/NotebookRepository";

// ---------------------------------------------------------------------------
// Mocks (hoisted state where factories need it)
// ---------------------------------------------------------------------------

const embedCalls = vi.hoisted(() => ({ embedMany: 0 }));
const memCache = vi.hoisted(() => new Map<string, unknown>());

function spikeVec(text: string): Float32Array {
  let h = 5381;
  for (let i = 0; i < text.length; i++)
    h = (Math.imul(33, h) ^ text.charCodeAt(i)) >>> 0;
  const v = new Float32Array(384);
  v[h % 384] = 1;
  return v;
}

vi.mock("@/embeddings/EmbeddingService", async () => {
  const actual = await vi.importActual<
    typeof import("@/embeddings/EmbeddingService")
  >("@/embeddings/EmbeddingService");
  return {
    ...actual,
    embeddingService: {
      embed: async (t: string) => spikeVec(t),
      embedMany: async (ts: string[]) => {
        embedCalls.embedMany++;
        return {
          vectors: ts.map(spikeVec),
          keys: ts.map((_, i) => `k${i}`),
        };
      },
      chunkText: actual.chunkText,
      cosineSimilarity: actual.cosineSimilarity,
    },
  };
});

vi.mock("@/embeddings/EmbeddingCache", async () => {
  const actual = await vi.importActual<
    typeof import("@/embeddings/EmbeddingCache")
  >("@/embeddings/EmbeddingCache");
  return {
    ...actual,
    embeddingCache: {
      get: async (k: string) => memCache.get(k) ?? null,
      set: async (e: { embeddingKey: string }) => {
        memCache.set(e.embeddingKey, e);
      },
      setMany: async (es: Array<{ embeddingKey: string }>) => {
        for (const e of es) memCache.set(e.embeddingKey, e);
      },
      touch: async () => {},
      has: async (k: string) => memCache.has(k),
      invalidate: async (k: string) => {
        memCache.delete(k);
      },
      clear: async () => {
        memCache.clear();
      },
      count: async () => memCache.size,
    },
  };
});

vi.mock("@/knowledge/providers/DatasetKnowledgeProvider", () => ({
  DatasetKnowledgeProvider: class {
    async provide() {
      return [];
    }
  },
}));

vi.mock("@/knowledge/providers/RelationshipKnowledgeProvider", () => ({
  RelationshipKnowledgeProvider: class {
    async provide() {
      return [];
    }
  },
}));

function makeRecord(id: string, text: string): KnowledgeRecord {
  const now = Date.now();
  return {
    id,
    workspaceId: "ws-hybrid",
    notebookId: "nb-hybrid",
    kind: "note",
    text,
    metadata: { source: "test" },
    provenance: { workspaceId: "ws-hybrid", notebookId: "nb-hybrid" },
    sourceHash: `test:${id}`,
    createdAt: now,
    updatedAt: now,
  };
}

function makeResult(
  id: string,
  text: string,
  score: number,
  vector?: Float32Array,
): KnowledgeResult {
  return { record: makeRecord(id, text), score, vector };
}

let seeded: KnowledgeRecord[] = [];

vi.spyOn(knowledgeStore, "getByWorkspace").mockImplementation(
  async () => [...seeded] as never,
);
vi.spyOn(knowledgeStore, "getByNotebook").mockImplementation(async () => []);
vi.spyOn(knowledgeStore, "getByCell").mockImplementation(async () => []);
vi.spyOn(knowledgeStore, "getAll").mockImplementation(async () => []);
vi.spyOn(knowledgeStore, "getByDatasetId").mockImplementation(async () => []);
vi.spyOn(notebookRepository, "get").mockImplementation(async () => null);
vi.spyOn(notebookRepository, "getByWorkspace").mockImplementation(
  async () => null,
);

beforeEach(() => {
  memCache.clear();
  seeded = [];
  embedCalls.embedMany = 0;
});

// ---------------------------------------------------------------------------
// Batch A — tokenizer / BM25 / RRF
// ---------------------------------------------------------------------------

describe("hybridSearch", () => {
  it("tokenizer keeps c++/c#/t-test, drops 1-char tokens", () => {
    expect(tokenizeText("C++ C# t-test a I")).toEqual(["c++", "c#", "t-test"]);
  });

  it("BM25 ranks the exact-identifier doc first", () => {
    const docs = [
      "generic error handling guide with retries and backoff advice",
      "ERR_4297 fix: restart the worker and clear the queue",
    ];
    const scores = bm25Scores("ERR_4297", docs);
    expect(scores[1]).toBeGreaterThan(scores[0]);
  });

  it("BM25 returns zeros for empty queries", () => {
    expect(bm25Scores("  ", ["some text"])).toEqual([0]);
  });

  it("rankIndices is a stable best-first ordering", () => {
    expect(rankIndices([0.1, 0.9, 0.5, 0.9])).toEqual([1, 3, 2, 0]);
  });

  it("RRF rewards consensus: top-in-both beats the field", () => {
    const fused = rrfFuse(
      [
        [0, 1, 2, 3],
        [0, 2, 3, 1],
      ],
      4,
      HYBRID_RRF_K,
    );
    expect(fused[0]).toBe(Math.max(...fused));
    // Doc 2 (ranks 3rd + 2nd) outranks doc 1 (2nd + 4th).
    expect(fused[2]).toBeGreaterThan(fused[1]);
  });

  it("RRF over a single list preserves that ranking", () => {
    const fused = rrfFuse([[2, 0, 1]], 3, HYBRID_RRF_K);
    const order = rankIndices(fused);
    expect(order).toEqual([2, 0, 1]);
  });
});

// ---------------------------------------------------------------------------
// Batch B — reranker / MMR
// ---------------------------------------------------------------------------

describe("reranker", () => {
  it("featureScore prefers exact-phrase matches", () => {
    const query = "standard deviation";
    const exact = "standard deviation measures spread around the mean";
    const partial = "mean and variance describe central tendency";
    expect(featureScore(query, exact)).toBeGreaterThan(
      featureScore(query, partial),
    );
  });

  it("featureScore is 0 for empty queries", () => {
    expect(featureScore("  ", "some text")).toBe(0);
  });

  it("FeatureReranker keeps boosts but reorders by lexical fit", () => {
    const r = new FeatureReranker();
    expect(r.name).toBe("feature-lexical-v1");
    const out = r.rerank("standard deviation", [
      makeResult("a", "unrelated cats and dogs", 0.9),
      makeResult("b", "standard deviation definition here", 0.1),
    ]);
    expect(out[0].record.id).toBe("b");
    // Boosts preserved: lexical fit adds to (not replaces) base score.
    expect(out[0].score).toBeGreaterThan(0.1);
  });

  it("mmrSelect suppresses near-duplicates", () => {
    const v = spikeVec("column Age missing values imputed");
    const w = spikeVec("totally different chart colors legend");
    const pool = [
      makeResult("dup1", "column Age missing values imputed", 0.9, v),
      makeResult("dup2", "column Age missing values imputed", 0.89, v),
      makeResult("other", "totally different chart colors legend", 0.5, w),
    ];
    const picked = mmrSelect(pool, 2, RERANK_MMR_LAMBDA).map(
      (r) => r.record.id,
    );
    expect(picked).toContain("dup1");
    expect(picked).toContain("other");
    expect(picked).not.toContain("dup2");
  });

  it("mmrSelect returns all when under topN", () => {
    const pool = [makeResult("a", "alpha", 0.2)];
    expect(mmrSelect(pool, 5)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Batch C — query expansion
// ---------------------------------------------------------------------------

describe("queryExpansion", () => {
  it("expands stats abbreviations", () => {
    const out = expandQueryTerms("what is sd");
    expect(out).toContain("standard");
    expect(out).toContain("deviation");
  });

  it("adds singular/plural counterparts", () => {
    expect(expandQueryTerms("categories")).toContain("category");
    expect(expandQueryTerms("category")).toContain("categories");
    expect(singularForm("columns")).toBe("column");
    expect(pluralForm("column")).toBe("columns");
  });

  it("no-ops on sub-token queries", () => {
    expect(expandQueryTerms("a b")).toBe("a b");
  });
});

// ---------------------------------------------------------------------------
// Integration — exact term wins end-to-end (hybrid + rerank)
// ---------------------------------------------------------------------------

describe("knowledgeService hybrid integration", () => {
  it("exact-identifier record outranks topical noise", async () => {
    seeded = [
      makeRecord(
        "noise",
        "general guidance on handling errors with retries and backoff",
      ),
      makeRecord(
        "exact",
        "ERR_4297 occurs when the worker queue saturates; restart it",
      ),
    ];
    const res = await knowledgeService.search("ERR_4297 worker", {
      workspaceId: "ws-hybrid",
      includeSystemKnowledge: false,
    });
    expect(res[0].record.id).toBe("exact");
  });

  it("dictionary survivors stay bounded with hybrid on", async () => {
    const res = await knowledgeService.search("What is overfitting?", {
      workspaceId: "ws-hybrid",
      includeSystemKnowledge: true,
      limit: DICTIONARY_QUERY_TOP,
    });
    expect(res.length).toBeLessThanOrEqual(DICTIONARY_QUERY_TOP);
  });
});
