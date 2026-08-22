/**
 * G24: Thin adapter over nbformat (mature Jupyter format) — does NOT reimplement .ipynb parser.
 * Uses nbformat 4.5 NotebookNode shape via JSON, adds polymorpha metadata under metadata.polymorpha.
 * For Python-side, same adapter lives in polymorpha/io/nbformat_bridge.py (BL wheel) — this TS version is for client-side interchange (export/import without server roundtrip).
 * Execution via nbconvert remains Python-side (deferred, G24-9).
 */

import type { Notebook, NotebookCell } from "./types";

export interface IpynbCell {
  cell_type: "markdown" | "code";
  metadata: Record<string, unknown>;
  source: string | string[];
  outputs?: IpynbOutput[];
  execution_count?: number | null;
}

export interface IpynbOutput {
  output_type: "stream" | "display_data" | "execute_result" | "error";
  data?: Record<string, unknown>;
  text?: string | string[];
  name?: string;
  ename?: string;
  evalue?: string;
  traceback?: string[];
  execution_count?: number | null;
  metadata?: Record<string, unknown>;
}

export interface IpynbNotebook {
  nbformat: 4;
  nbformat_minor: 5;
  metadata: {
    kernelspec?: { display_name: string; language: string; name: string };
    language_info?: { name: string };
    polymorpha?: {
      workspaceId: string;
      notebookId: string;
      version: number;
      createdAt: number;
      updatedAt: number;
    };
  };
  cells: IpynbCell[];
}

function cellSource(cell: NotebookCell): string {
  if (cell.source.markdown) return cell.source.markdown;
  const title =
    cell.metadata.title ||
    `${cell.type} — ${cell.provenance.operation ?? ""}`.trim();
  const cols = cell.provenance.columns?.length
    ? ` columns: ${cell.provenance.columns.join(", ")}`
    : "";
  const ds = cell.datasetIds.length
    ? ` datasets: ${cell.datasetIds.join(", ")}`
    : "";
  // Intentionally NOT emitting Python code — wizard cell is described, not coded.
  return `# ${title}\n# cell ${cell.index} [${cell.type}] status=${cell.status}${cols}${ds}\n# provenance: ${JSON.stringify(cell.provenance)}`;
}

function cellToIpynb(cell: NotebookCell): IpynbCell {
  const isMarkdown = cell.type === "markdown" || cell.type === "assistant";
  const source = isMarkdown
    ? (cell.source.markdown ?? cell.metadata.title ?? "")
    : cellSource(cell);
  const base: IpynbCell = {
    cell_type: isMarkdown ? "markdown" : "code",
    metadata: {
      polymorpha: {
        cellId: cell.id,
        index: cell.index,
        status: cell.status,
        type: cell.type,
        step: cell.step,
        datasetIds: cell.datasetIds,
        execution: cell.execution,
        provenance: cell.provenance,
        createdAt: cell.createdAt,
        updatedAt: cell.updatedAt,
      },
    },
    source: source.split("\n").join("\n"),
  };
  if (!isMarkdown) {
    base.execution_count = cell.execution.executionCount;
    base.outputs = cell.outputs.map((o) => {
      const mime = o.metadata.mimeType || "text/plain";
      if (o.type === "table" || o.type === "dataset") {
        return {
          output_type: "display_data" as const,
          data: {
            "text/plain": JSON.stringify(o.data).slice(0, 2000),
            [mime]: o.data,
          },
          metadata: {},
        };
      }
      if (o.type === "chart") {
        return {
          output_type: "display_data" as const,
          data: {
            "text/plain": `[chart ${o.metadata.chartType ?? ""}]`,
            [mime]: o.data,
          },
          metadata: {},
        };
      }
      if (o.type === "error") {
        return {
          output_type: "error" as const,
          ename: "CellError",
          evalue: String(o.data).slice(0, 500),
          traceback: [String(o.data).slice(0, 2000)],
        };
      }
      if (o.type === "diff") {
        return {
          output_type: "display_data" as const,
          data: { "text/plain": JSON.stringify(o.data).slice(0, 2000) },
          metadata: {},
        };
      }
      return {
        output_type: "display_data" as const,
        data: { "text/plain": String(o.data).slice(0, 2000) },
        metadata: {},
      };
    });
  }
  return base;
}

