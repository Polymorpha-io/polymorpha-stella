/**
 * In-memory semantic answer cache: normalized exact-match LRU with TTL.
 * Repeat questions with stable context skip RAG + LLM entirely (the
 * 30–50% repeat-query win from the literature, scoped safely: only when
 * the caller carries no dynamic context — no active cell, no dataset
 * expert, no dataset ids).
 */
import type { GroqModel } from "./types";
import {
  STELLA_SEMANTIC_CACHE_MAX,
  STELLA_SEMANTIC_CACHE_TTL_MS,
} from "../config/retrieval";

interface CacheEntry {
  text: string;
  at: number;
}

const mem = new Map<string, CacheEntry>();

export function normalizeQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, " ").trim();
}

export function semanticCacheKey(
  workspaceId: string,
  model: GroqModel,
  query: string,
): string {
  return `${workspaceId}::${model}::${normalizeQuery(query)}`;
}

export function getCachedReply(key: string, now = Date.now()): string | null {
  const hit = mem.get(key);
  if (!hit) return null;
  if (now - hit.at > STELLA_SEMANTIC_CACHE_TTL_MS) {
    mem.delete(key);
    return null;
  }
  return hit.text;
}

export function setCachedReply(
  key: string,
  text: string,
  now = Date.now(),
): void {
  if (mem.size >= STELLA_SEMANTIC_CACHE_MAX && !mem.has(key)) {
    const oldest = mem.keys().next();
    if (!oldest.done) mem.delete(oldest.value);
  }
  mem.set(key, { text, at: now });
}

export function clearSemanticCache(): void {
  mem.clear();
}
