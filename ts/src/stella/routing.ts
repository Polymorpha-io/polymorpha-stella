/**
 * Cost/quality model routing: fast 20B by default, strong 120B for queries
 * showing complexity signals. Heuristic and overrideable — explicit model
 * choices and `routeModel:false` always win. Conservative by design: a
 * misfire costs 2× input tokens, never correctness.
 */
import { DEFAULT_GROQ_MODEL, GROQ_STRONG_MODEL, type GroqModel } from "./types";
import {
  STELLA_ROUTE_STRONG_MIN_CHARS,
  STELLA_ROUTE_STRONG_MIN_HISTORY,
} from "../config/retrieval";

const COMPLEX_SIGNALS = [
  /compar|versus|\bvs\.?\b|difference between|trade-?off/i,
  /\?.*\?/, // two or more questions
  /step[- ]by[- ]step|pipeline|workflow|walk ?through/i,
  /regress|multivariate|interaction|mediation|moderation|hierarchical/i,
  /explain.*why|why.*happen|root cause/i,
];

export function routeChatModel(
  query: string,
  historyLength: number,
  fallback: GroqModel = DEFAULT_GROQ_MODEL,
): GroqModel {
  if (fallback !== DEFAULT_GROQ_MODEL) return fallback;
  if (query.length >= STELLA_ROUTE_STRONG_MIN_CHARS) return GROQ_STRONG_MODEL;
  if (historyLength >= STELLA_ROUTE_STRONG_MIN_HISTORY)
    return GROQ_STRONG_MODEL;
  if (COMPLEX_SIGNALS.some((re) => re.test(query))) return GROQ_STRONG_MODEL;
  return DEFAULT_GROQ_MODEL;
}
