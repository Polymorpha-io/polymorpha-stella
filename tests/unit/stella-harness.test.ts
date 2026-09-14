/**
 * Stella harness Phase 1 — budgets, abort/retry, dict prefilter, cache
 * read-through (`plans/2026-09-13/stella-harness-tokens-rag.md`).
 *
 * Mocks: EmbeddingService → deterministic single-spike 384-d (no WASM);
 * EmbeddingCache → in-memory map (real `buildEmbeddingKey`);
 * dataset/relationship providers → [] (isolates dict+cache behavior);
 * KnowledgeStore/NotebookRepository → memory (mirrors notebook pipeline test);
 * fetch → per-test scripted SSE.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  DICTIONARY_QUERY_TOP,
  STELLA_HISTORY_LIMIT,
  STELLA_MAX_TOKENS,
} from "@/config/retrieval";
import { knowledgeService } from "@/knowledge/KnowledgeService";
import { knowledgeStore } from "@/knowledge/KnowledgeStore";
import { notebookRepository } from "@/notebook/NotebookRepository";
import { BrainService } from "@/stella/brain/BrainService";
import { selectHistoryWindow } from "@/stella/brain/BrainService";
import { StellaService } from "@/stella/StellaService";
import type { IStellaMessage } from "@/stella/types";

// ---------------------------------------------------------------------------
// Hoisted counters + memory backing (vi.mock factories are hoisted)
// ---------------------------------------------------------------------------

const embedCalls = vi.hoisted(() => ({ embedMany: 0, texts: [] as string[] }));
const memCache = vi.hoisted(() => new Map<string, unknown>());
const memKnowledge = vi.hoisted(() => new Map<string, unknown>());

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
        embedCalls.texts.push(...ts);
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

vi.spyOn(knowledgeStore, "put").mockImplementation(async () => {});
vi.spyOn(knowledgeStore, "putMany").mockImplementation(async () => {});
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
// Helpers
// ---------------------------------------------------------------------------

function sseOk(text: string, status = 200): Response {
  const encoder = new TextEncoder();
  const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(encoder.encode(sse));
      c.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

function scriptFetch(
  impl: (url: string, opts: { body?: string; signal?: AbortSignal }) => unknown,
): void {
  global.fetch = vi.fn(impl) as unknown as typeof fetch;
}

function captureBody(): {
  body: {
    messages: Array<{ role: string; content: string }>;
    max_tokens?: number;
  };
} {
  const calls = (global.fetch as unknown as { mock: { calls: unknown[][] } })
    .mock.calls;
  const last = calls[calls.length - 1][1] as { body: string };
  return { body: JSON.parse(last.body) };
}

function makeHistory(n: number): IStellaMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `history message ${i}`,
  }));
}

function runBrain(
  svc: BrainService,
  messages: IStellaMessage[],
  content: string,
  opts?: { signal?: AbortSignal; maxTokens?: number; historyLimit?: number },
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    void svc.answerStreaming(
      messages,
      content,
      "ws-harness",
      undefined,
      () => {},
      (full) => resolve(full),
      (err) => reject(err),
      {},
      opts,
    );
  });
}

beforeEach(() => {
  memCache.clear();
  memKnowledge.clear();
  embedCalls.embedMany = 0;
  embedCalls.texts = [];
  scriptFetch(() => sseOk("ok"));
});

// ---------------------------------------------------------------------------
// BrainService harness budgets
// ---------------------------------------------------------------------------

describe("BrainService harness budgets", () => {
  it("caps history at STELLA_HISTORY_LIMIT and sends max_tokens", async () => {
    const svc = new BrainService();
    await svc.init("ws-harness");
    const full = await runBrain(svc, makeHistory(30), "summarize please");
    expect(full).toContain("ok");
    const { body } = captureBody();
    // 1 system + anchor(first) + tail(19) + 1 current user
    expect(body.messages).toHaveLength(1 + STELLA_HISTORY_LIMIT + 1);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].content).toBe("history message 0");
    expect(body.messages[2].content).toBe("history message 11");
    expect(body.messages[body.messages.length - 1].content).toBe(
      "summarize please",
    );
    expect(body.max_tokens).toBe(STELLA_MAX_TOKENS);
  });

  it("honors maxTokens/historyLimit overrides", async () => {
    const svc = new BrainService();
    await svc.init("ws-harness");
    await runBrain(svc, makeHistory(10), "hi", {
      maxTokens: 50,
      historyLimit: 2,
    });
    const { body } = captureBody();
    expect(body.max_tokens).toBe(50);
    expect(body.messages).toHaveLength(1 + 2 + 1);
  });

  it("retries once on network error then succeeds", async () => {
    let calls = 0;
    scriptFetch(() => {
      calls++;
      if (calls === 1) throw new TypeError("fetch failed");
      return sseOk("recovered");
    });
    const svc = new BrainService();
    await svc.init("ws-harness");
    const full = await runBrain(svc, [], "hello retry");
    expect(full).toContain("recovered");
    expect(calls).toBe(2);
  });

  it("does not retry on abort and surfaces cancellation", async () => {
    let calls = 0;
    scriptFetch((_url, opts) => {
      calls++;
      if (opts?.signal?.aborted)
        throw new DOMException("aborted", "AbortError");
      return sseOk("ok");
    });
    const ac = new AbortController();
    ac.abort();
    const svc = new BrainService();
    await svc.init("ws-harness");
    await expect(
      runBrain(svc, [], "hello abort", { signal: ac.signal }),
    ).rejects.toThrow("Stella request cancelled");
    expect(calls).toBe(1);
  });

  it("StellaService threads request options to the harness", async () => {
    const service = new StellaService();
    service.setContext("ws-harness");
    const done = vi.fn();
    await service.sendMessage(
      makeHistory(30),
      "via service",
      "openai/gpt-oss-20b",
      {
        onToken: () => {},
        onDone: done,
        onError: (e) => {
          throw e;
        },
      },
      { historyLimit: 1, maxTokens: 11 },
    );
    expect(done).toHaveBeenCalledOnce();
    const { body } = captureBody();
    expect(body.messages).toHaveLength(1 + 1 + 1);
    expect(body.max_tokens).toBe(11);
  });
});

// ---------------------------------------------------------------------------
// KnowledgeService dict prefilter + cache read-through
// ---------------------------------------------------------------------------

describe("KnowledgeService dict prefilter + cache", () => {
  it("keeps query-relevant dictionary terms within DICTIONARY_QUERY_TOP", async () => {
    // Zero-overlap query → survivors preserve curated order (stable sort).
    const gibberish = await knowledgeService.search("zzzqqq nonexistent", {
      workspaceId: "ws-dict",
      includeSystemKnowledge: true,
      limit: DICTIONARY_QUERY_TOP,
    });
    const first = gibberish[0];
    expect(first.record.id.startsWith("dict::")).toBe(true);
    // Full text of the first survivor as query → it outranks everything
    // (max token hits; ties break by earliest curated index, which it is).
    const res = await knowledgeService.search(first.record.text, {
      workspaceId: "ws-dict",
      includeSystemKnowledge: true,
      limit: DICTIONARY_QUERY_TOP,
    });
    const dictHits = res.filter((r) => r.record.id.startsWith("dict::"));
    expect(dictHits.length).toBeLessThanOrEqual(DICTIONARY_QUERY_TOP);
    expect(res[0].record.id).toBe(first.record.id);
  });

  it("embeds at most 1 + DICTIONARY_QUERY_TOP texts per query", async () => {
    await knowledgeService.search("What is overfitting in models?", {
      workspaceId: "ws-dict",
      includeSystemKnowledge: true,
    });
    expect(embedCalls.texts.length).toBeLessThanOrEqual(
      1 + DICTIONARY_QUERY_TOP,
    );
    expect(embedCalls.texts.length).toBeGreaterThan(1);
  });

  it("repeat query hits the cache — no model re-embed", async () => {
    const opts = {
      workspaceId: "ws-dict",
      includeSystemKnowledge: true as const,
    };
    await knowledgeService.search("What is overfitting in models?", opts);
    const firstCalls = embedCalls.embedMany;
    expect(firstCalls).toBeGreaterThan(0);
    await knowledgeService.search("What is overfitting in models?", opts);
    expect(embedCalls.embedMany).toBe(firstCalls);
  });

  it("buildEmbeddingKey is stable per text and distinct across texts", async () => {
    const { buildEmbeddingKey } = await import("@/embeddings/EmbeddingCache");
    const a1 = await buildEmbeddingKey("hello stella");
    const a2 = await buildEmbeddingKey("hello stella");
    const b = await buildEmbeddingKey("goodbye stella");
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1.length).toBeGreaterThan(0);
  });
});

describe("selectHistoryWindow", () => {
  const msgs = (n: number) => Array.from({ length: n }, (_, i) => `m${i}`);

  it("passes short histories through untouched", () => {
    expect(selectHistoryWindow(msgs(5), 20)).toEqual(msgs(5));
    expect(selectHistoryWindow(msgs(20), 20)).toEqual(msgs(20));
  });

  it("keeps the anchor plus the tail over budget", () => {
    expect(selectHistoryWindow(msgs(30), 20)).toEqual([
      "m0",
      ...msgs(30).slice(-19),
    ]);
  });

  it("honors headKeep and treats limit 0 as none", () => {
    expect(selectHistoryWindow(msgs(10), 4, 2)).toEqual([
      "m0",
      "m1",
      "m8",
      "m9",
    ]);
    expect(selectHistoryWindow(msgs(10), 0)).toEqual([]);
    expect(selectHistoryWindow(msgs(10), -1)).toEqual(msgs(10));
  });

  it("never duplicates when the head fills the window", () => {
    expect(selectHistoryWindow(msgs(10), 1)).toEqual(["m0"]);
    expect(selectHistoryWindow(msgs(10), 2, 5)).toEqual(["m0", "m1"]);
  });
});
