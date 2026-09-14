/**
 * Rule-based query expansion for the lexical (BM25) path — no LLM calls.
 * Short stats queries under-specify intent ("sd", "cats"); the dense path
 * keeps the raw query (embedding space), while BM25 searches the expanded
 * bag (abbreviations + singular/plural forms). Added terms are capped to
 * bound query drift. Full LLM multi-query/HyDE stays deferred (Phase 3).
 */
import { tokenizeText } from "./hybridSearch";

/** Stats-domain abbreviations → full forms (whole-word match only). */
export const STATS_ABBREVIATIONS: Record<string, string> = {
  sd: "standard deviation",
  std: "standard deviation",
  se: "standard error",
  ci: "confidence interval",
  anova: "analysis of variance",
  df: "degrees of freedom",
  corr: "correlation",
  rmse: "root mean square error",
  mae: "mean absolute error",
  mse: "mean square error",
  iqr: "interquartile range",
  eda: "exploratory data analysis",
  ml: "machine learning",
  pca: "principal component analysis",
  pdf: "probability density function",
};

/** Singular counterpart for a regular English plural, else null. */
export function singularForm(token: string): string | null {
  if (token.length <= 3) return null;
  if (token.endsWith("ies") && token.length > 4)
    return `${token.slice(0, -3)}y`;
  if (
    token.endsWith("ses") ||
    token.endsWith("xes") ||
    token.endsWith("zes") ||
    token.endsWith("ches") ||
    token.endsWith("shes")
  )
    return token.slice(0, -2);
  if (token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return null;
}

/** Naive plural counterpart, else null (already plural-looking). */
export function pluralForm(token: string): string | null {
  if (token.length <= 3 || token.endsWith("s")) return null;
  if (token.endsWith("y") && token.length > 2)
    return `${token.slice(0, -1)}ies`;
  return `${token}s`;
}

/**
 * Merge extra term bags into a base bag (dedupe + total cap). Used to fold
 * LLM rewrite terms into the rule-expanded bag without a second pass.
 */
export function mergeTermBags(
  base: string,
  extra: string,
  maxTokens = 40,
): string {
  const seen = new Set(tokenizeText(base));
  const merged = tokenizeText(extra).filter((t) => {
    if (seen.has(t) || seen.size >= maxTokens) return false;
    seen.add(t);
    return true;
  });
  return merged.length > 0 ? `${base} ${merged.join(" ")}` : base;
}

/**
 * Original query plus expansion terms (deduped, capped). Returns a
 * space-joined bag for the BM25 path — not prose.
 */
export function expandQueryTerms(query: string, maxAdded = 6): string {
  const original = tokenizeText(query);
  if (original.length === 0) return query;
  const seen = new Set(original);
  const added: string[] = [];
  const push = (term: string) => {
    for (const t of tokenizeText(term)) {
      if (added.length >= maxAdded) return;
      if (!seen.has(t)) {
        seen.add(t);
        added.push(t);
      }
    }
  };
  for (const tok of original) {
    const full = STATS_ABBREVIATIONS[tok];
    if (full) push(full);
    const sing = singularForm(tok);
    if (sing) push(sing);
    else {
      const plur = pluralForm(tok);
      if (plur) push(plur);
    }
  }
  return added.length > 0 ? `${query} ${added.join(" ")}` : query;
}
