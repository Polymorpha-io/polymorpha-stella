import { TEST_GROUPS, TEST_META } from "@polymorpha/business-logic";
import type { TestGroup } from "@polymorpha/business-logic";

/** Re-exported so consumers (and tests) have one gateway to catalog data. */
export { TEST_GROUPS, TEST_META };
export type { TestGroup };

/**
 * Functionalities corpus — the machine-readable source for Stella's
 * "what can Polymorpha do / which method should I use" answers (G15b).
 *
 * Sourcing rule (dependency direction is stella → business-logic ONLY):
 * statistical methods come straight from BL `TEST_META`/`TEST_GROUPS`
 * (zero drift by construction — new BL tests appear automatically);
 * wrangle/guide entries are coarse, hand-written overlays limited to
 * UI-panel names verified in `polymorpha` source, so they cannot rot on
 * per-method renames. Per-method UI paths / purposes live in polymorpha's
 * `catalog.ts` (richer) — this corpus intentionally stays family-level.
 *
 * G31: methods on the catalog UNVERIFIED list (see
 * `polymorpha/statistical-functionalities/README.md`) are flagged
 * experimental here until their status flips.
 */

/** Bump when the corpus shape changes (cache/version gate for consumers). */
export const FUNCTIONALITY_CORPUS_VERSION = "v1";

/** Mirrors the catalog UNVERIFIED list — experimental until verified. */
export const UNVERIFIED_FUNCTIONALITIES: readonly string[] = [
  "tost",
  "regression",
  "partialCorrelation",
];

/** Verified Analyse-panel anchors (match `catalog.ts` uiPath prefixes). */
const GROUP_UI_PATH: Record<TestGroup, string> = {
  compare: "Analyse → Tests → Parametric",
  rankBased: "Analyse → Tests → Non-Parametric",
  categorical: "Analyse → Tests → Non-Parametric",
  association: "Analyse → Correlation",
  modeling: "Analyse → Tests → Modelling",
  distribution: "Analyse → Diagnostics",
  spread: "Analyse → Diagnostics",
  regDx: "Analyse → Diagnostics",
  remedies: "Analyse → Diagnostics",
  posthoc: "Analyse → Post-hoc",
  padjust: "Analyse → Diagnostics",
};

export interface FunctionalityItem {
  /** Short id used in `[functionality:<id>]` citations. */
  id: string;
  kind: "functionality" | "guide";
  name: string;
  family: string;
  /** Embedded + shown text — one record, no splits (document chunking). */
  text: string;
  uiPath: string;
  verified: boolean;
}

type Overlay = {
  id: string;
  kind: "functionality" | "guide";
  name: string;
  family: string;
  text: string;
  uiPath: string;
};

/**
 * Hand-written overlays — coarse families and guides only. Tab/panel names
 * verified against `ModellerInspector.tsx` (InspectorTab) and `catalog.ts`
 * uiPath prefixes. No thresholds, no method claims (G30).
 */
