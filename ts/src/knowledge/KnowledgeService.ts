import type {
  KnowledgeRecord,
  KnowledgeSearchOptions,
  KnowledgeSearchRequest,
  KnowledgeResult,
} from "./types";
import { knowledgeStore } from "./KnowledgeStore";
import {
  embeddingService,
  cosineSimilarity,
} from "../embeddings/EmbeddingService";
import {
  embeddingCache,
  buildEmbeddingKey,
} from "../embeddings/EmbeddingCache";
import { bm25Scores, rankIndices, rrfFuse, tokenizeText } from "./hybridSearch";
import type { EmbeddingEntry } from "../embeddings/types";
import { EMBED_MODEL } from "../config";
import { EMBED_CACHE_VERSION } from "../config/retrieval";
import { knowledgeExtractor } from "./KnowledgeExtractor";
import type { Notebook } from "../notebook/types";
import { notebookRepository } from "../notebook/NotebookRepository";
import { DatasetKnowledgeProvider } from "./providers/DatasetKnowledgeProvider";
import { RelationshipKnowledgeProvider } from "./providers/RelationshipKnowledgeProvider";
import { DICTIONARY_TERMS } from "@polymorpha/business-logic";
import {
  DICTIONARY_QUERY_TOP,
  DICTIONARY_TERMS_LIMIT,
  HYBRID_ENABLED,
  QUERY_EXPANSION_ENABLED,
  RERANK_CANDIDATES,
  RERANK_ENABLED,
  RETRIEVAL_LIMIT_DATA,
  RETRIEVAL_LIMIT_DEFAULT,
  SCORE_BOOSTS,
  SCORE_FALLBACK,
} from "../config/retrieval";
import { mmrSelect, rerankCandidates } from "./reranker";
import { expandQueryTerms, mergeTermBags } from "./queryExpansion";

export interface KnowledgeProvider {
  provide(
    workspaceId: string,
    notebook?: Notebook | null,
  ): Promise<KnowledgeRecord[]>;
}

/**
 * Keyword prefilter over dictionary terms (no embeddings spent).
 * Scores by query-token overlap against term+definition+category; stable
 * sort preserves the curated order on ties/zero overlap, so a query with
 * no lexical match degrades to the previous first-N bias — never a cliff.
 */
function rankDictionaryTerms(
  query: string,
  terms: typeof DICTIONARY_TERMS,
): typeof DICTIONARY_TERMS {
  const tokens = tokenizeText(query);
  if (tokens.length === 0) return [...terms];
  const scored = terms.map((t) => {
    const hay =
      `${t.term} ${t.definition} ${t.quickTake ?? ""} ${t.category}`.toLowerCase();
    let hits = 0;
    for (const tok of tokens) if (hay.includes(tok)) hits++;
    return { t, hits };
  });
  scored.sort((a, b) => b.hits - a.hits);
  return scored.map((s) => s.t);
}

