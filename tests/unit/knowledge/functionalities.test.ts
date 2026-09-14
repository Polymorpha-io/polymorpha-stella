import { describe, it, expect } from "vitest";
import {
  TEST_GROUPS,
  TEST_META,
  FUNCTIONALITY_CORPUS_VERSION,
  UNVERIFIED_FUNCTIONALITIES,
  buildFunctionalityCorpus,
  functionalityLookup,
} from "@/knowledge/functionalities";
import { FunctionalityKnowledgeProvider } from "@/knowledge/providers/FunctionalityKnowledgeProvider";
import { FUNCTIONALITY_QUERY_TOP } from "@/config/retrieval";

const OVERLAY_COUNT = 12; // 7 wrangle + 5 guide

describe("buildFunctionalityCorpus", () => {
  it("covers every BL test plus static overlays (zero-drift gate)", () => {
    const corpus = buildFunctionalityCorpus();
    expect(corpus.length).toBe(Object.keys(TEST_META).length + OVERLAY_COUNT);
    expect(TEST_GROUPS.length).toBeGreaterThan(0);
  });

  it("emits unique ids with non-empty text and uiPath", () => {
    const corpus = buildFunctionalityCorpus();
    const ids = new Set(corpus.map((c) => c.id));
    expect(ids.size).toBe(corpus.length);
    for (const c of corpus) {
      expect(c.text.length).toBeGreaterThan(20);
      expect(c.uiPath.length).toBeGreaterThan(0);
    }
  });

  it("grounds the t-test record in BL TEST_META", () => {
    const t = buildFunctionalityCorpus().find((c) => c.id === "tTest");
    expect(t?.kind).toBe("functionality");
    expect(t?.name).toBe(TEST_META.tTest.label);
    expect(t?.text).toContain(TEST_META.tTest.summary);
    expect(t?.uiPath).toBe("Analyse → Tests → Parametric");
    expect(t?.verified).toBe(true);
  });

  it("flags UNVERIFIED catalog methods as experimental (G31)", () => {
    const corpus = buildFunctionalityCorpus();
    for (const key of UNVERIFIED_FUNCTIONALITIES) {
      const rec = corpus.find((c) => c.id === key);
      expect(rec, `${key} must exist in TEST_META`).toBeTruthy();
      expect(rec?.verified).toBe(false);
      expect(rec?.text).toMatch(/experimental/i);
    }
  });

  it("exposes a chip lookup for UI layers", () => {
    const lookup = functionalityLookup();
    expect(lookup["anova"]).toEqual({
      label: TEST_META.anova.label,
      uiPath: "Analyse → Tests → Parametric",
    });
    expect(lookup["guide-polymorpha"].label).toBe("What is Polymorpha");
  });
});

describe("FunctionalityKnowledgeProvider", () => {
  const provider = new FunctionalityKnowledgeProvider();

  it("lexically ranks the t-test first for a compare-groups query", async () => {
    const recs = await provider.provide(
      "ws",
      undefined,
      "compare two groups t-test",
    );
    expect(recs.length).toBeGreaterThan(0);
    expect(recs.length).toBeLessThanOrEqual(FUNCTIONALITY_QUERY_TOP);
    expect(recs[0].id).toBe("func::tTest");
    expect(recs[0].kind).toBe("functionality");
    expect(recs[0].workspaceId).toBe("system");
  });

  it("surfaces wrangle + guide records for app questions", async () => {
    const recs = await provider.provide(
      "ws",
      undefined,
      "how do I filter rows",
    );
    expect(recs.some((r) => r.id === "func::wrangle-filter")).toBe(true);
    const guides = await provider.provide(
      "ws",
      undefined,
      "what can polymorpha do upload analyse export",
    );
    expect(guides.some((r) => r.id === "guide::guide-polymorpha")).toBe(true);
  });

  it("caps at FUNCTIONALITY_QUERY_TOP and never throws", async () => {
    const recs = await provider.provide("ws", undefined, "");
    expect(recs.length).toBe(FUNCTIONALITY_QUERY_TOP);
    expect(recs[0].metadata).toMatchObject({ source: "functionality" });
  });

  it("marks corpus version on every record", async () => {
    const recs = await provider.provide("ws", undefined, "anova");
    for (const r of recs) {
      expect(r.metadata["corpusVersion"]).toBe(FUNCTIONALITY_CORPUS_VERSION);
    }
  });
});
