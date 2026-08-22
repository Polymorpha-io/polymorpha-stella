import type {
  KnowledgeRecord,
  KnowledgeSearchOptions,
  KnowledgeSearchRequest,
  KnowledgeResult,
} from "./types";
import { knowledgeStore } from "./KnowledgeStore";
import { embeddingService } from "@/embeddings/EmbeddingService";
import { Embedder } from "@/stella/brain/Embedder";
import { knowledgeExtractor } from "./KnowledgeExtractor";
import type { Notebook } from "@/notebook/types";
import { notebookRepository } from "@/notebook/NotebookRepository";
import { DatasetKnowledgeProvider } from "./providers/DatasetKnowledgeProvider";
import { RelationshipKnowledgeProvider } from "./providers/RelationshipKnowledgeProvider";
import { DICTIONARY_TERMS } from "@polymorpha/business-logic";

export interface KnowledgeProvider {
  provide(
    workspaceId: string,
    notebook?: Notebook | null,
  ): Promise<KnowledgeRecord[]>;
}

class DictionaryKnowledgeProvider implements KnowledgeProvider {
  async provide(): Promise<KnowledgeRecord[]> {
    return DICTIONARY_TERMS.slice(0, 80).map((t) => ({
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

class LegacyKnowledgeProvider implements KnowledgeProvider {
  // Library: GitHub-only, no local fallback to "@/store/useRagStore" / "@/store/useDataStore".
  // Legacy path is deprecated — returns [] . Consumers should pre-index via KnowledgeService.index*().
  async provide(_workspaceId: string): Promise<KnowledgeRecord[]> {
    return [];
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
    (kinds?.includes("data_representative") ? 12 : 8);
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
  };
}

export class KnowledgeService {
  private dictProvider = new DictionaryKnowledgeProvider();
  private datasetProvider = new DatasetKnowledgeProvider();
  private relationshipProvider = new RelationshipKnowledgeProvider();
  private legacyProvider = new LegacyKnowledgeProvider();

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
        await embeddingService.embedMany(texts);
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
      const dict = await this.dictProvider.provide().catch(() => []);
      candidates.push(...dict);
    }

    if (candidates.length < 3 && workspaceId) {
      const legacy = await this.legacyProvider
        .provide(workspaceId)
        .catch(() => []);
      const seen = new Set(candidates.map((c) => c.id));
      for (const r of legacy) if (!seen.has(r.id)) candidates.push(r);
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
        .map((r) => ({ record: r, score: 0.5 }));
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
      queryVec = await embeddingService.embed(query);
    } catch {
      return candidates
        .slice(0, n.limit)
        .map((r) => ({ record: r, score: 0.5 }));
    }

    const texts = candidates.map((c) => c.text);
    let vectors: Float32Array[] = [];
    try {
      const res = await embeddingService.embedMany(texts);
      vectors = res.vectors;
    } catch {
      return candidates
        .slice(0, n.limit)
        .map((r) => ({ record: r, score: 0.5 }));
    }

    const scored: KnowledgeResult[] = candidates.map((rec, i) => {
      const v = vectors[i];
      let score = v ? Embedder.cosineSimilarity(queryVec!, v) : 0;
      const status = (rec.metadata as { status?: string }).status;
      if (status === "active") score += 0.15;
      else if (status === "stale") score += 0.05;
      else if (status === "superseded") score -= 0.1;
      if (n.datasetIds.length > 0) {
        const provIds =
          rec.provenance.datasetIds ?? (rec.datasetId ? [rec.datasetId] : []);
        if (provIds.some((id) => n.datasetIds.includes(id))) score += 0.2;
      }
      if (n.activeCellId && rec.cellId === n.activeCellId) score += 0.3;
      if (n.activeCellId && rec.provenance.cellId === n.activeCellId)
        score += 0.3;
      if (n.column) {
        const cols =
          rec.provenance.columns ??
          ((rec.metadata as Record<string, unknown>)?.columns as
            string[] | undefined);
        if (cols?.includes(n.column)) score += 0.2;
      }
      if (n.activeCellId && activeIndex != null && rec.cellId) {
        const candIdx = cellIndexMap.get(rec.cellId);
        if (candIdx != null) {
          const dist = Math.abs(candIdx - activeIndex);
          score += 0.15 * (1 / (1 + dist));
        }
      }
      if (n.activeCellId && activeIndex != null && rec.provenance.cellId) {
        const candIdx = cellIndexMap.get(rec.provenance.cellId);
        if (candIdx != null) {
          const dist = Math.abs(candIdx - activeIndex);
          score += 0.1 * (1 / (1 + dist));
        }
      }
      return { record: rec, score, vector: v };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, n.limit);
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
