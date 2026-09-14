/**
 * Functionalities retrieval golden set — query→expected record pairs over
 * the REAL FunctionalityKnowledgeProvider (only embeddings/stores mocked,
 * mirroring stella-retrieval-eval.test.ts). Regression guard: Stella must
 * surface the right Polymorpha capability in the top 3 for how-to/what
 * questions, or recommendations silently go ungrounded (G30).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { knowledgeService } from "@/knowledge/KnowledgeService";
import { knowledgeStore } from "@/knowledge/KnowledgeStore";
import { notebookRepository } from "@/notebook/NotebookRepository";

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

vi.spyOn(knowledgeStore, "getByWorkspace").mockImplementation(async () => []);
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

async function top3Ids(query: string): Promise<string[]> {
  const res = await knowledgeService.search(query, {
    workspaceId: "ws-eval",
    kinds: ["functionality", "guide"],
    limit: 8,
  });
  return res.slice(0, 3).map((r) => r.record.id);
}

const GOLDEN: Array<[query: string, expectedId: string]> = [
  ["t-test compare two numeric samples", "func::tTest"],
  ["correlation between numeric columns", "func::correlation"],
  ["chi-square categorical association", "func::chiSquare"],
  ["how do I filter rows value list", "func::wrangle-filter"],
  ["export pdf excel reports", "func::wrangle-export"],
  ["what can polymorpha do upload analyse export", "guide::guide-polymorpha"],
];

describe("functionalities retrieval golden set (Recall@3)", () => {
  for (const [query, expectedId] of GOLDEN) {
    it(`"${query}" → ${expectedId} in top 3`, async () => {
      expect(await top3Ids(query)).toContain(expectedId);
    });
  }

  it("scores a perfect 6/6 (suite-level recall gate)", async () => {
    let hits = 0;
    for (const [query, expectedId] of GOLDEN) {
      if ((await top3Ids(query)).includes(expectedId)) hits++;
    }
    expect(hits).toBe(GOLDEN.length);
  });
});
