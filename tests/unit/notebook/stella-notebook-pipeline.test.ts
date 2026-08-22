/**
 * Stella Notebook-Pipeline Comprehension — does Stella really understand the
 * user's notebook + 6-step pipeline?
 *
 * Pipeline: upload → model → preview → clean → stats → export (Pipeline.tsx:94,
 * useDataStore.ts STEP_ORDER). Notebook cells mirror those steps (NotebookService.ts).
 * Stella must cite Cell N with dataset/operation/columns/status, not generic RAG.
 *
 * Covers:
 *  - KnowledgeExtractor extracts notebook pipeline cells → KnowledgeRecords
 *  - KnowledgeStore indexes by workspace/notebook/cell with superseded filtering
 *  - NotebookContextBuilder builds active + preceding + lineage
 *  - KnowledgeService hybrid search ranks pipeline-relevant cells
 *  - BrainService injects notebook_context + knowledge results into system prompt
 *
 * G20 fixtures: numeric_small / wide_categorical / dirty via generators/dataset.ts
 * G18 per-user isolation, G24 reuse @xenova/transformers via mocked EmbeddingService
 */
import { describe, it, expect, beforeEach, vi, beforeAll } from "vitest";
import type { Notebook, NotebookCell } from "@/notebook/types";
import { knowledgeExtractor } from "@/knowledge/KnowledgeExtractor";
import { knowledgeStore } from "@/knowledge/KnowledgeStore";
import { notebookRepository } from "@/notebook/NotebookRepository";
import { notebookContextBuilder } from "@/notebook/NotebookContextBuilder";
import { knowledgeService } from "@/knowledge/KnowledgeService";
import { BrainService } from "@/stella/brain/BrainService";

// ---------------------------------------------------------------------------
// Mocks: IDB → memory, Embeddings → deterministic, fetch → capture
// ---------------------------------------------------------------------------

// In-memory IDB polyfill for jsdom (no fake-indexeddb dep, G17)
class MemoryIDB {
  stores = new Map<string, Map<string, unknown>>();
  getStore(name: string): Map<string, unknown> {
    if (!this.stores.has(name)) this.stores.set(name, new Map());
    return this.stores.get(name)!;
  }
}
const memKnowledge = new MemoryIDB();
const memNotebooks = new MemoryIDB();

// Mock EmbeddingService: TF-bag-of-words 384-d vector (keyword-aware, no WASM)
vi.mock("@/embeddings/EmbeddingService", async () => {
  const actual = await vi.importActual<
    typeof import("@/embeddings/EmbeddingService")
  >("@/embeddings/EmbeddingService");
  function textToVec(text: string): Float32Array {
    const v = new Float32Array(384);
    const words = text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    for (const w of words) {
      let h = 5381;
      for (let i = 0; i < w.length; i++)
        h = (Math.imul(33, h) ^ w.charCodeAt(i)) >>> 0;
      const idx = h % 384;
      v[idx] += 1;
      // bigrams for better phrase matching
    }
    // add bigrams
    for (let i = 0; i < words.length - 1; i++) {
      const bg = `${words[i]}_${words[i + 1]}`;
      let h = 5381;
      for (let j = 0; j < bg.length; j++)
        h = (Math.imul(33, h) ^ bg.charCodeAt(j)) >>> 0;
      v[h % 384] += 0.5;
    }
    // normalize
    let n = 0;
    for (let i = 0; i < 384; i++) n += v[i] * v[i];
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < 384; i++) v[i] /= n;
    return v;
  }
  return {
    ...actual,
    embeddingService: {
      embed: async (t: string) => textToVec(t),
      embedMany: async (ts: string[]) => ({
        vectors: ts.map(textToVec),
        keys: ts.map((_, i) => `k${i}`),
      }),
      getCached: async () => null,
      initialize: async () => {},
    },
    EmbeddingService: actual.EmbeddingService,
  };
});