class DictionaryKnowledgeProvider implements KnowledgeProvider {
  async provide(query = ""): Promise<KnowledgeRecord[]> {
    const terms = DICTIONARY_TERMS.slice(0, DICTIONARY_TERMS_LIMIT);
    const ranked = rankDictionaryTerms(query, terms).slice(
      0,
      DICTIONARY_QUERY_TOP,
    );
    return ranked.map((t) => ({
      id: `dict::${t.id}`,
      workspaceId: "system",
      notebookId: "system",
      kind: "note" as const,
      text: `${t.term}: ${t.definition} ${t.quickTake ?? ""}`.trim(),
      metadata: { source: "dictionary", category: t.category, term: t.term },
      provenance: { workspaceId: "system", notebookId: "system" },
      sourceHash: `dict:${t.id}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));
  }
}

function normalizeSearchOpts(
  query: string,
  opts: KnowledgeSearchOptions | KnowledgeSearchRequest,
): {
  workspaceId: string;
  notebookId?: string;
  datasetIds: string[];
  activeCellId?: string;
  kinds?: KnowledgeRecord["kind"][];
  column?: string;
  scope: "workspace" | "all";
  includeSystemKnowledge: boolean;
  includeSuperseded: boolean;
  limit: number;
  query: string;
  extraTerms: string;
} {
  const anyOpts = opts as unknown as Record<string, unknown>;
  const workspaceId = (anyOpts.workspaceId as string) ?? "";
  const notebookId = (anyOpts.notebookId as string | undefined) ?? undefined;
  const datasetIds =
    (anyOpts.datasetIds as string[] | undefined) ??
    ((anyOpts.datasetId as string | undefined)
      ? [anyOpts.datasetId as string]
      : []);
  const activeCellId =
    (anyOpts.activeCellId as string | undefined) ??
    (anyOpts.cellId as string | undefined) ??
    undefined;
  const kinds = anyOpts.kinds as KnowledgeRecord["kind"][] | undefined;
  const column = anyOpts.column as string | undefined;
  const scope =
    (anyOpts.scope as "workspace" | "all" | undefined) ?? "workspace";
  const includeSystemKnowledge =
    (anyOpts.includeSystemKnowledge as boolean | undefined) ?? true;
  const historyIntent =
    /originally|previously|history|before|earlier|superseded/i.test(query);
  const includeSuperseded =
    (anyOpts.includeSuperseded as boolean | undefined) ?? historyIntent;
  const limit =
    (anyOpts.limit as number | undefined) ??
    (kinds?.includes("data_representative")
      ? RETRIEVAL_LIMIT_DATA
      : RETRIEVAL_LIMIT_DEFAULT);
  const extraTerms = (anyOpts.extraTerms as string | undefined) ?? "";
  return {
    workspaceId,
    notebookId,
    datasetIds,
    activeCellId,
    kinds,
    column,
    scope,
    includeSystemKnowledge,
    includeSuperseded,
    limit,
    query,
    extraTerms,
  };
}

export class KnowledgeService {
  private dictProvider = new DictionaryKnowledgeProvider();
  private datasetProvider = new DatasetKnowledgeProvider();
  private relationshipProvider = new RelationshipKnowledgeProvider();

  async index(record: KnowledgeRecord): Promise<void> {
    await knowledgeStore.put(record);
  }

  async indexMany(records: KnowledgeRecord[]): Promise<void> {
    await knowledgeStore.putMany(records);
  }

  async remove(id: string): Promise<void> {
    await knowledgeStore.remove(id);
  }

  async removeByCell(cellId: string): Promise<void> {
    await knowledgeStore.removeByCell(cellId);
  }

  async indexNotebook(notebook: Notebook): Promise<void> {
    const records = await knowledgeExtractor.extractNotebook(notebook);
    await knowledgeStore.putMany(records);
    const texts = records.map((r) => r.text);
    if (texts.length) {
      try {
        // Pre-warm both the model and the cache so later searches hit.
        const { vectors } = await embeddingService.embedMany(texts);
        this.cacheVectors(texts, vectors);
      } catch {
        /* non-critical */
      }
    }
  }

  async search(
    query: string,
    opts: KnowledgeSearchOptions | KnowledgeSearchRequest,
  ): Promise<KnowledgeResult[]> {
    const n = normalizeSearchOpts(query, opts);
    const workspaceId = n.workspaceId;

    let candidates: KnowledgeRecord[] = [];
    if (n.scope === "all") {
      candidates = await knowledgeStore.getAll().catch(() => []);
    } else if (n.activeCellId) {
      candidates = await knowledgeStore
        .getByCell(n.activeCellId)
        .catch(() => []);
      if (candidates.length < n.limit) {
        const wsRecs = await knowledgeStore
          .getByWorkspace(workspaceId)
          .catch(() => [] as KnowledgeRecord[]);
        const seen = new Set(candidates.map((c) => c.id));
        for (const r of wsRecs) if (!seen.has(r.id)) candidates.push(r);
      }
    } else if (n.notebookId) {
      candidates = await knowledgeStore
        .getByNotebook(n.notebookId)
        .catch(() => []);
    } else if (workspaceId) {
      candidates = await knowledgeStore
        .getByWorkspace(workspaceId)
        .catch(() => []);
      try {
        const nb = await notebookRepository
          .getByWorkspace(workspaceId)
          .catch(() => null);
        if (nb) {
          const nbRecs = await knowledgeStore
            .getByNotebook(nb.id)
            .catch(() => [] as KnowledgeRecord[]);
          const seen = new Set(candidates.map((c) => c.id));
          for (const r of nbRecs) if (!seen.has(r.id)) candidates.push(r);
        }
      } catch {}
    }

    if (workspaceId) {
      try {
        const [dsRecs, relRecs] = await Promise.all([
          this.datasetProvider
            .provide(workspaceId)
            .catch(() => [] as KnowledgeRecord[]),
          this.relationshipProvider
            .provide(workspaceId)
            .catch(() => [] as KnowledgeRecord[]),
        ]);
        const seen = new Set(candidates.map((c) => c.id));
        for (const r of [...dsRecs, ...relRecs])
          if (!seen.has(r.id)) candidates.push(r);
      } catch {}
    }

    if (n.includeSystemKnowledge) {
      const dict = await this.dictProvider.provide(query).catch(() => []);
      candidates.push(...dict);
    }

    if (n.kinds && n.kinds.length) {
      candidates = candidates.filter((c) => n.kinds!.includes(c.kind));
    }

    if (n.datasetIds.length > 0) {
      candidates = candidates.filter((c) => {
        const provIds =
          c.provenance.datasetIds ?? (c.datasetId ? [c.datasetId] : undefined);
        if (!provIds || provIds.length === 0) return false;
        return provIds.some((id) => n.datasetIds.includes(id));
      });
    }

    if (n.column) {
      candidates = candidates.filter((c) => {
        const cols =
          c.provenance.columns ??
          ((c.metadata as Record<string, unknown>)?.columns as
            string[] | undefined) ??
          ((c.metadata as Record<string, unknown>)?.column
            ? [(c.metadata as Record<string, unknown>).column as string]
            : undefined);
        if (!cols) return false;
        return cols.includes(n.column!);
      });
    }

    if (!n.includeSuperseded) {
      candidates = candidates.filter(
        (c) => (c.metadata as { status?: string }).status !== "superseded",
      );
    }

    if (candidates.length === 0) return [];
    if (!query || query.trim().length === 0) {
      return candidates
        .slice(0, n.limit)
        .map((r) => ({ record: r, score: SCORE_FALLBACK }));
    }

    let cellIndexMap = new Map<string, number>();
    let activeIndex: number | null = null;
    if (n.activeCellId) {
      try {
        const nb = n.notebookId
          ? await notebookRepository.get(n.notebookId).catch(() => null)
          : workspaceId
            ? await notebookRepository
                .getByWorkspace(workspaceId)
                .catch(() => null)
            : null;
        if (nb) {
          for (const cell of nb.cells) cellIndexMap.set(cell.id, cell.index);
          activeIndex = cellIndexMap.get(n.activeCellId) ?? null;
        }
      } catch {}
    }

    let queryVec: Float32Array | null = null;
    try {
      [queryVec] = await this.embedTextsCached([query]);
    } catch {
      return candidates
        .slice(0, n.limit)
        .map((r) => ({ record: r, score: SCORE_FALLBACK }));
    }

    const texts = candidates.map((c) => c.text);
    let vectors: Float32Array[] = [];
    try {
      vectors = await this.embedTextsCached(texts);
    } catch {
      return candidates
        .slice(0, n.limit)
        .map((r) => ({ record: r, score: SCORE_FALLBACK }));
    }

    const denseScores = vectors.map((v) =>
      v ? cosineSimilarity(queryVec!, v) : 0,
    );
    // Hybrid fusion: dense rank + BM25 rank via RRF (scale-free — the two
    // live on incomparable scales). Hard-requirement boosts apply below.
    let fusedScores = denseScores;
    if (HYBRID_ENABLED) {
      // Expansion feeds the lexical path only (dense keeps raw intent).
      const ruleBag = QUERY_EXPANSION_ENABLED ? expandQueryTerms(query) : query;
      const lexicalQuery = n.extraTerms
        ? mergeTermBags(ruleBag, n.extraTerms)
        : ruleBag;
      const lexical = bm25Scores(lexicalQuery, texts);
      fusedScores = rrfFuse(
        [rankIndices(denseScores), rankIndices(lexical)],
        candidates.length,
      );
    }

    const scored: KnowledgeResult[] = candidates.map((rec, i) => {
      const v = vectors[i];
      let score = fusedScores[i];
      const status = (rec.metadata as { status?: string }).status;
      if (status === "active") score += SCORE_BOOSTS.statusActive;
      else if (status === "stale") score += SCORE_BOOSTS.statusStale;
      else if (status === "superseded") score += SCORE_BOOSTS.statusSuperseded;
      if (n.datasetIds.length > 0) {
        const provIds =
          rec.provenance.datasetIds ?? (rec.datasetId ? [rec.datasetId] : []);
        if (provIds.some((id) => n.datasetIds.includes(id)))
          score += SCORE_BOOSTS.datasetMatch;
      }
      if (n.activeCellId && rec.cellId === n.activeCellId)
        score += SCORE_BOOSTS.activeCell;
      if (n.activeCellId && rec.provenance.cellId === n.activeCellId)
        score += SCORE_BOOSTS.activeCell;
      if (n.column) {
        const cols =
          rec.provenance.columns ??
          ((rec.metadata as Record<string, unknown>)?.columns as
            string[] | undefined);
        if (cols?.includes(n.column)) score += SCORE_BOOSTS.columnMatch;
      }
      if (n.activeCellId && activeIndex != null && rec.cellId) {
        const candIdx = cellIndexMap.get(rec.cellId);
        if (candIdx != null) {
          const dist = Math.abs(candIdx - activeIndex);
          score += SCORE_BOOSTS.cellDistance * (1 / (1 + dist));
        }
      }
      if (n.activeCellId && activeIndex != null && rec.provenance.cellId) {
        const candIdx = cellIndexMap.get(rec.provenance.cellId);
        if (candIdx != null) {
          const dist = Math.abs(candIdx - activeIndex);
          score += SCORE_BOOSTS.provenanceDistance * (1 / (1 + dist));
        }
      }
      return { record: rec, score, vector: v };
    });

    scored.sort((a, b) => b.score - a.score);
    if (!RERANK_ENABLED) return scored.slice(0, n.limit);
    // Second stage: rerank the head for precision, MMR for diversity.
    const pool = scored.slice(
      0,
      Math.max(n.limit, Math.min(scored.length, RERANK_CANDIDATES)),
    );
    const reranked = await rerankCandidates(query, pool);
    return mmrSelect(reranked, n.limit).slice(0, n.limit);
  }

  /**
   * Embed with EmbeddingCache read-through: per-query cost drops from
   * 1+N model forwards to 1+misses. Hits also refresh LRU via rewrite.
   * Throws on model failure (callers fall back to SCORE_FALLBACK slice).
   */
  private async embedTextsCached(texts: string[]): Promise<Float32Array[]> {
    const keys = await Promise.all(texts.map((t) => buildEmbeddingKey(t)));
    const out = new Array<Float32Array | null>(texts.length).fill(null);
    const missIdx: number[] = [];
    await Promise.all(
      keys.map(async (k, i) => {
        const hit = await embeddingCache.get(k);
        if (hit) out[i] = hit.vector;
        else missIdx.push(i);
      }),
    );
    if (missIdx.length > 0) {
      const { vectors } = await embeddingService.embedMany(
        missIdx.map((i) => texts[i]),
      );
      missIdx.forEach((origI, m) => {
        out[origI] = vectors[m];
      });
      this.cacheVectors(
        missIdx.map((i) => texts[i]),
        vectors,
        missIdx.map((i) => keys[i]),
      );
    }
    return out as Float32Array[];
  }

  /** Fire-and-forget cache populate (best-effort — never throws). */
  private cacheVectors(
    texts: string[],
    vectors: Float32Array[],
    keys?: string[],
  ): void {
    void (async () => {
      try {
        const resolvedKeys =
          keys ?? (await Promise.all(texts.map((t) => buildEmbeddingKey(t))));
        const now = Date.now();
        const entries: EmbeddingEntry[] = texts.map((_, i) => ({
          embeddingKey: resolvedKeys[i],
          model: EMBED_MODEL,
          version: EMBED_CACHE_VERSION,
          dimension: vectors[i]?.length ?? 0,
          vector: vectors[i],
          createdAt: now,
          lastAccessedAt: now,
        }));
        await embeddingCache.setMany(entries);
      } catch {
        /* cache is best-effort */
      }
    })();
  }

  async getByCell(cellId: string): Promise<KnowledgeRecord[]> {
    return knowledgeStore.getByCell(cellId);
  }

  async getByDataset(datasetId: string): Promise<KnowledgeRecord[]> {
    try {
      const byIdx = await knowledgeStore.getByDatasetId(datasetId);
      if (byIdx.length > 0) return byIdx;
    } catch {}
    const all = await knowledgeStore.getAll();
    return all.filter((r) => {
      const ids = r.provenance.datasetIds ?? (r.datasetId ? [r.datasetId] : []);
      return ids.includes(datasetId);
    });
  }

  async getByWorkspace(workspaceId: string): Promise<KnowledgeRecord[]> {
    return knowledgeStore.getByWorkspace(workspaceId);
  }
}

export const knowledgeService = new KnowledgeService();
