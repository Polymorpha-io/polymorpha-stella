/**
 * Retrieval eval golden set — 10 query→expected pairs over seeded records.
 * Regression guard for Phases 1–3: asserts Recall@3 containment (expected
 * record within top 3). Deliberately lexical-leaning pairs: retrieval must
 * surface exact evidence, not topical noise.
 *
 * Mocks mirror `knowledge-hybrid.test.ts` (spike embeddings, memory cache,
 * empty providers/stores, dictionary OFF to isolate the seeded set).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { knowledgeService } from "@/knowledge/KnowledgeService";
import { knowledgeStore } from "@/knowledge/KnowledgeStore";
import { notebookRepository } from "@/notebook/NotebookRepository";
import type { KnowledgeRecord } from "@/knowledge/types";

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
      embedMany: async (ts: string[]) => ({
        vectors: ts.map(spikeVec),
        keys: ts.map((_, i) => `k${i}`),
      }),
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

function rec(id: string, text: string): KnowledgeRecord {
  const now = Date.now();
  return {
    id,
    workspaceId: "ws-eval",
    notebookId: "nb-eval",
    kind: "note",
    text,
    metadata: { source: "eval" },
    provenance: { workspaceId: "ws-eval", notebookId: "nb-eval" },
    sourceHash: `eval:${id}`,
    createdAt: now,
    updatedAt: now,
  };
}

const CORPUS: KnowledgeRecord[] = [
  rec("r-err", "ERR_4297 occurs when the worker queue saturates; restart it"),
  rec("r-sd", "standard deviation measures spread around the mean"),
  rec("r-miss", "Age column missing values: median imputation recommended"),
  rec("r-dedupe", "Remove duplicate rows keeping the first occurrence"),
  rec("r-pval", "p-value is the probability of data this extreme under H0"),
  rec("r-corr", "correlation matrix shows pairwise linear relationships"),
  rec("r-out", "outlier detection via IQR with skew check"),
  rec("r-schema", "column types detected: numeric, categorical, date"),
];

vi.spyOn(knowledgeStore, "getByWorkspace").mockImplementation(
  async () => [...CORPUS] as never,
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
});

const GOLDEN: Array<[query: string, expectedId: string]> = [
  ["ERR_4297 worker", "r-err"],
  ["what is standard deviation", "r-sd"],
  ["how to handle missing Age values", "r-miss"],
  ["deduplicate rows", "r-dedupe"],
  ["p-value meaning", "r-pval"],
  ["correlation matrix", "r-corr"],
  ["outlier skew", "r-out"],
  ["column types", "r-schema"],
  ["worker queue saturates", "r-err"],
  ["median imputation", "r-miss"],
];

describe("retrieval eval golden set (Recall@3)", () => {
  for (const [query, expectedId] of GOLDEN) {
    it(`"${query}" → ${expectedId} in top 3`, async () => {
      const res = await knowledgeService.search(query, {
        workspaceId: "ws-eval",
        includeSystemKnowledge: false,
        limit: 8,
      });
      const top3 = res.slice(0, 3).map((r) => r.record.id);
      expect(top3).toContain(expectedId);
    });
  }

  it("scores a perfect 10/10 (suite-level recall gate)", async () => {
    let hits = 0;
    for (const [query, expectedId] of GOLDEN) {
      const res = await knowledgeService.search(query, {
        workspaceId: "ws-eval",
        includeSystemKnowledge: false,
        limit: 8,
      });
      if (
        res
          .slice(0, 3)
          .map((r) => r.record.id)
          .includes(expectedId)
      )
        hits++;
    }
    expect(hits).toBe(GOLDEN.length);
  });
});