const OVERLAYS: Overlay[] = [
  {
    id: "wrangle-filter",
    kind: "functionality",
    name: "Filter rows",
    family: "Clean",
    text: "Filter rows: keep rows matching a value list, comparison, range, or top-N selection. Runs as a query step in the pipeline. Find it in Polymorpha: Data Modeller → Clean.",
    uiPath: "Data Modeller → Clean",
  },
  {
    id: "wrangle-group",
    kind: "functionality",
    name: "Summarize (group by)",
    family: "Structure",
    text: "Summarize: group rows by columns with sum, mean, count and other aggregations, plus an optional having filter. Find it in Polymorpha: Data Modeller → Structure.",
    uiPath: "Data Modeller → Structure",
  },
  {
    id: "wrangle-reshape",
    kind: "functionality",
    name: "Reshape tables",
    family: "Structure",
    text: "Reshape tables: pivot, unpivot (melt), explode list cells, cross counts. Find it in Polymorpha: Data Modeller → Structure.",
    uiPath: "Data Modeller → Structure",
  },
  {
    id: "wrangle-combine",
    kind: "functionality",
    name: "Combine datasets",
    family: "Combine",
    text: "Combine datasets: merge (join on keys), stack rows (concat), lookup join against a second file. Find it in Polymorpha: Data Modeller → Combine.",
    uiPath: "Data Modeller → Combine",
  },
  {
    id: "wrangle-clean",
    kind: "functionality",
    name: "Clean values",
    family: "Clean",
    text: "Clean values: new columns from expressions, find and replace, recode values, numeric encoding, datetime parsing, missing-value handling. Find it in Polymorpha: Data Modeller → Clean.",
    uiPath: "Data Modeller → Clean",
  },
  {
    id: "wrangle-enrich",
    kind: "functionality",
    name: "Enrich columns",
    family: "Enrich",
    text: "Enrich columns: binning, rolling and expanding windows, shifts, diffs, date resampling. Find it in Polymorpha: Data Modeller → Enrich.",
    uiPath: "Data Modeller → Enrich",
  },
  {
    id: "wrangle-export",
    kind: "functionality",
    name: "Export reports",
    family: "Export",
    text: "Export reports: PDF, Word and Excel reports, plus a .py / .ipynb replay of the click-through recipe. Find it in Polymorpha: Export.",
    uiPath: "Export",
  },
  {
    id: "guide-polymorpha",
    kind: "guide",
    name: "What is Polymorpha",
    family: "Getting started",
    text: "Polymorpha is a browser statistics and data-cleaning tool: upload a CSV or Excel file, auto-clean it, run statistical tests, export reports. No code needed; every step can replay as pandas. Pipeline: Upload → Data Modeller → Analyse → Export.",
    uiPath: "Upload",
  },
  {
    id: "guide-upload",
    kind: "guide",
    name: "Upload data",
    family: "Getting started",
    text: "Upload data: drop a CSV or Excel file on Upload. Anonymous uploads are capped; sign in for larger files and saved workspaces. Start at: Upload.",
    uiPath: "Upload",
  },
  {
    id: "guide-modeller",
    kind: "guide",
    name: "Model data",
    family: "Getting started",
    text: "Model data: the Data Modeller shows a live preview grid with per-column filter pills and an inspector (Structure, Combine, Clean, Enrich tabs) for wrangle steps. Start at: Data Modeller.",
    uiPath: "Data Modeller",
  },
  {
    id: "guide-analyse",
    kind: "guide",
    name: "Analyse data",
    family: "Getting started",
    text: "Analyse data: descriptives, statistical tests, correlation, charts and machine learning live in the Analyse panel, with a recommend flow per stage. Start at: Analyse.",
    uiPath: "Analyse",
  },
  {
    id: "guide-export",
    kind: "guide",
    name: "Export results",
    family: "Getting started",
    text: "Export results: reports as PDF, Word or Excel, plus the recipe as .py or .ipynb notebook. Start at: Export.",
    uiPath: "Export",
  },
];

/**
 * Build the full corpus: one record per BL test + static overlays.
 * Pure and total — safe to call per search (small set) or once and cache.
 */
export function buildFunctionalityCorpus(): FunctionalityItem[] {
  const groupLabel = new Map(TEST_GROUPS.map((g) => [g.id, g.label]));
  const out: FunctionalityItem[] = [];
  for (const [key, meta] of Object.entries(TEST_META)) {
    const group = (meta as { group: TestGroup }).group;
    const label = (meta as { label: string }).label;
    const summary = (meta as { summary: string }).summary;
    const verified = !(
      UNVERIFIED_FUNCTIONALITIES as readonly string[]
    ).includes(key);
    const uiPath = GROUP_UI_PATH[group] ?? "Analyse";
    out.push({
      id: key,
      kind: "functionality",
      name: label,
      family: groupLabel.get(group) ?? group,
      text:
        `${label} (${groupLabel.get(group) ?? group}). ${summary}` +
        ` Find it in Polymorpha: ${uiPath}.` +
        (verified ? "" : " Note: experimental — verification pending."),
      uiPath,
      verified,
    });
  }
  for (const o of OVERLAYS) {
    out.push({ ...o, verified: true });
  }
  return out;
}

/** Citation-chip lookup for UI layers: id → { label, uiPath }. */
export function functionalityLookup(): Record<
  string,
  { label: string; uiPath: string }
> {
  const map: Record<string, { label: string; uiPath: string }> = {};
  for (const item of buildFunctionalityCorpus()) {
    map[item.id] = { label: item.name, uiPath: item.uiPath };
  }
  return map;
}
