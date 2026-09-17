/**
 * Stella Phase 4 — runtime embedding config
 * (`plans/2026-09-13/stella-phase4-embed-config.md`).
 *
 * No model downloads: exercises configure/validate/getters, chunk-budget
 * behavior (pure char-window path), and cache-key namespacing only.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  chunkText,
  configureEmbeddings,
  getEmbeddingDims,
  getEmbeddingModelId,
  mapWithConcurrency,
  resetEmbeddingsToDefault,
  MODEL_CONTEXT_TOKENS,
} from "@/stella/models/embeddingModel";
import { buildEmbeddingKey } from "@/embeddings/EmbeddingCache";

const MINILM = "Xenova/all-MiniLM-L6-v2";
const BGE_SMALL = "Xenova/bge-small-en-v1.5";

afterEach(() => {
  resetEmbeddingsToDefault();
});

describe("embedding runtime config", () => {
  it("defaults to MiniLM 384d/512", () => {
    expect(getEmbeddingModelId()).toBe(MINILM);
    expect(getEmbeddingDims()).toBe(384);
  });

  it("switches model + dim and restores defaults", () => {
    const applied = configureEmbeddings({
      model: BGE_SMALL,
      dim: 384,
    });
    expect(applied.model).toBe(BGE_SMALL);
    expect(getEmbeddingModelId()).toBe(BGE_SMALL);
    resetEmbeddingsToDefault();
    expect(getEmbeddingModelId()).toBe(MINILM);
  });

  it("clamps chunkTokens to model context for the 512 family", () => {
    const applied = configureEmbeddings({ chunkTokens: 2048 });
    expect(applied.chunkTokens).toBe(MODEL_CONTEXT_TOKENS);
  });

  it("accepts smaller chunk budgets verbatim", () => {
    const applied = configureEmbeddings({ chunkTokens: 128 });
    expect(applied.chunkTokens).toBe(128);
  });

  it("chunkText follows the active budget", () => {
    const long = "x".repeat(64 * 4 + 10);
    expect(chunkText(long)).toHaveLength(1);
    configureEmbeddings({ chunkTokens: 64 });
    expect(chunkText(long).length).toBeGreaterThan(1);
  });

  it("cache keys namespace the active model", async () => {
    const before = await buildEmbeddingKey("same text");
    configureEmbeddings({ model: BGE_SMALL });
    const after = await buildEmbeddingKey("same text");
    expect(before).not.toBe(after);
    expect(after.startsWith(`${BGE_SMALL}:`)).toBe(true);
    expect(before.startsWith(`${MINILM}:`)).toBe(true);
  });
});

describe("mapWithConcurrency", () => {
  it("preserves input order across batches", async () => {
    const texts = Array.from({ length: 10 }, (_, i) => `text ${i}`);
    const out = await mapWithConcurrency(texts, async (t) => `done:${t}`, 4);
    expect(out).toEqual(texts.map((t) => `done:${t}`));
  });

  it("caps concurrency and passes indices", async () => {
    let active = 0;
    let maxActive = 0;
    const seenIdx: number[] = [];
    const texts = Array.from({ length: 10 }, (_, i) => i);
    await mapWithConcurrency(
      texts,
      async (n, i) => {
        seenIdx.push(i);
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return n * 2;
      },
      4,
    );
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(maxActive).toBeGreaterThan(1);
    expect(seenIdx).toEqual(texts);
  });

  it("floors degenerate caps at 1 and rejects on item failure", async () => {
    const out = await mapWithConcurrency([1, 2], async (n) => n + 1, 0);
    expect(out).toEqual([2, 3]);
    await expect(
      mapWithConcurrency([1, 2, 3], async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });
});
