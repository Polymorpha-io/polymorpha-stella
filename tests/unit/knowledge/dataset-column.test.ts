/**
 * G22 Central contract — mirrors polymorpha-tests/suites/polymorpha/knowledge/dataset-column.test.ts
 * This local copy is transition-only; CI resolves GitHub polymorpha-tests as source of truth.
 * Contract: KnowledgeRecord.kind column_semantic / dataset_profile per corrected plan + G25/G26.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useDataStore } from "@/store/useDataStore";
import { useRagStore } from "@/store/useRagStore";
import { knowledgeStore } from "@/knowledge/KnowledgeStore";
import { datasetKnowledgeProvider } from "@/knowledge/providers/DatasetKnowledgeProvider";
import { knowledgeService } from "@/knowledge/KnowledgeService";
import type { Dataset } from "@/types";

function makeDataset(cols: string[], rowsLen = 10, fileName = "clean_dataset.csv"): Dataset {
  return {
    fileName,
    uploadedAt: new Date(),
    columns: cols.map((name) => ({ name, type: "numeric" as const, detectedType: "numeric" as const })),
    rows: Array.from({ length: rowsLen }, (_, i) =>
      Object.fromEntries(cols.map((c) => [c, i + Math.random()])),
    ),
  };
}

function make30ColDataset(): Dataset {
  const cols = Array.from({ length: 30 }, (_, i) => `col_${i + 1}`);
  return makeDataset(cols, 20, "wide30.csv");
}

beforeEach(async () => {
  await knowledgeStore.clear().catch(() => {});
  useDataStore.getState().reset();
  useRagStore.getState().reset();
});

describe("DatasetKnowledgeProvider — column_semantic one vector per column (G22)", () => {
  it("header-only before profile: query 'What is the Age column?' returns column_semantic provenance.columns ['Age']", async () => {
    const ws = "ws-test-1";
    const ds = makeDataset(["Age", "Debt", "Status"], 10, "sales.csv");
    ds.columns[2]!.type = "categorical";
    ds.columns[2]!.detectedType = "categorical";
    useDataStore.setState({ raw: ds, uploadId: "up1", rawHash: "h1", objective: null } as never);
    useRagStore.setState({ byDataset: new Map() } as never);

    const recs = await datasetKnowledgeProvider.provide(ws);
    await knowledgeStore.putMany(recs);

    const res = await knowledgeService.search("What is the Age column?", { workspaceId: ws, limit: 5 });
    const hit = res.find((r) => r.record.kind === "column_semantic" && r.record.provenance.columns?.includes("Age"));
    expect(hit).toBeDefined();
    expect(hit!.record.provenance.columns).toEqual(["Age"]);
    expect(hit!.record.metadata.semanticLevel).toBe("schema");
    expect(hit!.record.metadata.profileStatus).toBe("pending");
    expect((hit!.record.metadata as unknown as { sampleCoverage?: unknown }).sampleCoverage).toBeUndefined();
  });

  it("30-column coverage: query 'What columns are available?' all 30 indexable, no +18 sentinel", async () => {
    const ws = "ws-wide";
    const ds = make30ColDataset();
    useDataStore.setState({ raw: ds, uploadId: "up-wide", rawHash: "hwide" } as never);
    useRagStore.setState({ byDataset: new Map() } as never);

    const recs = await datasetKnowledgeProvider.provide(ws);
    const colRecs = recs.filter((r) => r.kind === "column_semantic");
    expect(colRecs).toHaveLength(30);
    expect(recs.some((r) => r.text.includes("+") && r.text.includes("more columns"))).toBe(false);
    await knowledgeStore.putMany(recs);
    const res = await knowledgeService.search("What columns are available?", { workspaceId: ws, limit: 30 });
    const colHits = res.filter((r) => r.record.kind === "column_semantic");
    expect(colHits.length).toBeGreaterThanOrEqual(10);
    expect(colRecs.some((r) => r.provenance.columns?.includes("col_30"))).toBe(true);
  });

  it("profile upgrade: header-only superseded by profile-rich, no duplicate", async () => {
    const ws = "ws-upgrade";
    const ds = makeDataset(["Age", "Debt"], 690, "clean_dataset.csv");
    useDataStore.setState({ raw: ds, uploadId: "up-upgrade", rawHash: "hup" } as never);
    useRagStore.setState({ byDataset: new Map() } as never);

    let recs = await datasetKnowledgeProvider.provide(ws);
    await knowledgeStore.putMany(recs);
    let before = await knowledgeStore.getAll();
    const headerOnly = before.find((r) => r.id === "dataset:up-upgrade:col:Age");
    expect(headerOnly!.metadata.semanticLevel).toBe("schema");
    expect(headerOnly!.text).toBe('Column "Age" is numeric');

    const perColumn = [
      {
        name: "Age",
        type: "numeric",
        detectedType: "numeric",
        unique: 482,
        cardinalityRatio: 0.7,
        missing: 8,
        missingPct: 1.2,
        mean: 35.2,
        median: 34,
        std: 10,
        skewness: 2.9,
      },
      {
        name: "Debt",
        type: "numeric",
        detectedType: "numeric",
        unique: 400,
        cardinalityRatio: 0.58,
        missing: 0,
        missingPct: 0,
        mean: 100,
        median: 90,
        std: 20,
        skewness: 0.5,
      },
    ] as unknown as import("@/lib/rag/types").PerColumnProfile[];
    const map = new Map();
    map.set("up-upgrade", {
      profile: { dataset: { rows: 690, cols: 2, format: "csv", columnCountByType: { numeric: 2 }, duplicateRows: 0, duplicatePct: 0, emptyRows: 0, emptyCols: 0, constantCols: [] }, perColumn, missing: null, duplicate: null, quality: null },
      status: { dataset: "done", perColumn: "done", missing: "done", duplicate: "done", quality: "done" },
      isProfiling: false,
      hash: "hup",
    });
    useRagStore.setState({ byDataset: map } as never);

    recs = await datasetKnowledgeProvider.provide(ws);
    await knowledgeStore.putMany(recs);
    const after = await knowledgeStore.getAll();
    const upgraded = after.find((r) => r.id === "dataset:up-upgrade:col:Age");
    expect(upgraded!.metadata.semanticLevel).toBe("profile");
    expect(upgraded!.metadata.profileStatus).toBe("complete");
    expect(upgraded!.text).toContain("mean 35.2");
    const ids = after.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const res = await knowledgeService.search("Age mean", { workspaceId: ws, limit: 5 });
    expect(res.some((r) => r.record.id === "dataset:up-upgrade:col:Age")).toBe(true);
  });

  it("synthetic dataset_profile: template-only, marked synthetic_description, not empirical", async () => {
    const ws = "ws-synth";
    const ds = makeDataset(["Age", "Debt"], 690, "clean_dataset.csv");
    useDataStore.setState({ raw: ds, uploadId: "up-synth", rawHash: "hsynth", objective: "sales churn" } as never);
    useRagStore.setState({ byDataset: new Map() } as never);
    const recs = await datasetKnowledgeProvider.provide(ws);
    const synth = recs.find((r) => r.id === "dataset:up-synth:description");
    expect(synth).toBeDefined();
    expect(synth!.kind).toBe("dataset_profile");
    expect(synth!.text).toContain('Dataset "clean_dataset.csv" purpose: sales churn');
    expect(synth!.metadata.representation).toBe("synthetic_description");
    expect(synth!.metadata.source).toBe("dataset_metadata");
    expect(synth!.metadata.generated).toBe(false);
    expect((synth!.metadata as unknown as { sampleCoverage?: unknown }).sampleCoverage).toBeUndefined();
  });
});
