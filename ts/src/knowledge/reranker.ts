/**
 * Second-stage rerank + MMR diversity over first-stage candidates.
 * `Reranker` is the seam for future managed APIs (Cohere/Voyage) — swap via
 * `setReranker`, no call-site change. Default `FeatureReranker` is a
 * zero-dependency lexical relevance scorer (coverage + exact phrase +
 * proximity): strictly stronger than bi-encoder cosine on exact-term
 * queries, deterministic, unit-tested.
 */
import type { KnowledgeResult } from "./types";
import { cosineSimilarity } from "../embeddings/EmbeddingService";
import { tokenizeText } from "./hybridSearch";
import { RERANK_MMR_LAMBDA } from "../config/retrieval";

export interface Reranker {
  readonly name: string;
  rerank(
    query: string,
    candidates: KnowledgeResult[],
  ): KnowledgeResult[] | Promise<KnowledgeResult[]>;
}

/** Lexical relevance features — deterministic, no model calls. */
export function featureScore(query: string, text: string): number {
  const q = tokenizeText(query);
  if (q.length === 0) return 0;
  const doc = tokenizeText(text);
  if (doc.length === 0) return 0;
  const docSet = new Set(doc);
  let covered = 0;
  for (const t of q) if (docSet.has(t)) covered++;
  const coverage = covered / q.length;
  // Exact-phrase bonus on the raw strings (codes, names, terms).
  const phrase =
    query.trim().length > 3 &&
    text.toLowerCase().includes(query.trim().toLowerCase())
      ? 1.5
      : 0;
  // Proximity: all covered tokens inside a 10-token window.
  let proximity = 0;
  if (covered === q.length && q.length > 1) {
    const positions = q.map((t) => doc.indexOf(t));
    if (positions.every((p) => p >= 0)) {
      const span = Math.max(...positions) - Math.min(...positions);
      if (span <= 10) proximity = 0.5;
    }
  }
  return 2 * coverage + phrase + proximity;
}

export class FeatureReranker implements Reranker {
  readonly name = "feature-lexical-v1";
  rerank(query: string, candidates: KnowledgeResult[]): KnowledgeResult[] {
    return candidates
      .map((r) => ({
        r,
        feat: featureScore(query, r.record.text),
      }))
      .sort((a, b) => b.feat - a.feat || b.r.score - a.r.score)
      .map(({ r, feat }) => ({ ...r, score: r.score + feat }));
  }
}

let activeReranker: Reranker = new FeatureReranker();

export function setReranker(reranker: Reranker): void {
  activeReranker = reranker;
}

export function getReranker(): Reranker {
  return activeReranker;
}

export async function rerankCandidates(
  query: string,
  candidates: KnowledgeResult[],
): Promise<KnowledgeResult[]> {
  return activeReranker.rerank(query, candidates);
}

/**
 * Maximal Marginal Relevance: greedily pick `topN` maximizing
 * `lambda * relevance - (1 - lambda) * maxSimToSelected`. Kills
 * near-duplicate records (e.g. 12 column_semantics from one dataset).
 */
export function mmrSelect(
  candidates: KnowledgeResult[],
  topN: number,
  lambda: number = RERANK_MMR_LAMBDA,
): KnowledgeResult[] {
  if (candidates.length <= topN) return [...candidates];
  const selected: KnowledgeResult[] = [];
  const remaining = [...candidates];
  const sim = (a: KnowledgeResult, b: KnowledgeResult): number => {
    if (!a.vector || !b.vector) return 0;
    const s = cosineSimilarity(a.vector, b.vector);
    return Number.isFinite(s) ? Math.max(0, s) : 0;
  };
  while (remaining.length > 0 && selected.length < topN) {
    let best = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      let maxSim = 0;
      for (const s of selected) maxSim = Math.max(maxSim, sim(remaining[i], s));
      const val = lambda * remaining[i].score - (1 - lambda) * maxSim;
      if (val > bestVal) {
        bestVal = val;
        best = i;
      }
    }
    selected.push(remaining.splice(best, 1)[0]);
  }
  return selected;
}
