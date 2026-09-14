/**
 * Stella Phase 3 — routing, semantic cache, tool loop, metrics, LLM
 * expansion (`plans/2026-09-13/stella-phase3-harness.md`).
 *
 * Mocks: spike embeddings, memory EmbeddingCache, empty providers/stores
 * (as in hybrid tests); fetch scripted per test (SSE / JSON / tool-calls).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { DEFAULT_GROQ_MODEL, GROQ_STRONG_MODEL } from "@/stella/types";
import { routeChatModel } from "@/stella/routing";
import {
  clearSemanticCache,
  getCachedReply,
  semanticCacheKey,
  setCachedReply,
} from "@/stella/semanticCache";
import { assembleToolCalls } from "@/stella/brain/tools";
import { BrainService } from "@/stella/brain/BrainService";
import type { StellaEvent } from "@/stella/brain/BrainService";
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

function sseBody(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const payload = chunks
    .map(
      (c) =>
        `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`,
    )
    .join("");
  const stream = new ReadableStream({
    start(s) {
      s.enqueue(encoder.encode(payload));
      s.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function sseToolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
): Response {
  const encoder = new TextEncoder();
  // Name split across two chunks exercises the assembler.
  const payload =
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: name.slice(0, 6) } }] } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: name.slice(6), arguments: JSON.stringify(args) } }] } }] })}\n\n`;
  const stream = new ReadableStream({
    start(s) {
      s.enqueue(encoder.encode(payload));
      s.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function jsonBody(message: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: message } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function runBrain(
  content: string,
  script: (body: Record<string, unknown>) => Response,
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
          global.fetch = vi.fn(async (_url, init) => {
            const body = JSON.parse((init as { body: string }).body) as Record<
              string,
              unknown
            >;
            fetchCalls.push(body);
            return script(body);
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
// Routing + cache units (no LLM)
// ---------------------------------------------------------------------------

describe("routing", () => {
  it("keeps short simple queries on the fast model", () => {
    expect(routeChatModel("what is a p-value", 0)).toBe(DEFAULT_GROQ_MODEL);
  });

  it("upgrades long, historic, or comparative queries", () => {
    expect(routeChatModel("x".repeat(301), 0)).toBe(GROQ_STRONG_MODEL);
    expect(routeChatModel("short", 13)).toBe(GROQ_STRONG_MODEL);
    expect(routeChatModel("compare t-test versus ANOVA", 0)).toBe(
      GROQ_STRONG_MODEL,
    );
  });

  it("respects an explicit non-default model", () => {
    expect(routeChatModel("anything", 99, GROQ_STRONG_MODEL)).toBe(
      GROQ_STRONG_MODEL,
    );
  });
});

describe("semanticCache", () => {
  it("round-trips and expires by TTL", () => {
    const key = semanticCacheKey("ws", DEFAULT_GROQ_MODEL, "Hello?");
    expect(getCachedReply(key, 1000)).toBeNull();
    setCachedReply(key, "hi", 1000);
    expect(getCachedReply(key, 1000)).toBe("hi");
    expect(getCachedReply(key, 1000 + 5 * 60_000 + 1)).toBeNull();
  });

  it("normalizes case/whitespace into one key", () => {
    expect(semanticCacheKey("ws", DEFAULT_GROQ_MODEL, "  What IS sd? ")).toBe(
      semanticCacheKey("ws", DEFAULT_GROQ_MODEL, "what is sd?"),
    );
  });
});

describe("assembleToolCalls", () => {
  it("assembles split chunks; malformed args degrade to {}", () => {
    const calls = assembleToolCalls([
      { index: 0, id: "c1", function: { name: "search_kno" } },
      {
        index: 0,
        function: { name: "wledge", arguments: '{"query": "sd"}' },
      },
      { index: 1, id: "c2", function: { name: "nope", arguments: "%%%" } },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      id: "c1",
      name: "search_knowledge",
      args: { query: "sd" },
    });
    expect(calls[1].args).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Brain wiring: routing, cache, tools, metrics, LLM expansion
// ---------------------------------------------------------------------------

describe("brain phase-3 wiring", () => {
  it("routes long queries to the strong model in the request body", async () => {
    const { full } = await runBrain("y".repeat(301), () => sseBody(["ok"]));
    expect(full).toContain("ok");
    const body = fetchCalls[0] as { model: string };
    expect(body.model).toBe(GROQ_STRONG_MODEL);
  });

  it("sends no tools by default", async () => {
    await runBrain("plain question about means", () => sseBody(["ok"]));
    expect(fetchCalls[0]).not.toHaveProperty("tools");
  });

  it("serves stable repeats from semantic cache (one fetch)", async () => {
    const q = "cacheable means question";
    const first = await runBrain(q, () => sseBody(["cached answer"]));
    expect(first.full).toContain("cached answer");
    const second = await runBrain(q, () => sseBody(["must not appear"]));
    expect(second.full).toContain("cached answer");
    expect(fetchCalls).toHaveLength(1);
    expect(second.events.some((e) => e.type === "cache_hit")).toBe(true);
  });

  it("runs the tool loop: tool call → execute → final answer", async () => {
    let n = 0;
    const { full, events } = await runBrain(
      "tool loop question",
      () => {
        n++;
        return n === 1
          ? sseToolCall("call_1", "search_knowledge", { query: "sd" })
          : sseBody(["final answer"]);
      },
      { tools: true },
    );
    expect(full).toContain("final answer");
    expect(n).toBe(2);
    const followUp = fetchCalls[1] as { messages: Array<{ role: string }> };
    expect(followUp.messages.some((m) => m.role === "tool")).toBe(true);
    const done = events.find((e) => e.type === "llm_done");
    expect(done?.toolIters).toBe(1);
    expect(events.some((e) => e.type === "tools_done")).toBe(true);
  });

  it("emits rag_done + llm_done metrics on a plain run", async () => {
    const { events } = await runBrain("metric probe query", () =>
      sseBody(["ok"]),
    );
    const rag = events.find((e) => e.type === "rag_done");
    const llm = events.find((e) => e.type === "llm_done");
    expect(rag).toMatchObject({ ragHits: expect.any(Number) });
    expect(llm?.model).toBe(DEFAULT_GROQ_MODEL);
    expect(llm?.toolIters).toBe(0);
    expect(llm?.estInputTokens).toBeGreaterThan(0);
  });

  it("llmExpansion adds a rewrite call before chat", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    await runBrain(
      "expansion probe query",
      (body) => {
        bodies.push(body);
        return body.stream === false
          ? jsonBody("sd, standard deviation")
          : sseBody(["ok"]);
      },
      { llmExpansion: true },
    );
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).not.toHaveProperty("tools");
    expect((bodies[0] as { stream: boolean }).stream).toBe(false);
  });
});
