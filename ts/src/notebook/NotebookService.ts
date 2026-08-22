/**
 * G24: NotebookService — thin orchestrator over NotebookRepository (IDB) + future nbformat adapter.
 * Does NOT implement .ipynb parsing — delegates to src/notebook/nbformat.ts (thin adapter over nbformat spec).
 */
import type { Notebook, NotebookCell } from "./types";
import { notebookRepository } from "./NotebookRepository";
import { toIpynb, fromIpynb, type IpynbNotebook } from "./nbformat";

function genId(prefix = "cell"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class NotebookService {
  async getOrCreate(workspaceId: string): Promise<Notebook> {
    let nb = await notebookRepository.getByWorkspace(workspaceId);
    if (nb) return nb;
    const now = Date.now();
    nb = {
      id: `nb_${workspaceId}`,
      workspaceId,
      version: 1,
      cells: [],
      metadata: {},
      createdAt: now,
      updatedAt: now,
    };
    await notebookRepository.put(nb);
    return nb;
  }

  async appendCell(
    workspaceId: string,
    cell: Omit<NotebookCell, "id" | "index" | "createdAt" | "updatedAt"> &
      Partial<Pick<NotebookCell, "id">>,
  ): Promise<NotebookCell> {
    const nb = await this.getOrCreate(workspaceId);
    const now = Date.now();
    const newCell: NotebookCell = {
      id: cell.id ?? genId(),
      index: nb.cells.length + 1,
      type: cell.type,
      status: cell.status ?? "active",
      source: cell.source ?? {},
      outputs: cell.outputs ?? [],
      metadata: cell.metadata ?? {},
      execution: cell.execution ?? {
        executionCount:
          nb.cells.filter((c) => c.status === "active").length + 1,
        status: "success",
        inputHash: `hash_${Date.now()}`,
      },
      provenance: cell.provenance ?? {
        datasetIds: cell.datasetIds ?? [],
        sourceCellIds: [],
        inputHashes: [],
        dependsOn: [],
      },
      createdAt: now,
      updatedAt: now,
      step: cell.step,
      datasetIds: cell.datasetIds ?? [],
    };
    nb.cells.push(newCell);
    nb.updatedAt = now;
    // reindex
    nb.cells.forEach((c, i) => (c.index = i + 1));
    await notebookRepository.put(nb);
    return newCell;
  }

  async appendSuggested(
    workspaceId: string,
    suggested: {
      title: string;
      type: NotebookCell["type"];
      datasetIds: string[];
      operation: string;
      config: Record<string, unknown>;
    },
  ): Promise<NotebookCell> {
    return this.appendCell(workspaceId, {
      type: suggested.type,
      status: "active",
      source: { config: suggested.config },
      outputs: [],
      metadata: { title: suggested.title },
      execution: {
        executionCount: null,
        status: "idle",
        inputHash: `suggested_${Date.now()}`,
      },
      provenance: {
        datasetIds: suggested.datasetIds,
        sourceCellIds: [],
        inputHashes: [],
        operation: suggested.operation,
        dependsOn: [],
      },
      step: "clean",
      datasetIds: suggested.datasetIds,
    });
  }

  async markSuperseded(workspaceId: string, fromIndex: number): Promise<void> {
    const nb = await notebookRepository.getByWorkspace(workspaceId);
    if (!nb) return;
    for (const c of nb.cells) {
      if (c.index >= fromIndex && c.status === "active") {
        c.status = "superseded";
        c.updatedAt = Date.now();
      }
    }
    nb.updatedAt = Date.now();
    await notebookRepository.put(nb);
  }

  async markStale(workspaceId: string, cellId: string): Promise<void> {
    const nb = await notebookRepository.getByWorkspace(workspaceId);
    if (!nb) return;
    const idx = nb.cells.findIndex((c) => c.id === cellId);
    if (idx === -1) return;
    const affected = new Set<string>([cellId]);
    // propagate via dependsOn (provenance)
    for (let i = idx; i < nb.cells.length; i++) {
      const c = nb.cells[i];
      if (
        c.provenance?.dependsOn &&
        c.provenance.dependsOn.some((d: string) => affected.has(d))
      ) {
        affected.add(c.id);
      }
    }
    for (const c of nb.cells) {
      if (affected.has(c.id) && c.status === "active") {
        c.status = "stale";
        c.execution.status = "stale";
        c.updatedAt = Date.now();
      }
    }
    nb.updatedAt = Date.now();
    await notebookRepository.put(nb);
  }

  async runCell(_workspaceId: string, _cellId: string): Promise<void> {
    // Phase 4: execution will call operation-specific handlers via NotebookExecutionService
    // Stub respects G15 business-logic single source — no inline cleaning logic here.
  }

  async getActiveCells(workspaceId: string): Promise<NotebookCell[]> {
    const nb = await notebookRepository.getByWorkspace(workspaceId);
    if (!nb) return [];
    return nb.cells.filter((c) => c.status === "active");
  }

  async getCell(
    workspaceId: string,
    cellId: string,
  ): Promise<NotebookCell | null> {
    const nb = await notebookRepository.getByWorkspace(workspaceId);
    if (!nb) return null;
    return nb.cells.find((c) => c.id === cellId) ?? null;
  }

  async listCells(workspaceId: string): Promise<NotebookCell[]> {
    const nb = await notebookRepository.getByWorkspace(workspaceId);
    return nb?.cells ?? [];
  }

  async updateCell(
    workspaceId: string,
    cellId: string,
    patch: Partial<NotebookCell>,
  ): Promise<void> {
    const nb = await notebookRepository.getByWorkspace(workspaceId);
    if (!nb) return;
    const idx = nb.cells.findIndex((c) => c.id === cellId);
    if (idx === -1) return;
    nb.cells[idx] = {
      ...nb.cells[idx],
      ...patch,
      updatedAt: Date.now(),
    } as NotebookCell;
    nb.updatedAt = Date.now();
    await notebookRepository.put(nb);
  }

  async deleteCell(workspaceId: string, cellId: string): Promise<void> {
    const nb = await notebookRepository.getByWorkspace(workspaceId);
    if (!nb) return;
    nb.cells = nb.cells.filter((c) => c.id !== cellId);
    nb.cells.forEach((c, i) => (c.index = i + 1));
    nb.updatedAt = Date.now();
    await notebookRepository.put(nb);
  }

  // nbformat interchange — thin adapter over nbformat 4.5 (G24)
  toIpynb(notebook: Notebook): IpynbNotebook {
    return toIpynb(notebook);
  }

  fromIpynb(ipynb: IpynbNotebook, workspaceId: string): Notebook {
    return fromIpynb(ipynb, workspaceId);
  }

  async exportIpynb(workspaceId: string): Promise<Blob> {
    const nb = await this.getOrCreate(workspaceId);
    const ipynb = this.toIpynb(nb);
    return new Blob([JSON.stringify(ipynb, null, 2)], {
      type: "application/x-ipynb+json",
    });
  }

  async importIpynb(
    workspaceId: string,
    ipynb: IpynbNotebook,
  ): Promise<Notebook> {
    const nb = this.fromIpynb(ipynb, workspaceId);
    await notebookRepository.put(nb);
    return nb;
  }
}

export const notebookService = new NotebookService();
