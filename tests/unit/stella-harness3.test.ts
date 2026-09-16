/**
 * Stella Phase 3 — semantic cache, single-backend wiring, metrics
 * (`plans/2026-09-13/stella-harness-tokens-rag.md`; Groq routing/tool-loop
 * removed with the OpenCode-only backend — see stella-opencode-backend plan).
 *
 * Mocks: spike embeddings, memory EmbeddingCache, empty providers/stores
 * (as in hybrid tests); fetch scripted per test (OpenCode `{info, parts}`).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  clearSemanticCache,
  getCachedReply,
  semanticCacheKey,
  setCachedReply,
} from "@/stella/semanticCache";
import { BrainService } from "@/stella/brain/BrainService";
import type { StellaEvent } from "@/stella/brain/BrainService";
import { notebookContextBuilder } from "@/notebook/NotebookContextBuilder";
import type { KnowledgeRecord } from "@/knowledge/types";
import { knowledgeStore } from "@/knowledge/KnowledgeStore";
import { notebookRepository } from "@/notebook/NotebookRepository";

// ---------------------------------------------------------------------------
// Shared mocks
// ---------------------------------------------------------------------------

const memCache = vi.hoisted(() => new Map<string, unknown>());
const fetchCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);

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

// ---------------------------------------------------------------------------
// Fetch scripting helpers
// ---------------------------------------------------------------------------

function ocReply(text: string): Response {
  return new Response(
    JSON.stringify({
      info: { role: "assistant" },
      parts: [{ type: "text", text }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function ocSession(id = "ses_h3"): Response {
  return new Response(JSON.stringify({ id }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function ocTrue(): Response {
  return new Response("true", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Route OpenCode session traffic; only message POSTs are recorded. */
function ocRoute(url: string, reply: () => Response): Response {
  if (url.endsWith("/session")) return ocSession();
  if (url.endsWith("/message")) return reply();
  return ocTrue();
}

function runBrain(
  content: string,
  script: () => Response,
  opts?: Parameters<BrainService["answerStreaming"]>[8],
  workspaceId = "ws-h3",
): Promise<{ full: string; events: StellaEvent[] }> {
  const events: StellaEvent[] = [];
  const svc = new BrainService();
  return svc
    .init(workspaceId)
    .then(
      () =>
        new Promise<string>((resolve, reject) => {
          global.fetch = vi.fn(async (url: unknown, init: unknown) => {
            const u = String(url);
            if (u.endsWith("/session")) return ocSession();
            if (u.endsWith("/message")) {
              const body = JSON.parse(
                (init as { body: string }).body,
              ) as Record<string, unknown>;
              fetchCalls.push(body);
              return script();
            }
            return ocTrue();
          }) as unknown as typeof fetch;
          void svc.answerStreaming(
            [],
            content,
            workspaceId,
            undefined,
            () => {},
            (full) => resolve(full),
            (err) => reject(err),
            {},
            { ...opts, onEvent: (e) => events.push(e) },
          );
        }),
    )
    .then((full) => ({ full, events }));
}

beforeEach(() => {
  memCache.clear();
  clearSemanticCache();
  fetchCalls.length = 0;
});

// ---------------------------------------------------------------------------
// Cache units (no LLM)
// ---------------------------------------------------------------------------

describe("semanticCache", () => {
  it("round-trips and expires by TTL", () => {
    const key = semanticCacheKey("ws", "opencode-go/muse-spark", "Hello?");
    expect(getCachedReply(key, 1000)).toBeNull();
    setCachedReply(key, "hi", 1000);
    expect(getCachedReply(key, 1000)).toBe("hi");
    expect(getCachedReply(key, 1000 + 5 * 60_000 + 1)).toBeNull();
  });

  it("normalizes case/whitespace into one key", () => {
    expect(
      semanticCacheKey("ws", "opencode-go/muse-spark", "  What IS sd? "),
    ).toBe(semanticCacheKey("ws", "opencode-go/muse-spark", "what is sd?"));
  });
});

// ---------------------------------------------------------------------------
// Brain wiring: single backend, cache, metrics
// ---------------------------------------------------------------------------

