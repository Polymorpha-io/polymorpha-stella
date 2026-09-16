/**
 * In-memory semantic answer cache: normalized exact-match LRU with TTL.
 * Repeat questions with stable context skip RAG + LLM entirely (the
 * 30–50% repeat-query win from the literature, scoped safely: only when
 * the caller carries no dynamic context — no active cell, no dataset
 * expert, no dataset ids).
 */
import type { StellaChatModel } from "./types";
import {
  STELLA_SEMANTIC_CACHE_MAX,
  STELLA_SEMANTIC_CACHE_TTL_MS,
} from "../config/retrieval";

interface CacheEntry {
  text: string;
  at: number;
  /** Query embedding for similarity hits (plain array, serializable). */
  vector?: number[];
}

const mem = new Map<string, CacheEntry>();

export function normalizeQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, " ").trim();
}

export function semanticCacheKey(
  workspaceId: string,
  model: StellaChatModel,
  query: string,
): string {
  return `${workspaceId}::${model}::${normalizeQuery(query)}`;
}

function live(entry: CacheEntry, now: number): boolean {
  return now - entry.at <= STELLA_SEMANTIC_CACHE_TTL_MS;
}

export function getCachedReply(key: string, now = Date.now()): string | null {
  const hit = mem.get(key);
  if (!hit) return null;
  if (!live(hit, now)) {
    mem.delete(key);
    return null;
  }
  return hit.text;
}

export function setCachedReply(
  key: string,
  text: string,
  now = Date.now(),
  vector?: number[],
): void {
  if (mem.size >= STELLA_SEMANTIC_CACHE_MAX && !mem.has(key)) {
    const oldest = mem.keys().next();
    if (!oldest.done) mem.delete(oldest.value);
  }
  mem.set(key, { text, at: now, vector });
}

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Best live entry whose query vector scores ≥ threshold (exact key
 * matches are handled by getCachedReply — this is the paraphrase path).
 */
export function findSimilarReply(
  vector: number[],
  threshold: number,
  now = Date.now(),
): string | null {
  let best: string | null = null;
  let bestScore = threshold;
  for (const entry of mem.values()) {
    if (!entry.vector || !live(entry, now)) continue;
    const score = cosine(vector, entry.vector);
    if (score >= bestScore) {
      bestScore = score;
      best = entry.text;
    }
  }
  return best;
}

export function clearSemanticCache(): void {
  mem.clear();
}