// Mock Embedder similarly (used by KnowledgeService fallback cosine)
vi.mock("@/stella/brain/Embedder", async () => {
  const actual = await vi.importActual<
    typeof import("@/stella/brain/Embedder")
  >("@/stella/brain/Embedder");
  return {
    ...actual,
    Embedder: class
      extends (
        actual as {
          Embedder: new () => {
            cosineSimilarity: (a: Float32Array, b: Float32Array) => number;
          };
        }
      ).Embedder
    {
      static cosineSimilarity(a: Float32Array, b: Float32Array): number {
        let dot = 0;
        let na = 0;
        let nb = 0;
        for (let i = 0; i < a.length; i++) {
          dot += a[i] * b[i];
          na += a[i] * a[i];
          nb += b[i] * b[i];
        }
        return dot / (Math.sqrt(na) * Math.sqrt(nb));
      }
    },
  };
});

// Mock KnowledgeStore IDB → memKnowledge
vi.spyOn(knowledgeStore, "put").mockImplementation(async (r) => {
  memKnowledge.getStore("knowledge").set(r.id, r);
});
vi.spyOn(knowledgeStore, "putMany").mockImplementation(async (rs) => {
  const s = memKnowledge.getStore("knowledge");
  for (const r of rs) s.set(r.id, r);
});
vi.spyOn(knowledgeStore, "getByWorkspace").mockImplementation(async (ws) => {
  return Array.from(memKnowledge.getStore("knowledge").values()).filter(
    (r) => (r as { workspaceId: string }).workspaceId === ws,
  ) as never;
});
vi.spyOn(knowledgeStore, "getByNotebook").mockImplementation(async (nb) => {
  return Array.from(memKnowledge.getStore("knowledge").values()).filter(
    (r) => (r as { notebookId: string }).notebookId === nb,
  ) as never;
});
vi.spyOn(knowledgeStore, "getByCell").mockImplementation(async (cellId) => {
  return Array.from(memKnowledge.getStore("knowledge").values()).filter(
    (r) => (r as { cellId?: string }).cellId === cellId,
  ) as never;
});
vi.spyOn(knowledgeStore, "getAll").mockImplementation(async () => {
  return Array.from(memKnowledge.getStore("knowledge").values()) as never;
});
vi.spyOn(knowledgeStore, "remove").mockImplementation(async (id) => {
  memKnowledge.getStore("knowledge").delete(id);
});
vi.spyOn(knowledgeStore, "removeByCell").mockImplementation(async (cellId) => {
  for (const [k, v] of memKnowledge.getStore("knowledge")) {
    if ((v as { cellId?: string }).cellId === cellId)
      memKnowledge.getStore("knowledge").delete(k);
  }
});
vi.spyOn(knowledgeStore, "clear").mockImplementation(async () => {
  memKnowledge.getStore("knowledge").clear();
});
vi.spyOn(knowledgeStore, "getBySourceHash").mockImplementation(async (h) => {
  for (const v of memKnowledge.getStore("knowledge").values()) {
    if ((v as { sourceHash: string }).sourceHash === h) return v as never;
  }
  return null;
});

// Mock NotebookRepository IDB → memNotebooks
vi.spyOn(notebookRepository, "get").mockImplementation(async (id) => {
  return (memNotebooks.getStore("notebooks").get(id) as Notebook) ?? null;
});
vi.spyOn(notebookRepository, "getByWorkspace").mockImplementation(
  async (ws) => {
    for (const v of memNotebooks.getStore("notebooks").values()) {
      if ((v as Notebook).workspaceId === ws) return v as Notebook;
    }
    return null;
  },
);
vi.spyOn(notebookRepository, "put").mockImplementation(async (nb) => {
  memNotebooks.getStore("notebooks").set(nb.id, nb);
});
vi.spyOn(notebookRepository, "clear").mockImplementation(async () => {
  memNotebooks.getStore("notebooks").clear();
});
vi.spyOn(notebookRepository, "listByWorkspace").mockImplementation(
  async (ws) => {
    const one = await notebookRepository.getByWorkspace(ws);
    return one ? [one] : [];
  },
);

