import type { Dataset } from "@/types";
import type {
  DatasetLevelProfile,
  PerColumnProfile,
  MissingProfile,
  DuplicateProfile,
  QualityProfile,
} from "./types";

// helpers

function isMissing(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  const s = String(v).trim();
  return (
    s === "" ||
    s.toLowerCase() === "n/a" ||
    s.toLowerCase() === "null" ||
    s.toLowerCase() === "none" ||
    s.toLowerCase() === "unknown" ||
    s === "-" ||
    s.toLowerCase() === "not available"
  );
}

function estimateFileSize(dataset: Dataset): number {
  // rough: rows * cols * avg 8 bytes
  return dataset.rows.length * Math.max(1, dataset.columns.length) * 8;
}

// 1. dataset-level
export function pipelineDataset(dataset: Dataset): DatasetLevelProfile {
  const rows = dataset.rows.length;
  const cols = dataset.columns.length;
  const columnCountByType: Record<string, number> = {};
  for (const c of dataset.columns) {
    columnCountByType[c.type] = (columnCountByType[c.type] ?? 0) + 1;
  }
  // duplicate rows (sample up to 5k for perf)
  const sample = rows > 5000 ? dataset.rows.slice(0, 5000) : dataset.rows;
  const seen = new Set<string>();
  let dup = 0;
  for (const r of sample) {
    const key = JSON.stringify(r);
    if (seen.has(key)) dup++;
    else seen.add(key);
  }
  const duplicatePct = sample.length ? (dup / sample.length) * 100 : 0;

  let emptyRows = 0;
  let emptyCols = 0;
  const colEmptyCounts = new Map<string, number>();
  for (const c of dataset.columns) colEmptyCounts.set(c.name, 0);

  for (const r of dataset.rows) {
    let rowEmpty = true;
    for (const c of dataset.columns) {
      const v = r[c.name];
      const miss = isMissing(v);
      if (miss) colEmptyCounts.set(c.name, (colEmptyCounts.get(c.name) ?? 0) + 1);
      else rowEmpty = false;
    }
    if (rowEmpty) emptyRows++;
  }
  for (const [, cnt] of colEmptyCounts) if (cnt === rows) emptyCols++;

  // constant cols: unique ==1 and not all missing
  const constantCols: string[] = [];
  for (const c of dataset.columns) {
    const uniq = new Set<string>();
    for (const r of dataset.rows) {
      const v = r[c.name];
      if (isMissing(v)) continue;
      uniq.add(String(v));
      if (uniq.size > 1) break;
    }
    if (uniq.size === 1) constantCols.push(c.name);
  }

  return {
    rows,
    cols,
    fileSizeEstimate: estimateFileSize(dataset),
    columnCountByType,
    duplicateRows: dup,
    duplicatePct: Math.round(duplicatePct * 100) / 100,
    emptyRows,
    emptyCols,
    constantCols,
    format: dataset.fileName.split(".").pop()?.toLowerCase() ?? "unknown",
  };
}

