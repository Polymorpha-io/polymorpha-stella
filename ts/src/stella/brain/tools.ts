/**
 * Agentic tool loop for Stella (default OFF — `STELLA_TOOLS_ENABLED`).
 * Tools execute against the existing retrieval plane only (G26):
 * `search_knowledge` → `KnowledgeService.search()`, `cell_lineage` →
 * `NotebookContextBuilder`, `describe_dataset` → injected expert context.
 * Failures return `"error: …"` tool text, never throw — the model sees
 * them and can recover or answer without.
 */
import { knowledgeService } from "../../knowledge/KnowledgeService";
import { notebookContextBuilder } from "../../notebook/NotebookContextBuilder";
import type { KnowledgeKind } from "../../knowledge/types";
import { STELLA_TOOL_RESULT_BUDGET } from "../../config/retrieval";

export interface ToolColumn {
  name: string;
  type: string;
}

/** Everything an executor may need — structural, no BrainService import. */
export interface ToolExecContext {
  workspaceId: string;
  notebookId?: string;
  activeCellId?: string;
  kinds?: KnowledgeKind[];
  column?: string;
  datasetIds?: string[];
  datasetExpert?: {
    fileName: string;
    uploadId: string | null;
    rowCount: number;
    colCount: number;
    columnTypes: ToolColumn[];
    cleaned: boolean;
    cleaningSummary?: string;
  } | null;
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface AssembledToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export function getStellaTools(): ToolDef[] {
  return [
    {
      type: "function",
      function: {
        name: "search_knowledge",
        description:
          "Search Stella's knowledge plane (notebook cells, dataset profiles, column semantics, dictionary) for evidence relevant to the user's question.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Focused search query, phrased for retrieval.",
            },
            limit: {
              type: "integer",
              description: "Max records (1-8).",
            },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "describe_dataset",
        description:
          "Return the current dataset-expert summary (shape, columns, cleaning) from the request context.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "cell_lineage",
        description:
          "Return a notebook cell plus its preceding context and lineage for grounding citations.",
        parameters: {
          type: "object",
          properties: {
            cellId: { type: "string", description: "Notebook cell id." },
          },
          required: ["cellId"],
        },
      },
    },
  ];
}

function clip(text: string, budget = STELLA_TOOL_RESULT_BUDGET): string {
  return text.length > budget ? `${text.slice(0, budget)}…[truncated]` : text;
}

async function searchKnowledge(
  ctx: ToolExecContext,
  args: Record<string, unknown>,
): Promise<string> {
  const query = typeof args.query === "string" ? args.query : "";
  if (!query.trim()) return "error: query is required";
  const limit =
    typeof args.limit === "number"
      ? Math.max(1, Math.min(8, Math.floor(args.limit)))
      : 5;
  const results = await knowledgeService.search(query, {
    workspaceId: ctx.workspaceId,
    notebookId: ctx.notebookId,
    activeCellId: ctx.activeCellId,
    kinds: ctx.kinds,
    column: ctx.column,
    datasetIds: ctx.datasetIds,
    limit,
    includeSystemKnowledge: true,
  });
  if (results.length === 0) return "no records found";
  return clip(
    results
      .map(
        (r, i) =>
          `#${i + 1} [${r.record.kind}] ${r.record.text} (score ${r.score.toFixed(2)})`,
      )
      .join("\n"),
  );
}

async function describeDataset(ctx: ToolExecContext): Promise<string> {
  const de = ctx.datasetExpert;
  if (!de) return "no dataset in context";
  const cols = de.columnTypes
    .slice(0, 12)
    .map((c) => `${c.name}(${c.type})`)
    .join(", ");
  return clip(
    `Dataset "${de.fileName}" — ${de.rowCount} rows × ${de.colCount} cols${de.cleaned ? " (cleaned)" : ""}${de.cleaningSummary ? ` — ${de.cleaningSummary}` : ""} — columns: ${cols}`,
  );
}

async function cellLineage(
  ctx: ToolExecContext,
  args: Record<string, unknown>,
): Promise<string> {
  const cellId = typeof args.cellId === "string" ? args.cellId : "";
  if (!cellId) return "error: cellId is required";
  const nb = await notebookContextBuilder.build({
    workspaceId: ctx.workspaceId,
    notebookId: ctx.notebookId,
    activeCellId: cellId,
    query: "",
  });
  if (!nb.activeCell) return `cell ${cellId} not found`;
  const parts = [
    `Cell ${nb.activeCell.index} [${nb.activeCell.type}] status=${nb.activeCell.status}`,
    `Operation: ${nb.activeCell.provenance.operation ?? "—"}`,
    nb.precedingCells.length
      ? `Preceding: ${nb.precedingCells.map((c) => `Cell ${c.index} ${c.type}`).join(" | ")}`
      : "",
  ].filter(Boolean);
  return clip(parts.join("\n"));
}

export async function executeToolCall(
  ctx: ToolExecContext,
  call: AssembledToolCall,
): Promise<string> {
  try {
    switch (call.name) {
      case "search_knowledge":
        return await searchKnowledge(ctx, call.args);
      case "describe_dataset":
        return await describeDataset(ctx);
      case "cell_lineage":
        return await cellLineage(ctx, call.args);
      default:
        return `error: unknown tool "${call.name}"`;
    }
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export interface ToolCallChunk {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/**
 * Assemble OpenAI-style streamed `delta.tool_calls` chunks (by index)
 * into complete calls. Malformed args JSON degrades to `{}`.
 */
export function assembleToolCalls(
  chunks: ToolCallChunk[],
): AssembledToolCall[] {
  const byIndex = new Map<number, { id: string; name: string; args: string }>();
  for (const c of chunks) {
    const idx = c.index ?? 0;
    const cur = byIndex.get(idx) ?? { id: "", name: "", args: "" };
    if (c.id) cur.id = c.id;
    if (c.function?.name) cur.name += c.function.name;
    if (c.function?.arguments) cur.args += c.function.arguments;
    byIndex.set(idx, cur);
  }
  return [...byIndex.values()]
    .filter((c) => c.name)
    .map((c, i) => {
      let args: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(c.args || "{}");
        if (parsed && typeof parsed === "object")
          args = parsed as Record<string, unknown>;
      } catch {
        /* {} */
      }
      return { id: c.id || `call_${i}`, name: c.name, args };
    });
}
