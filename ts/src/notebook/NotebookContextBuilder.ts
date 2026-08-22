import type { Notebook, NotebookCell } from "./types";
import type { KnowledgeRecord } from "@/knowledge/types";
import type { KnowledgeKind } from "@/knowledge/types";
import { knowledgeService } from "@/knowledge/KnowledgeService";
import { notebookRepository } from "./NotebookRepository";

export interface NotebookContext {
  activeCell?: NotebookCell;
  precedingCells: NotebookCell[];
  relevantCells: NotebookCell[];
  relevantKnowledge: KnowledgeRecord[];
  datasets: { datasetId: string }[];
}

export interface BuildOptions {
  workspaceId: string;
  notebookId?: string;
  activeCellId?: string;
  datasetId?: string;
  datasetIds?: string[];
  query?: string;
  scope?: "workspace" | "all";
  kinds?: KnowledgeKind[];
  column?: string;
}

export class NotebookContextBuilder {
  async build(opts: BuildOptions): Promise<NotebookContext> {
    const { workspaceId, notebookId, activeCellId, datasetId, datasetIds, query, scope, kinds, column } = opts;

    let notebook: Notebook | null = null;
    if (notebookId) {
      notebook = await notebookRepository.get(notebookId);
    } else if (workspaceId) {
      notebook = await notebookRepository.getByWorkspace(workspaceId);
    }

    const allCells = notebook?.cells ?? [];
    const activeCell = activeCellId
      ? allCells.find((c) => c.id === activeCellId)
      : undefined;
    const precedingCells = activeCell
      ? allCells
          .filter(
            (c) => c.index < activeCell.index && c.status !== "superseded",
          )
          .slice(-5)
      : [];

    const relevantIds = new Set<string>();
    if (activeCell) {
      relevantIds.add(activeCell.id);
      for (const id of activeCell.provenance.sourceCellIds) relevantIds.add(id);
      for (const id of activeCell.provenance.dependsOn) relevantIds.add(id);
    }
    const relevantCells = allCells.filter((c) => relevantIds.has(c.id));

    let relevantKnowledge: KnowledgeRecord[] = [];
    try {
      const effectiveDatasetIds =
        datasetIds ?? (datasetId ? [datasetId] : undefined);
      const q = query ?? activeCell?.metadata.title ?? "recent operations";
      const results = await knowledgeService.search(q, {
        workspaceId,
        notebookId: notebook?.id,
        activeCellId,
        scope: scope ?? "workspace",
        datasetIds: effectiveDatasetIds,
        kinds,
        column,
        limit: 8,
        includeSystemKnowledge: true,
        includeSuperseded: false,
      });
      relevantKnowledge = results.map((r) => r.record);
    } catch {
      relevantKnowledge = [];
    }

    const datasets = Array.from(
      new Set(allCells.flatMap((c) => c.datasetIds)),
    ).map((datasetId) => ({ datasetId }));

    return {
      activeCell,
      precedingCells,
      relevantCells,
      relevantKnowledge,
      datasets,
    };
  }
}

export const notebookContextBuilder = new NotebookContextBuilder();
