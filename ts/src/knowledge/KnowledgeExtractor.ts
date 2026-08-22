import type { Notebook, NotebookCell } from "@/notebook/types";
import type { KnowledgeRecord } from "./types";
import { hashString } from "@polymorpha/business-logic";

function stableId(cellId: string, suffix: string): string {
  return `${cellId}::${suffix}`;
}

async function sourceHash(text: string): Promise<string> {
  try {
    const hex = await hashString(text);
    return hex.slice(0, 16);
  } catch {
    let h = 5381;
    for (let i = 0; i < text.length; i++)
      h = (Math.imul(33, h) ^ text.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }
}

export class KnowledgeExtractor {
  async extractCell(
    cell: NotebookCell,
    notebook: Notebook,
  ): Promise<KnowledgeRecord[]> {
    const out: KnowledgeRecord[] = [];
    const baseMeta = {
      cellId: cell.id,
      cellIndex: cell.index,
      cellType: cell.type,
      datasetIds: cell.datasetIds,
      status: cell.status,
      operation: cell.provenance.operation,
      columns: cell.provenance.columns,
    };

    {
      const text = this.cellNarrative(cell);
      const sh = await sourceHash(text);
      out.push({
        id: stableId(cell.id, "narrative"),
        workspaceId: notebook.workspaceId,
        notebookId: notebook.id,
        datasetId: cell.datasetIds[0],
        cellId: cell.id,
        kind: "notebook_cell",
        text,
        metadata: { ...baseMeta, source: "notebook_cell" },
        provenance: {
          workspaceId: notebook.workspaceId,
          notebookId: notebook.id,
          cellId: cell.id,
          datasetIds: cell.datasetIds,
          columns: cell.provenance.columns,
          operation: cell.provenance.operation,
        },
        sourceHash: sh,
        createdAt: cell.createdAt,
        updatedAt: cell.updatedAt,
      });
    }

    for (const o of cell.outputs) {
      const text = this.outputNarrative(o, cell);
      if (!text) continue;
      const sh = await sourceHash(`${cell.id}:${o.id}:${text}`);
      out.push({
        id: stableId(cell.id, `output:${o.id}`),
        workspaceId: notebook.workspaceId,
        notebookId: notebook.id,
        datasetId: cell.datasetIds[0],
        cellId: cell.id,
        kind: this.outputKind(o.type),
        text,
        metadata: {
          ...baseMeta,
          outputId: o.id,
          outputType: o.type,
          title: o.metadata.title,
        },
        provenance: {
          workspaceId: notebook.workspaceId,
          notebookId: notebook.id,
          cellId: cell.id,
          datasetIds: cell.datasetIds,
        },
        sourceHash: sh,
        createdAt: cell.createdAt,
        updatedAt: cell.updatedAt,
      });
    }

    if (
      cell.type === "clean" ||
      cell.type === "transform" ||
      cell.type === "model"
    ) {
      for (const rec of await this.operationRecords(cell, notebook))
        out.push(rec);
    }

    return out;
  }

  async extractNotebook(notebook: Notebook): Promise<KnowledgeRecord[]> {
    const all: KnowledgeRecord[] = [];
    for (const cell of notebook.cells) {
      const recs = await this.extractCell(cell, notebook);
      all.push(...recs);
    }
    if (notebook.cells.length > 0) {
      const text = `Workspace ${notebook.workspaceId} notebook contains ${notebook.cells.length} cells, datasets: ${[...new Set(notebook.cells.flatMap((c) => c.datasetIds))].join(", ") || "none"}.`;
      const sh = await sourceHash(text + notebook.id);
      all.push({
        id: `${notebook.id}::summary`,
        workspaceId: notebook.workspaceId,
        notebookId: notebook.id,
        kind: "dataset_profile",
        text,
        metadata: {
          source: "notebook_summary",
          cellCount: notebook.cells.length,
        },
        provenance: {
          workspaceId: notebook.workspaceId,
          notebookId: notebook.id,
        },
        sourceHash: sh,
        createdAt: notebook.createdAt,
        updatedAt: notebook.updatedAt,
      });
    }
    return all;
  }

  private cellNarrative(cell: NotebookCell): string {
    const status =
      cell.status === "superseded"
        ? " (superseded, historical)"
        : cell.status === "stale"
          ? " (stale, inputs changed)"
          : "";
    const ds = cell.datasetIds.length
      ? ` dataset${cell.datasetIds.length > 1 ? "s" : ""} ${cell.datasetIds.join(", ")}`
      : "";
    const op = cell.provenance.operation
      ? ` operation ${cell.provenance.operation}`
      : "";
    const cols = cell.provenance.columns?.length
      ? ` columns ${cell.provenance.columns.join(", ")}`
      : "";
    switch (cell.type) {
      case "upload":
        return `Cell ${cell.index} [upload]${status} loaded${ds}.`;
      case "inspect":
        return `Cell ${cell.index} [inspect]${status} inspected${ds}${cols}.`;
      case "model":
      case "transform":
        return `Cell ${cell.index} [${cell.type}]${status}${op}${cols} on${ds}.`;
      case "clean":
        return `Cell ${cell.index} [clean]${status}${op}${cols} on${ds}.`;
      case "analysis":
      case "visualization":
        return `Cell ${cell.index} [${cell.type}]${status}${op}${cols} on${ds}.`;
      case "export":
        return `Cell ${cell.index} [export]${status} exported${ds}.`;
      case "markdown":
        return `Cell ${cell.index} [note]${status}: ${cell.source.markdown?.slice(0, 200) ?? ""}`;
      default:
        return `Cell ${cell.index} [${cell.type}]${status} on${ds}.`;
    }
  }

  private outputNarrative(
    output: import("@/notebook/types").NotebookOutput,
    cell: import("@/notebook/types").NotebookCell,
  ): string | null {
    const title = output.metadata.title ? ` "${output.metadata.title}"` : "";
    switch (output.type) {
      case "diff": {
        const d = output.data as {
          rowsRemoved?: number;
          rowsAdded?: number;
          valuesChanged?: number;
        };
        const parts: string[] = [];
        if (d.rowsRemoved) parts.push(`${d.rowsRemoved} rows removed`);
        if (d.rowsAdded) parts.push(`${d.rowsAdded} rows added`);
        if (d.valuesChanged) parts.push(`${d.valuesChanged} values changed`);
        if (parts.length === 0) return `Cell ${cell.index} produced a diff.`;
        return `Cell ${cell.index} diff${title}: ${parts.join(", ")}.`;
      }
      case "table":
        return `Cell ${cell.index} table${title} with ${output.metadata.rowCount ?? "?"} rows, columns ${output.metadata.columns?.join(", ") ?? ""}.`;
      case "chart":
        return `Cell ${cell.index} chart${title} type ${output.metadata.chartType ?? (output.data as { chartType?: string })?.chartType ?? "unknown"} ${output.metadata.columns ? `for ${output.metadata.columns.join(", ")}` : ""}.`;
      case "metric":
        return `Cell ${cell.index} metric${title}: ${JSON.stringify(output.data).slice(0, 300)}`;
      case "error":
        return `Cell ${cell.index} error${title}: ${String(output.data).slice(0, 300)}`;
      case "text":
        return `Cell ${cell.index} note${title}: ${String(output.data).slice(0, 400)}`;
      case "dataset":
        return `Cell ${cell.index} dataset${title}: ${output.metadata.rowCount ?? "?"} rows.`;
      case "file":
        return `Cell ${cell.index} file${title}: ${(output.data as { fileName?: string })?.fileName ?? ""}`;
      default:
        return null;
    }
  }

  private outputKind(t: string): KnowledgeRecord["kind"] {
    if (t === "chart") return "notebook_visualization";
    if (t === "table") return "notebook_output";
    if (t === "metric") return "notebook_output";
    if (t === "error") return "error";
    if (t === "file") return "notebook_output";
    return "notebook_output";
  }

  private async operationRecords(
    cell: NotebookCell,
    notebook: Notebook,
  ): Promise<KnowledgeRecord[]> {
    const out: KnowledgeRecord[] = [];
    const cols = cell.provenance.columns ?? [];
    if (cols.length === 0) return out;
    const op = cell.provenance.operation ?? cell.type;
    for (const col of cols) {
      const text = `Cell ${cell.index} ${op} affected column "${col}"${cell.datasetIds.length ? ` on dataset ${cell.datasetIds[0]}` : ""}.`;
      const sh = await sourceHash(text);
      out.push({
        id: stableId(cell.id, `col:${col}`),
        workspaceId: notebook.workspaceId,
        notebookId: notebook.id,
        datasetId: cell.datasetIds[0],
        cellId: cell.id,
        kind: "column_semantic",
        text,
        metadata: { source: "notebook_cell", column: col, operation: op },
        provenance: {
          workspaceId: notebook.workspaceId,
          notebookId: notebook.id,
          cellId: cell.id,
          datasetIds: cell.datasetIds,
          columns: [col],
          operation: op,
        },
        sourceHash: sh,
        createdAt: cell.createdAt,
        updatedAt: cell.updatedAt,
      });
    }
    return out;
  }
}

export const knowledgeExtractor = new KnowledgeExtractor();
