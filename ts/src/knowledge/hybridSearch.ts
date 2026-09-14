/**
 * Hybrid retrieval math — BM25 keyword scoring + Reciprocal Rank Fusion.
 * Pure functions, zero dependencies: dense (MiniLM cosine) captures
 * paraphrase, BM25 captures exact identifiers (column names, codes, terms)
 * that embeddings blur. RRF fuses rank lists without score normalization
 * (BM25 and cosine live on incomparable scales). Single tokenizer shared
 * with the dictionary prefilter (D18).
 */
import {
  HYBRID_BM25_B,
  HYBRID_BM25_K1,
  HYBRID_RRF_K,
} from "../config/retrieval";

/** Lowercase alphanumeric token stream (`+`, `#`, `-` kept: c++, c#, t-test). */
export function tokenizeText(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+#-]+/)
    .filter((t) => t.length > 1);
}

function termFrequencies(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

/**
 * BM25 scores for `query` against each document text. Standard formulation
 * with IDF floor (no negative idf on ubiquitous terms).
 */
export function bm25Scores(
  query: string,
  docs: string[],
  k1: number = HYBRID_BM25_K1,
  b: number = HYBRID_BM25_B,
): number[] {
  const qtf = termFrequencies(tokenizeText(query));
  if (qtf.size === 0 || docs.length === 0) return docs.map(() => 0);
  const docTfs = docs.map((d) => termFrequencies(tokenizeText(d)));
  const avgLen =
    docTfs.reduce((sum, tf) => {
      let len = 0;
      for (const c of tf.values()) len += c;
      return sum + len;
    }, 0) / Math.max(1, docTfs.length);
  const n = docs.length;
  return docTfs.map((tf) => {
    let docLen = 0;
    for (const c of tf.values()) docLen += c;
    let score = 0;
    for (const [term, qf] of qtf) {
      const f = tf.get(term) ?? 0;
      if (f === 0) continue;
      let df = 0;
      for (const other of docTfs) if (other.has(term)) df++;
      const idf = Math.max(0, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
      const norm = f * (k1 + 1);
      const denom = f + k1 * (1 - b + (b * docLen) / Math.max(1, avgLen));
      score += qf * idf * (norm / denom);
    }
    return score;
  });
}

/** Indices of `scores` sorted best-first (stable — ties keep input order). */
export function rankIndices(scores: number[]): number[] {
  return scores
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s - a.s)
    .map((e) => e.i);
}

/**
 * Reciprocal Rank Fusion over rank lists: `sum(1 / (k + rank))` per doc
 * index. Scale-free — the standard combiner for dense + lexical paths.
 */
export function rrfFuse(
  rankLists: number[][],
  size: number,
  k: number = HYBRID_RRF_K,
): number[] {
  const fused = new Array<number>(size).fill(0);
  for (const ranks of rankLists) {
    for (let rank = 0; rank < ranks.length; rank++) {
      fused[ranks[rank]] += 1 / (k + rank + 1);
    }
  }
  return fused;
}