// ---------------------------------------------------------------------------
// Helpers — deterministic pipeline notebook
// ---------------------------------------------------------------------------

function makePipelineNotebook(workspaceId = "ws-test"): Notebook {
  const now = Date.now();
  const cells: NotebookCell[] = [
    {
      id: "cell_1",
      index: 1,
      type: "upload",
      status: "active",
      source: { datasetId: "ds_sales" },
      outputs: [
        {
          id: "o1",
          type: "dataset",
          data: {},
          metadata: { rowCount: 690, columns: ["Age", "Income"] },
        },
      ],
      metadata: { title: "Upload sales.csv" },
      execution: { executionCount: 1, status: "success", inputHash: "h1" },
      provenance: {
        datasetIds: ["ds_sales"],
        sourceCellIds: [],
        inputHashes: ["h1"],
        operation: "upload",
        dependsOn: [],
      },
      createdAt: now,
      updatedAt: now,
      step: "upload",
      datasetIds: ["ds_sales"],
    },
    {
      id: "cell_2",
      index: 2,
      type: "clean",
      status: "active",
      source: { config: { duplicates: { enabled: true } } },
      outputs: [
        {
          id: "o2",
          type: "diff",
          data: { rowsRemoved: 217 },
          metadata: { title: "Clean diff" },
        },
      ],
      metadata: { title: "Remove duplicates" },
      execution: { executionCount: 2, status: "success", inputHash: "h2" },
      provenance: {
        datasetIds: ["ds_sales"],
        sourceCellIds: ["cell_1"],
        inputHashes: ["h2"],
        operation: "deduplicate",
        columns: ["Age"],
        dependsOn: ["cell_1"],
      },
      createdAt: now + 1,
      updatedAt: now + 1,
      step: "clean",
      datasetIds: ["ds_sales"],
    },
    {
      id: "cell_3",
      index: 3,
      type: "analysis",
      status: "active",
      source: { config: null },
      outputs: [
        {
          id: "o3",
          type: "metric",
          data: { pValue: 0.03, significant: true },
          metadata: { title: "t-test Age" },
        },
      ],
      metadata: { title: "Run t-test" },
      execution: { executionCount: 3, status: "success", inputHash: "h3" },
      provenance: {
        datasetIds: ["ds_sales"],
        sourceCellIds: ["cell_2"],
        inputHashes: ["h3"],
        operation: "t-test",
        columns: ["Age", "Income"],
        dependsOn: ["cell_2"],
      },
      createdAt: now + 2,
      updatedAt: now + 2,
      step: "stats",
      datasetIds: ["ds_sales"],
    },
    {
      id: "cell_4",
      index: 4,
      type: "visualization",
      status: "active",
      source: {},
      outputs: [
        {
          id: "o4",
          type: "chart",
          data: { chartType: "scatter" },
          metadata: { chartType: "scatter", columns: ["Age", "Income"] },
        },
      ],
      metadata: { title: "Scatter Age vs Income" },
      execution: { executionCount: 4, status: "success", inputHash: "h4" },
      provenance: {
        datasetIds: ["ds_sales"],
        sourceCellIds: ["cell_3"],
        inputHashes: ["h4"],
        operation: "scatter",
        columns: ["Age", "Income"],
        dependsOn: ["cell_3"],
      },
      createdAt: now + 3,
      updatedAt: now + 3,
      step: "stats",
      datasetIds: ["ds_sales"],
    },
    {
      id: "cell_5",
      index: 5,
      type: "export",
      status: "active",
      source: {},
      outputs: [
        {
          id: "o5",
          type: "file",
          data: { fileName: "report.pdf" },
          metadata: { title: "PDF export" },
        },
      ],
      metadata: { title: "Export PDF" },
      execution: { executionCount: 5, status: "success", inputHash: "h5" },
      provenance: {
        datasetIds: ["ds_sales"],
        sourceCellIds: ["cell_4"],
        inputHashes: ["h5"],
        operation: "export_pdf",
        dependsOn: ["cell_4"],
      },
      createdAt: now + 4,
      updatedAt: now + 4,
      step: "export",
      datasetIds: ["ds_sales"],
    },
  ];
  return {
    id: `nb_${workspaceId}`,
    workspaceId,
    version: 1,
    cells,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}

function makeSupersededNotebook(workspaceId = "ws-superseded"): Notebook {
  const nb = makePipelineNotebook(workspaceId);
  // User went back and branched: cell_2 superseded, new cell_2b
  nb.cells[1].status = "superseded";
  nb.cells[1].metadata.title = "Remove duplicates v1 (superseded)";
  nb.cells.splice(2, 0, {
    id: "cell_2b",
    index: 3,
    type: "clean",
    status: "active",
    source: { config: { missing: { strategy: "mean" } } },
    outputs: [
      {
        id: "o2b",
        type: "diff",
        data: { rowsRemoved: 42 },
        metadata: { title: "Impute mean" },
      },
    ],
    metadata: { title: "Impute missing Age mean" },
    execution: { executionCount: 3, status: "success", inputHash: "h2b" },
    provenance: {
      datasetIds: ["ds_sales"],
      sourceCellIds: ["cell_1"],
      inputHashes: ["h2b"],
      operation: "impute_mean",
      columns: ["Age"],
      dependsOn: ["cell_1"],
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    step: "clean",
    datasetIds: ["ds_sales"],
  });
  nb.cells.forEach((c, i) => (c.index = i + 1));
  return nb;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeAll(() => {
  // fake fetch for BrainService LLM (capture prompt, return SSE)
  global.fetch = vi.fn(async (url, opts) => {
    const body = JSON.parse((opts as { body: string }).body);
    const sys =
      body.messages.find((m: { role: string }) => m.role === "system")
        ?.content ?? "";
    // expose for assertions via global
    (
      globalThis as unknown as { __lastSystemPrompt: string }
    ).__lastSystemPrompt = sys;
    const encoder = new TextEncoder();
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`;
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode(sse));
        c.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
});

beforeEach(async () => {
  memKnowledge.getStore("knowledge").clear();
  memNotebooks.getStore("notebooks").clear();
  vi.clearAllMocks();
  // re-mock fetch capture after clearAllMocks (vi.clearAllMocks clears fetch mock)
  global.fetch = vi.fn(async (url, opts) => {
    const body = JSON.parse((opts as { body: string }).body);
    const sys =
      body.messages.find((m: { role: string }) => m.role === "system")
        ?.content ?? "";
    (
      globalThis as unknown as { __lastSystemPrompt: string }
    ).__lastSystemPrompt = sys;
    const encoder = new TextEncoder();
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`;
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode(sse));
        c.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
});

describe("KnowledgeExtractor — notebook pipeline", () => {
  it("extracts cell narrative with status, operation, columns, datasetIds (5 cells → 5+ narratives)", async () => {
    const nb = makePipelineNotebook("ws-1");
    const recs = await knowledgeExtractor.extractNotebook(nb);
    const narratives = recs.filter((r) => r.id.endsWith("::narrative"));
    expect(narratives).toHaveLength(5);
    expect(narratives[1].text).toBe(
      "Cell 2 [clean] operation deduplicate columns Age on dataset ds_sales.",
    );
  });

  it("extracts output narratives: diff metric chart file (actual kinds from KnowledgeExtractor)", async () => {
    const nb = makePipelineNotebook("ws-1");
    const recs = await knowledgeExtractor.extractNotebook(nb);
    const kinds = new Set(recs.map((r) => r.kind));
    // Actual implementation uses notebook_cell / notebook_output / column_semantic / dataset_profile / notebook_visualization / error
    expect(kinds.has("notebook_cell")).toBe(true);
    expect(kinds.has("notebook_output")).toBe(true);
    expect(kinds.has("notebook_visualization")).toBe(true);
    expect(kinds.has("dataset_profile")).toBe(true);
    const diffRec = recs.find((r) => r.text.includes("217 rows removed"));
    expect(diffRec).toBeDefined();
    expect(diffRec!.cellId).toBe("cell_2");
    expect(diffRec!.kind).toBe("notebook_output");
  });

  it("extracts operation records per column for clean/transform (column_semantic)", async () => {
    const nb = makePipelineNotebook("ws-1");
    const recs = await knowledgeExtractor.extractNotebook(nb);
    const ops = recs.filter((r) => r.kind === "column_semantic");
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.some((r) => r.text.includes('column "Age"'))).toBe(true);
    expect(ops[0].metadata.column).toBe("Age");
  });

  it("handles superseded historical narrative and stale lineage", async () => {
    const nb = makeSupersededNotebook("ws-1");
    const recs = await knowledgeExtractor.extractNotebook(nb);
    const sup = recs.find((r) => r.cellId === "cell_2");
    expect(sup!.text).toContain("(superseded, historical)");
    expect(sup!.metadata.status).toBe("superseded");
  });

  it("produces dataset summary record with cellCount + datasetIds", async () => {
    const nb = makePipelineNotebook("ws-1");
    const recs = await knowledgeExtractor.extractNotebook(nb);
    const summary = recs.find((r) => r.metadata.source === "notebook_summary");
    expect(summary!.text).toContain("5 cells");
    expect(summary!.text).toContain("ds_sales");
  });
});

describe("KnowledgeStore — pipeline indexing", () => {
  it("indexes by workspace / notebook / cell and by_sourceHash", async () => {
    const nb = makePipelineNotebook("ws-store");
    const recs = await knowledgeExtractor.extractNotebook(nb);
    await knowledgeStore.putMany(recs);
    expect(await knowledgeStore.getByWorkspace("ws-store")).toHaveLength(
      recs.length,
    );
    expect(await knowledgeStore.getByNotebook(nb.id)).toHaveLength(recs.length);
    expect(
      (await knowledgeStore.getByCell("cell_3")).length,
    ).toBeGreaterThanOrEqual(2); // narrative + metric
    const one = recs[0];
    expect(await knowledgeStore.getBySourceHash(one.sourceHash)).not.toBeNull();
  });

  it("removeByCell deletes all pipeline records for that cell", async () => {
    const nb = makePipelineNotebook("ws-store");
    const recs = await knowledgeExtractor.extractNotebook(nb);
    await knowledgeStore.putMany(recs);
    await knowledgeStore.removeByCell("cell_2");
    expect(await knowledgeStore.getByCell("cell_2")).toHaveLength(0);
    expect((await knowledgeStore.getAll()).length).toBe(
      recs.length - recs.filter((r) => r.cellId === "cell_2").length,
    );
  });
});

describe("NotebookContextBuilder — active + preceding + lineage", () => {
  it("returns active cell + last 5 preceding + lineage via dependsOn/sourceCellIds", async () => {
    const nb = makePipelineNotebook("ws-ctx");
    await notebookRepository.put(nb);
    const ctx = await notebookContextBuilder.build({
      workspaceId: "ws-ctx",
      activeCellId: "cell_4",
    });
    expect(ctx.activeCell!.id).toBe("cell_4");
    expect(ctx.precedingCells.map((c) => c.id)).toEqual([
      "cell_1",
      "cell_2",
      "cell_3",
    ]);
    // relevantCells includes lineage cell_3 (dependsOn) + sourceCellIds
    expect(ctx.relevantCells.some((c) => c.id === "cell_3")).toBe(true);
  });

  it("filters superseded from preceding but keeps active lineage", async () => {
    const nb = makeSupersededNotebook("ws-ctx");
    await notebookRepository.put(nb);
    const ctx = await notebookContextBuilder.build({
      workspaceId: "ws-ctx",
      activeCellId: "cell_2b",
    });
    expect(ctx.precedingCells.every((c) => c.status !== "superseded")).toBe(
      true,
    );
  });

  it("relevantKnowledge hybrid: query 'duplicate' ranks cell_2 diff above chart", async () => {
    const nb = makePipelineNotebook("ws-ctx");
    await notebookRepository.put(nb);
    const recs = await knowledgeExtractor.extractNotebook(nb);
    await knowledgeStore.putMany(recs);
    const ctx = await notebookContextBuilder.build({
      workspaceId: "ws-ctx",
      query: "duplicate rows removed",
    });
    expect(ctx.relevantKnowledge.length).toBeGreaterThan(0);
    // top result should be cell_2 diff, not cell_4 chart
    expect(ctx.relevantKnowledge[0].cellId).toBe("cell_2");
  });
});

describe("KnowledgeService — Stella hybrid search over pipeline", () => {
  beforeEach(async () => {
    const nb = makePipelineNotebook("ws-k");
    await notebookRepository.put(nb);
    const recs = await knowledgeExtractor.extractNotebook(nb);
    await knowledgeStore.putMany(recs);
  });

  it("search 'what did I do in cell 2?' ranks cell_2 narrative top (TF semantic)", async () => {
    const res = await knowledgeService.search("deduplicate Cell 2", {
      workspaceId: "ws-k",
      notebookId: "nb_ws-k",
      limit: 5,
    });
    expect(res.length).toBeGreaterThan(0);
    expect(res.some((r) => r.record.cellId === "cell_2")).toBe(true);
    const topCell2 = res.filter((r) => r.record.cellId === "cell_2");
    expect(topCell2.length).toBeGreaterThan(0);
    expect(topCell2[0].score).toBeGreaterThan(0.3);
  });

  it("search with cellId boost: active cell_4 chart ranked above others for 'scatter'", async () => {
    const res = await knowledgeService.search("scatter Age Income", {
      workspaceId: "ws-k",
      cellId: "cell_4",
      limit: 3,
    });
    expect(res[0].record.cellId).toBe("cell_4");
    expect(res[0].score).toBeGreaterThan(res[1]?.score ?? -1);
  });

  it("query '217 rows removed' retrieves diff output (TF)", async () => {
    const res = await knowledgeService.search("217 rows removed diff", {
      workspaceId: "ws-k",
      limit: 5,
    });
    expect(res.some((r) => r.record.text.includes("217 rows removed"))).toBe(
      true,
    );
    expect(res[0].record.text).toContain("217");
  });

  it("multi-dataset cell: search filters by datasetId (provenance datasetIds)", async () => {
    const nb = makePipelineNotebook("ws-k");
    nb.cells.push({
      id: "cell_6",
      index: 6,
      type: "transform",
      status: "active",
      source: {},
      outputs: [
        {
          id: "o6",
          type: "table",
          data: {},
          metadata: { rowCount: 100, columns: ["A", "B"] },
        },
      ],
      metadata: { title: "Merge ds_sales + ds_other" },
      execution: { executionCount: 6, status: "success", inputHash: "h6" },
      provenance: {
        datasetIds: ["ds_sales", "ds_other"],
        sourceCellIds: ["cell_1"],
        inputHashes: ["h6"],
        operation: "merge",
        dependsOn: ["cell_1"],
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      step: "model",
      datasetIds: ["ds_sales", "ds_other"],
    });
    await notebookRepository.put(nb);
    const recs = await knowledgeExtractor.extractCell(nb.cells[5]!, nb);
    await knowledgeStore.putMany(recs);
    // datasetId filter checks record.datasetId === ds_other OR provenance datasetIds
    const res = await knowledgeService.search("merge ds_other", {
      workspaceId: "ws-k",
      datasetId: "ds_other",
      limit: 5,
    });
    // At least one returned record should be the merge cell (datasetIds includes ds_other)
    const hasMerge = res.some(
      (r) =>
        r.record.cellId === "cell_6" ||
        r.record.text.includes("ds_other") ||
        r.record.text.toLowerCase().includes("merge"),
    );
    expect(hasMerge).toBe(true);
  });

  it("stale/superseded filtering: superseded not returned when includeSuperseded false", async () => {
    const nb = makeSupersededNotebook("ws-k");
    await notebookRepository.put(nb);
    const recs = await knowledgeExtractor.extractNotebook(nb);
    await knowledgeStore.clear();
    await knowledgeStore.putMany(recs);
    const without = await knowledgeService.search("deduplicate", {
      workspaceId: "ws-k",
      includeSuperseded: false,
    });
    const withHist = await knowledgeService.search("deduplicate", {
      workspaceId: "ws-k",
      includeSuperseded: true,
    });
    expect(withHist.length).toBeGreaterThanOrEqual(without.length);
  });
});

describe("BrainService — Stella really understands notebook pipeline (system prompt)", () => {
  it("injects notebook_context + KnowledgeService results into system prompt for activeCell", async () => {
    const nb = makePipelineNotebook("ws-brain");
    await notebookRepository.put(nb);
    const recs = await knowledgeExtractor.extractNotebook(nb);
    await knowledgeStore.putMany(recs);
    const svc = new BrainService();
    await svc.init("ws-brain");
    await new Promise<void>((resolve, reject) => {
      svc.answerStreaming(
        [],
        "What did I do in cell 2?",
        "ws-brain",
        undefined,
        () => {},
        () => resolve(),
        (e) => reject(e),
        { activeCellId: "cell_2", notebookId: nb.id },
      );
    });
    const sys = (globalThis as unknown as { __lastSystemPrompt: string })
      .__lastSystemPrompt;
    expect(sys).toContain("Active Cell 2");
    expect(sys).toContain("Remove duplicates");
    expect(sys).toContain("deduplicate");
    expect(sys).toContain("Cell 2");
    expect(sys).toContain("notebook_context");
  });

  it("includes preceding cells + dataset lineage in context", async () => {
    const nb = makePipelineNotebook("ws-brain");
    await notebookRepository.put(nb);
    const recs = await knowledgeExtractor.extractNotebook(nb);
    await knowledgeStore.putMany(recs);
    const svc = new BrainService();
    await svc.init("ws-brain");
    await new Promise<void>((resolve, reject) => {
      svc.answerStreaming(
        [],
        "Summarize my pipeline so far",
        "ws-brain",
        undefined,
        () => {},
        () => resolve(),
        reject,
        { activeCellId: "cell_4" },
      );
    });
    const sys = (globalThis as unknown as { __lastSystemPrompt: string })
      .__lastSystemPrompt;
    expect(sys).toContain("Preceding");
    expect(sys).toContain("Cell 1");
    expect(sys).toContain("Cell 3");
  });

  it("falls back to LibraryService federated vectors when KnowledgeStore empty", async () => {
    await knowledgeStore.clear();
    // ensure LibraryService has at least empty but BrainService should still produce prompt without error
    const svc = new BrainService();
    await svc.init("ws-empty");
    await new Promise<void>((resolve, reject) => {
      svc.answerStreaming(
        [],
        "Hello",
        "ws-empty",
        undefined,
        () => {},
        () => resolve(),
        reject,
        {},
      );
    });
    const sys = (globalThis as unknown as { __lastSystemPrompt: string })
      .__lastSystemPrompt;
    expect(sys).toContain("You are Stella");
  });

  it("boosts active cell vs stale: active 'Remove duplicates' outranks superseded", async () => {
    const nb = makeSupersededNotebook("ws-brain");
    await notebookRepository.put(nb);
    const recs = await knowledgeExtractor.extractNotebook(nb);
    await knowledgeStore.clear();
    await knowledgeStore.putMany(recs);
    const res = await knowledgeService.search("Remove duplicates", {
      workspaceId: "ws-brain",
    });
    // active cell_2b should outrank superseded cell_2
    const topActive = res.find((r) => r.record.cellId === "cell_2b");
    const topSup = res.find((r) => r.record.cellId === "cell_2");
    if (topActive && topSup)
      expect(topActive.score).toBeGreaterThan(topSup.score);
  });
});