describe("brain phase-3 wiring", () => {
  it("sends the configured OpenCode model with tools disabled", async () => {
    const { full } = await runBrain("y".repeat(301), () => ocReply("ok"));
    expect(full).toContain("ok");
    const body = fetchCalls[0] as {
      model: { providerID: string; modelID: string };
      agent: string;
      tools: unknown;
      system: string;
    };
    expect(body.model.providerID).toBe("opencode-go");
    expect(body.agent).toBe("general");
    expect(body.tools).toEqual({});
    expect(typeof body.system).toBe("string");
  });

  it("folds history and the current turn into one stateless message", async () => {
    const svc = new BrainService();
    await svc.init("ws-h3");
    const events: StellaEvent[] = [];
    global.fetch = vi.fn(async (url: unknown, init: unknown) => {
      const u = String(url);
      if (u.endsWith("/message")) {
        fetchCalls.push(
          JSON.parse((init as { body: string }).body) as Record<
            string,
            unknown
          >,
        );
      }
      return ocRoute(u, () => ocReply("ok"));
    }) as unknown as typeof fetch;
    const full = await new Promise<string>((resolve, reject) => {
      void svc.answerStreaming(
        [
          { role: "user", content: "first question" },
          { role: "assistant", content: "first answer" },
        ],
        "plain question about means",
        "ws-h3",
        undefined,
        () => {},
        (f) => resolve(f),
        (e) => reject(e),
        {},
        { onEvent: (e) => events.push(e) },
      );
    });
    expect(full).toContain("ok");
    const body = fetchCalls[0] as {
      parts: Array<{ type: string; text: string }>;
    };
    expect(body.parts).toHaveLength(1);
    expect(body.parts[0].text).toContain("first question");
    expect(body.parts[0].text).toContain("plain question about means");
  });

  it("serves stable repeats from semantic cache (one LLM turn)", async () => {
    const q = "cacheable means question";
    const first = await runBrain(q, () => ocReply("cached answer"));
    expect(first.full).toContain("cached answer");
    const second = await runBrain(q, () => ocReply("must not appear"));
    expect(second.full).toContain("cached answer");
    expect(fetchCalls).toHaveLength(1);
    expect(second.events.some((e) => e.type === "cache_hit")).toBe(true);
  });

  it("surfaces provider info.error as a chat error", async () => {
    const bad = new Response(
      JSON.stringify({
        info: {
          role: "assistant",
          error: {
            name: "APIError",
            data: { message: "nope", statusCode: 401 },
          },
        },
        parts: [],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
    await expect(runBrain("provider failure probe", () => bad)).rejects.toThrow(
      "OpenCode provider error: nope",
    );
  });

  it("emits rag_done + llm_done metrics on a plain run", async () => {
    const { events } = await runBrain("metric probe query", () =>
      ocReply("ok"),
    );
    const rag = events.find((e) => e.type === "rag_done");
    const llm = events.find((e) => e.type === "llm_done");
    expect(rag).toMatchObject({ ragHits: expect.any(Number) });
    expect(llm?.model).toBe("opencode-go/muse-spark-1.2-contributor");
    expect(llm?.toolIters).toBe(0);
    expect(llm?.estInputTokens).toBeGreaterThan(0);
  });
});

describe("notebook evidence reuse", () => {
  function makeRec(id: string, text: string): KnowledgeRecord {
    const now = Date.now();
    return {
      id,
      workspaceId: "ws-ev",
      notebookId: "nb-ev",
      kind: "notebook_cell",
      text,
      metadata: { source: "test" },
      provenance: { workspaceId: "ws-ev", notebookId: "nb-ev" },
      sourceHash: `ev:${id}`,
      createdAt: now,
      updatedAt: now,
    };
  }

  function systemPromptOf(body: Record<string, unknown>): string {
    return (body as { system?: string }).system ?? "";
  }

  it("merges builder-only records, dedupes search hits", async () => {
    const shared = makeRec("shared-1", "SHAREDMARKER alpha cell narrative");
    const only = makeRec("nb-only-2", "ONLYMARKER beta cell narrative");
    const buildSpy = vi
      .spyOn(notebookContextBuilder, "build")
      .mockResolvedValue({
        activeCell: undefined,
        precedingCells: [],
        relevantCells: [],
        relevantKnowledge: [shared, only],
        datasets: [],
      });
    vi.mocked(knowledgeStore.getByWorkspace).mockImplementationOnce(
      async () => [shared] as never,
    );
    try {
      const events: StellaEvent[] = [];
      const svc = new BrainService();
      await svc.init("ws-ev");
      global.fetch = vi.fn(async (url: unknown, init: unknown) => {
        const u = String(url);
        if (u.endsWith("/message")) {
          const body = JSON.parse((init as { body: string }).body) as Record<
            string,
            unknown
          >;
          fetchCalls.push(body);
        }
        return ocRoute(u, () => ocReply("ok"));
      }) as unknown as typeof fetch;
      const full = await new Promise<string>((resolve, reject) => {
        void svc.answerStreaming(
          [],
          "marker probe evidence",
          "ws-ev",
          undefined,
          () => {},
          (f) => resolve(f),
          (e) => reject(e),
          { activeCellId: "cell_9" },
          { onEvent: (e) => events.push(e) },
        );
      });
      expect(full).toContain("ok");
      // Builder received the request context (incl. dataset filter slot).
      expect(buildSpy).toHaveBeenCalledOnce();
      expect(buildSpy.mock.calls[0][0]).toMatchObject({
        workspaceId: "ws-ev",
        activeCellId: "cell_9",
      });
      const sys = systemPromptOf(fetchCalls[fetchCalls.length - 1]);
      expect(sys).toContain("[notebook_evidence]");
      expect(sys).toContain("ONLYMARKER");
      // Shared record appears once (search block), not twice.
      expect(sys.split("SHAREDMARKER").length - 1).toBe(1);
    } finally {
      buildSpy.mockRestore();
    }
  });
});