// 2. per-column
export function pipelinePerColumn(dataset: Dataset): PerColumnProfile[] {
  const out: PerColumnProfile[] = [];
  for (const col of dataset.columns) {
    const vals: unknown[] = dataset.rows.map((r) => r[col.name]);
    const nonMissing = vals.filter((v) => !isMissing(v));
    const missing = vals.length - nonMissing.length;
    const missingPct = vals.length ? (missing / vals.length) * 100 : 0;
    const uniq = new Set(nonMissing.map((v) => String(v))).size;
    const cardinalityRatio = vals.length ? uniq / vals.length : 0;

    const base: PerColumnProfile = {
      name: col.name,
      type: col.type,
      detectedType: col.detectedType,
      unique: uniq,
      cardinalityRatio: Math.round(cardinalityRatio * 1000) / 1000,
      missing,
      missingPct: Math.round(missingPct * 100) / 100,
    };

    if (col.type === "numeric") {
      const nums = nonMissing
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n));
      if (nums.length) {
        nums.sort((a, b) => a - b);
        const n = nums.length;
        const mean = nums.reduce((a, b) => a + b, 0) / n;
        const median =
          n % 2 === 0
            ? (nums[n / 2 - 1] + nums[n / 2]) / 2
            : nums[Math.floor(n / 2)];
        // mode
        const freq = new Map<number, number>();
        for (const v of nums) freq.set(v, (freq.get(v) ?? 0) + 1);
        let mode: number | null = null;
        let maxC = 0;
        for (const [k, c] of freq) if (c > maxC) { maxC = c; mode = k; }
        const q1 = nums[Math.floor(n * 0.25)];
        const q3 = nums[Math.floor(n * 0.75)];
        const iqr = q3 - q1;
        const variance =
          n > 1
            ? nums.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)
            : 0;
        const std = Math.sqrt(variance);
        const skewness =
          n >= 3 && std !== 0
            ? nums.reduce((s, v) => s + ((v - mean) / std) ** 3, 0) / n
            : 0;
        const kurtosis =
          n >= 3 && std !== 0
            ? nums.reduce((s, v) => s + ((v - mean) / std) ** 4, 0) / n - 3
            : 0;
        Object.assign(base, {
          mean: Math.round(mean * 1000) / 1000,
          median: Math.round(median * 1000) / 1000,
          mode,
          min: nums[0],
          max: nums[n - 1],
          range: Math.round((nums[n - 1] - nums[0]) * 1000) / 1000,
          std: Math.round(std * 1000) / 1000,
          variance: Math.round(variance * 1000) / 1000,
          q1: Math.round(q1 * 1000) / 1000,
          q3: Math.round(q3 * 1000) / 1000,
          iqr: Math.round(iqr * 1000) / 1000,
          skewness: Math.round(skewness * 1000) / 1000,
          kurtosis: Math.round(kurtosis * 1000) / 1000,
        });
      }
    } else {
      // categorical
      const counts = new Map<string, number>();
      for (const v of nonMissing) {
        const s = String(v);
        counts.set(s, (counts.get(s) ?? 0) + 1);
      }
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
      const topK = sorted.map(([value, count]) => ({
        value,
        count,
        pct: Math.round((count / Math.max(1, nonMissing.length)) * 10000) / 100,
      }));
      // entropy
      let entropy = 0;
      for (const [, c] of counts) {
        const p = c / Math.max(1, nonMissing.length);
        entropy -= p * Math.log2(p);
      }
      Object.assign(base, {
        topK,
        entropy: Math.round(entropy * 100) / 100,
      });
      // mode
      if (sorted[0]) (base as unknown as Record<string, unknown>).mode = sorted[0][0];
    }
    out.push(base);
  }
  return out;
}

// 3. missing
export function pipelineMissing(dataset: Dataset): MissingProfile {
  const perColumn = dataset.columns.map((c) => {
    let miss = 0;
    for (const r of dataset.rows) if (isMissing(r[c.name])) miss++;
    return {
      column: c.name,
      missing: miss,
      missingPct: dataset.rows.length ? (miss / dataset.rows.length) * 100 : 0,
    };
  });
  let totalMissing = 0;
  let maxMissing = 0;
  for (const r of dataset.rows) {
    let cnt = 0;
    for (const c of dataset.columns) if (isMissing(r[c.name])) cnt++;
    totalMissing += cnt;
    if (cnt > maxMissing) maxMissing = cnt;
  }
  const avgMissingPerRow = dataset.rows.length ? totalMissing / dataset.rows.length : 0;
  const highMissingCols = perColumn
    .filter((p) => p.missingPct > 20)
    .map((p) => p.column);

  // missing together correlation (simple phi for top 5 high missing)
  const missingTogether: Array<{ a: string; b: string; correlation: number }> = [];
  const high = perColumn.filter((p) => p.missingPct > 0 && p.missingPct < 100).slice(0, 4);
  for (let i = 0; i < high.length; i++) {
    for (let j = i + 1; j < high.length; j++) {
      const a = high[i].column;
      const b = high[j].column;
      let both = 0, onlyA = 0, onlyB = 0;
      for (const r of dataset.rows) {
        const ma = isMissing(r[a]);
        const mb = isMissing(r[b]);
        if (ma && mb) both++;
        else if (ma) onlyA++;
        else if (mb) onlyB++;
      }
      const n = dataset.rows.length;
      const corr = n ? both / Math.sqrt((both + onlyA) * (both + onlyB) || 1) : 0;
      if (corr > 0.3) missingTogether.push({ a, b, correlation: Math.round(corr * 100) / 100 });
    }
  }

  return {
    perColumn: perColumn.map((p) => ({
      ...p,
      missingPct: Math.round(p.missingPct * 100) / 100,
    })),
    perRow: {
      avgMissingPerRow: Math.round(avgMissingPerRow * 100) / 100,
      maxMissingPerRow: maxMissing,
    },
    highMissingCols,
    missingTogether,
  };
}

