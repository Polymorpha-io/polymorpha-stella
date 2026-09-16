/**
 * Stella Phase 7 — similarity-threshold semantic cache
 * (`plans/2026-09-14/stella-phase7-paraphrase.md`).
 *
 * EmbeddingService mock uses normalized-text spikes so near-duplicate
 * queries ("what is sd?" vs "what is sd") share a vector while unrelated
 * ones do not — a faithful stand-in for paraphrase similarity.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  clearSemanticCache,
  findSimilarReply,
  setCachedReply,
} from "@/stella/semanticCache";
import { BrainService } from "@/stella/brain/BrainService";
import type { StellaEvent } from "@/stella/brain/BrainService";
import { knowledgeStore } from "@/knowledge/KnowledgeStore";
import { notebookRepository } from "@/notebook/NotebookRepository";

const spies = vi.hoisted(() => ({ embed: vi.fn() }));
const memCache = vi.hoisted(() => new Map<string, unknown>());
const fetchCalls = vi.hoisted(() => [] as Array<string>);

function normVec(text: string): Float32Array {
  const norm = text.toLowerCase().replace(/[^a-z0-9]+/g, "");
  let h = 5381;
  for (let i = 0; i < norm.length; i++)
    h = (Math.imul(33, h) ^ norm.charCodeAt(i)) >>> 0;
  const v = new Float32Array(8);
  v[h % 8] = 1;
  return v;
}

vi.mock("@/embeddings/EmbeddingService", async () => {
  const actual = await vi.importActual<
    typeof import("@/embeddings/EmbeddingService")
  >("@/embeddings/EmbeddingService");
  spies.embed.mockImplementation(async (t: string) => normVec(t));
  return {
    ...actual,
    embeddingService: {
      embed: spies.embed,
      embedMany: async (ts: string[]) => ({
        vectors: ts.map((t) => normVec(t)),
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

function ocBody(text: string): Response {
  return new Response(
    JSON.stringify({
      info: { role: "assistant" },
      parts: [{ type: "text", text }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function ocRouter(url: string): Promise<Response> {
  if (url.endsWith("/session")) {
    return Promise.resolve(
      new Response(JSON.stringify({ id: "ses_sim" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }
  if (url.endsWith("/message")) return Promise.resolve(ocBody("sim answer"));
  return Promise.resolve(
    new Response("true", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function runBrain(
  content: string,
  context: Record<string, unknown> = {},
): Promise<{ full: string; events: StellaEvent[] }> {
  const events: StellaEvent[] = [];
  const svc = new BrainService();
  return svc
    .init("ws-sim")
    .then(
      () =>
        new Promise<string>((resolve, reject) => {
          global.fetch = vi.fn(async (url: string) => {
            // One turn = create + message + delete; only message turns
            // count toward LLM-call assertions below.
            if (url.endsWith("/message")) fetchCalls.push(url);
            return ocRouter(url);
          }) as unknown as typeof fetch;
          void svc.answerStreaming(
            [],
            content,
            "ws-sim",
            undefined,
            () => {},
            (full) => resolve(full),
            (err) => reject(err),
            context as never,
            { onEvent: (e) => events.push(e) },
          );
        }),
    )
    .then((full) => ({ full, events }));
}

beforeEach(() => {
  memCache.clear();
  clearSemanticCache();
  fetchCalls.length = 0;
  spies.embed.mockClear();
  spies.embed.mockImplementation(async (t: string) => normVec(t));
});

describe("findSimilarReply", () => {
  it("hits near-identical vectors, misses orthogonal ones", () => {
    setCachedReply("k", "hit", 1000, [1, 0]);
    expect(findSimilarReply([1, 0], 0.95, 2000)).toBe("hit");
    expect(findSimilarReply([0, 1], 0.95, 2000)).toBeNull();
  });

  it("respects threshold and TTL", () => {
    setCachedReply("k", "hit", 1000, [1, 0]);
    // cosine([1,0],[1,1]) ≈ 0.707
    expect(findSimilarReply([1, 1], 0.95, 2000)).toBeNull();
    expect(findSimilarReply([1, 1], 0.5, 2000)).toBe("hit");
    expect(findSimilarReply([1, 0], 0.95, 1000 + 5 * 60_000 + 1)).toBeNull();
  });

  it("returns null on an empty store", () => {
    expect(findSimilarReply([1, 0], 0.95)).toBeNull();
  });
});

describe("brain similarity cache", () => {
  it("serves near-duplicate queries from cache (one LLM turn)", async () => {
    const first = await runBrain("what is sd?");
    expect(first.full).toContain("sim answer");
    const second = await runBrain("what is sd");
    expect(second.full).toContain("sim answer");
    expect(fetchCalls).toHaveLength(1);
    expect(second.events.some((e) => e.type === "cache_hit")).toBe(true);
  });

  it("misses on unrelated queries", async () => {
    await runBrain("what is sd?");
    await runBrain("completely different chromatography");
    expect(fetchCalls).toHaveLength(2);
  });

  it("bypasses cache for dynamic contexts", async () => {
    await runBrain("what is sd?", { activeCellId: "cell_1" });
    await runBrain("what is sd?", { activeCellId: "cell_1" });
    expect(fetchCalls).toHaveLength(2);
  });

  it("falls through when the query embed fails", async () => {
    spies.embed.mockRejectedValueOnce(new Error("wasm down"));
    const { full } = await runBrain("what is sd?");
    expect(full).toContain("sim answer");
    expect(fetchCalls).toHaveLength(1);
  });
});