export function toIpynb(notebook: Notebook): IpynbNotebook {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: {
        display_name: "Polymorpha",
        language: "python",
        name: "python3",
      },
      language_info: { name: "python" },
      polymorpha: {
        workspaceId: notebook.workspaceId,
        notebookId: notebook.id,
        version: notebook.version,
        createdAt: notebook.createdAt,
        updatedAt: notebook.updatedAt,
      },
    },
    cells: notebook.cells.map(cellToIpynb),
  };
}

function ipynbSourceToString(source: string | string[]): string {
  if (Array.isArray(source)) return source.join("");
  return source;
}

export function fromIpynb(ipynb: IpynbNotebook, workspaceId: string): Notebook {
  const now = Date.now();
  const cells: Notebook["cells"] = (ipynb.cells || []).map((c, i) => {
    const meta = (c.metadata?.polymorpha as Record<string, unknown>) ?? {};
    const isMarkdown = c.cell_type === "markdown";
    const sourceStr = ipynbSourceToString(c.source);
    const cellId = (meta.cellId as string) ?? `cell_${now}_${i}`;
    const type =
      (meta.type as Notebook["cells"][number]["type"]) ??
      (isMarkdown ? "markdown" : "code");
    // Heuristic: map code cell back to inspect/clean if possible, else keep as transform
    const mappedType = ((): Notebook["cells"][number]["type"] => {
      if (type === "markdown" || type === "assistant") return "markdown";
      if (
        type === "upload" ||
        type === "model" ||
        type === "clean" ||
        type === "analysis"
      )
        return type;
      return "transform";
    })();
    return {
      id: cellId,
      index: i + 1,
      type: mappedType,
      status: (meta.status as Notebook["cells"][number]["status"]) ?? "active",
      source: isMarkdown ? { markdown: sourceStr } : { markdown: sourceStr },
      outputs: (c.outputs ?? []).map((o, idx) => ({
        id: `${cellId}_out_${idx}`,
        type: (o.output_type === "error"
          ? "error"
          : "text") as Notebook["cells"][number]["outputs"][number]["type"],
        data:
          (o.data as Record<string, unknown>)?.["text/plain"] ?? o.text ?? "",
        metadata: {},
      })),
      metadata: {
        title: sourceStr.split("\n")[0]?.replace(/^#\s*/, "").slice(0, 80),
      },
      execution: {
        executionCount: (c.execution_count as number | null) ?? null,
        status: "idle",
        inputHash: `ipynb_${cellId}`,
        startedAt: undefined,
        completedAt: undefined,
      },
      provenance: {
        datasetIds: (meta.datasetIds as string[]) ?? [],
        sourceCellIds: [],
        inputHashes: [],
        operation: (meta.operation as string) ?? undefined,
        columns: (meta.columns as string[]) ?? [],
        dependsOn: [],
      },
      createdAt: (meta.createdAt as number) ?? now,
      updatedAt: (meta.updatedAt as number) ?? now,
      step: (meta.step as Notebook["cells"][number]["step"]) ?? "preview",
      datasetIds: (meta.datasetIds as string[]) ?? [],
    };
  });
  return {
    id:
      (ipynb.metadata.polymorpha?.notebookId as string) ?? `nb_${workspaceId}`,
    workspaceId,
    version: (ipynb.metadata.polymorpha?.version as number) ?? 1,
    cells,
    metadata: {},
    createdAt: (ipynb.metadata.polymorpha?.createdAt as number) ?? now,
    updatedAt: Date.now(),
  };
}