// 4. duplicate
export function pipelineDuplicate(dataset: Dataset): DuplicateProfile {
  const rows = dataset.rows.length > 5000 ? dataset.rows.slice(0, 5000) : dataset.rows;
  const seen = new Map<string, number>();
  for (const r of rows) {
    const k = JSON.stringify(r);
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  let dup = 0;
  for (const c of seen.values()) if (c > 1) dup += c - 1;
  const duplicatePct = rows.length ? (dup / rows.length) * 100 : 0;

  const uniqueCols: string[] = [];
  const candidateKeys: string[] = [];
  for (const c of dataset.columns) {
    const uniq = new Set<string>();
    let hasMissing = false;
    for (const r of dataset.rows) {
      const v = r[c.name];
      if (isMissing(v)) { hasMissing = true; continue; }
      uniq.add(String(v));
    }
    const ratio = dataset.rows.length ? uniq.size / dataset.rows.length : 0;
    if (ratio > 0.98 && !hasMissing) uniqueCols.push(c.name);
    if (ratio === 1) candidateKeys.push(c.name);
  }
  // composite keys: naive check for 2-col combos among high cardinality cols (limit)
  const compositeKeys: string[][] = [];
  const highCard = dataset.columns.filter((c) => {
    const uniq = new Set(dataset.rows.map((r) => String(r[c.name] ?? ""))).size;
    return uniq / Math.max(1, dataset.rows.length) > 0.5;
  }).slice(0, 4);
  for (let i = 0; i < highCard.length; i++) {
    for (let j = i + 1; j < highCard.length; j++) {
      const a = highCard[i].name, b = highCard[j].name;
      const seen2 = new Set<string>();
      let dup2 = false;
      for (const r of rows) {
        const k = `${String(r[a])}|${String(r[b])}`;
        if (seen2.has(k)) { dup2 = true; break; }
        seen2.add(k);
      }
      if (!dup2) compositeKeys.push([a, b]);
      if (compositeKeys.length >= 2) break;
    }
  }

  return {
    duplicateRows: dup,
    duplicatePct: Math.round(duplicatePct * 100) / 100,
    candidateKeys: candidateKeys.slice(0, 3),
    compositeKeys,
    uniqueCols,
  };
}

// 5. quality
export function pipelineQuality(dataset: Dataset): QualityProfile {
  const invalid: Array<{ column: string; issue: string; count: number }> = [];
  const mixedTypes = new Set<string>();
  const whitespaceCols = new Set<string>();

  for (const col of dataset.columns) {
    let whitespace = 0;
    const typeSet = new Set<string>();
    let invalidCount = 0;

    for (const r of dataset.rows) {
      const v = r[col.name];
      if (v === null || v === undefined) continue;
      const s = String(v);
      if (s !== s.trim()) whitespace++;
      // type inference
      if (s.trim() !== "" && !isMissing(v)) {
        if (!isNaN(Number(s)) && s.trim() !== "") typeSet.add("numeric");
        else if (/^\d{4}-\d{2}-\d{2}/.test(s) || !isNaN(Date.parse(s))) {
          // naive date check
          if (!isNaN(Date.parse(s))) typeSet.add("date");
        } else typeSet.add("string");
      }
      // invalid checks for numeric cols
      if (col.type === "numeric" && !isMissing(v) && isNaN(Number(v))) {
        // check if it should be numeric but isn't
        if (String(v).trim() !== "") invalidCount++;
      }
    }
    if (whitespace > 0) whitespaceCols.add(col.name);
    if (typeSet.size > 1) mixedTypes.add(col.name);
    if (invalidCount > 0) invalid.push({ column: col.name, issue: "non-numeric in numeric col", count: invalidCount });
  }

  return {
    invalid,
    mixedTypes: [...mixedTypes],
    whitespaceCols: [...whitespaceCols],
  };
}
