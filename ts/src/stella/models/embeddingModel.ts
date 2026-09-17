import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";
import { EMBED_MODEL, EMBED_CHUNK_TOKENS, EMBED_DIM } from "../../config";
import {
  CHAR_OVERLAP_FALLBACK,
  CHARS_PER_TOKEN,
  TOKEN_OVERLAP,
} from "../../config/chunking";
import {
  EMBED_NORMALIZE,
  EMBED_PIPELINE_TASK,
  EMBED_POOLING,
  EMBED_BATCH_CONCURRENCY,
} from "../../config/models";

let pipe: FeatureExtractionPipeline | null = null;
let tokenizer: unknown | null = null;

let loadingPromise: Promise<void> | null = null;

// ---------------------------------------------------------------------------
// Runtime model config (Phase 4) — StellaConfig injection made live.
// Defaults preserve current behavior (MiniLM 384d/512). Switching models
// resets the loaded pipe (one-time reload cost) and re-namespaces cache
// keys via getEmbeddingModelId(), so swaps invalidate naturally (S14).
// Drop-in upgrade path: { model: "Xenova/bge-small-en-v1.5" } — same 384d,
// ~33MB, no migration. Session-scoped use only (last-write-wins).
// ---------------------------------------------------------------------------

export interface EmbeddingModelConfig {
  model?: string;
  dim?: number;
  chunkTokens?: number;
}

/** Validated context window for the 512-family (MiniLM, BGE-small, MPNet). */
export const MODEL_CONTEXT_TOKENS = 512;

const FAMILY_512 = [/minilm/i, /bge-small/i, /mpnet/i];

let activeModel = EMBED_MODEL;
let activeDim = EMBED_DIM;
let activeChunkTokens = EMBED_CHUNK_TOKENS;

function resetPipe(): void {
  pipe = null;
  tokenizer = null;
  loadingPromise = null;
}

export interface ConfiguredEmbeddings {
  model: string;
  dim: number;
  chunkTokens: number;
}

export function configureEmbeddings(
  cfg: EmbeddingModelConfig,
): ConfiguredEmbeddings {
  if (cfg.model) activeModel = cfg.model;
  if (cfg.dim) activeDim = cfg.dim;
  if (cfg.chunkTokens) {
    const knownFamily = FAMILY_512.some((re) => re.test(activeModel));
    if (knownFamily && cfg.chunkTokens > MODEL_CONTEXT_TOKENS) {
      console.warn(
        `[embeddingModel] chunkTokens ${cfg.chunkTokens} exceeds ${activeModel} context ${MODEL_CONTEXT_TOKENS} — clamped`,
      );
      activeChunkTokens = MODEL_CONTEXT_TOKENS;
    } else {
      activeChunkTokens = cfg.chunkTokens;
    }
  }
  resetPipe();
  return {
    model: activeModel,
    dim: activeDim,
    chunkTokens: activeChunkTokens,
  };
}

/** Restore build-time defaults (tests + session teardown). */
export function resetEmbeddingsToDefault(): void {
  activeModel = EMBED_MODEL;
  activeDim = EMBED_DIM;
  activeChunkTokens = EMBED_CHUNK_TOKENS;
  resetPipe();
}

export async function loadEmbeddingModel(): Promise<void> {
  if (pipe) return;
  if (loadingPromise) return loadingPromise;
  const modelId = activeModel;
  loadingPromise = (async () => {
    pipe = await pipeline(EMBED_PIPELINE_TASK, modelId as never);
    // G24 §8: tokenizer from same library when available — validates chunkTokens per model
    try {
      const mod = await import("@xenova/transformers");
      const AutoTokenizer = (
        mod as unknown as {
          AutoTokenizer?: { from_pretrained: (m: string) => Promise<unknown> };
        }
      ).AutoTokenizer;
      if (AutoTokenizer?.from_pretrained) {
        tokenizer = await AutoTokenizer.from_pretrained(modelId).catch(
          () => null,
        );
      }
    } catch {
      tokenizer = null;
    }
  })();
  return loadingPromise;
}

/**
 * G24 §8 chunking — use tokenizer from embedding library when available,
 * fallback to character-window approximation validated per 384d model.
 * Chunk budget follows the ACTIVE model config (512 for MiniLM/BGE-small).
 */
export function chunkText(
  text: string,
  maxTokens: number = activeChunkTokens,
): string[] {
  if (!text) return [];
  const approxCharsPerToken = CHARS_PER_TOKEN;
  const maxChars = maxTokens * approxCharsPerToken;
  if (text.length <= maxChars) return [text];
  // If tokenizer available with encode, use token boundaries
  try {
    const tok = tokenizer as unknown as {
      encode?: (s: string) => unknown;
    } | null;
    if (tok?.encode) {
      const encoded = tok.encode(text) as unknown;
      const ids: number[] = Array.isArray(encoded)
        ? (encoded as number[])
        : ((encoded as { input_ids?: number[] })?.input_ids ?? []);
      if (ids.length > 0 && ids.length > maxTokens) {
        const chunks: string[] = [];
        // Overlap TOKEN_OVERLAP tokens for continuity G21 sliding window
        const stride = Math.max(1, maxTokens - TOKEN_OVERLAP);
        // Fallback to char slicing aligned to token stride when decode not available
        const decode = (
          tok as unknown as { decode?: (ids: number[]) => string }
        )?.decode;
        if (decode) {
          for (let i = 0; i < ids.length; i += stride) {
            const slice = ids.slice(i, i + maxTokens);
            if (slice.length === 0) break;
            chunks.push(decode.call(tok, slice));
            if (i + maxTokens >= ids.length) break;
          }
          return chunks.length ? chunks : [text];
        }
      }
    }
  } catch {
    // fall through to char window
  }
  const chunks: string[] = [];
  const overlap = CHAR_OVERLAP_FALLBACK;
  const step = Math.max(1, maxChars - overlap);
  for (let i = 0; i < text.length; i += step) {
    chunks.push(text.slice(i, i + maxChars));
    if (i + maxChars >= text.length) break;
  }
  return chunks;
}

export function getEmbeddingDims(): number {
  return activeDim;
}

export function getEmbeddingModelId(): string {
  return activeModel;
}

export async function embed(text: string): Promise<Float32Array> {
  await loadEmbeddingModel();
  const result = await pipe!(text, {
    pooling: EMBED_POOLING,
    normalize: EMBED_NORMALIZE,
  } as never);
  const data = result.data as Float32Array;
  return data.slice();
}

export async function embedMany(texts: string[]): Promise<Float32Array[]> {
  await loadEmbeddingModel();
  // Bounded-parallel per-text pipelines (a miss batch of N pays ~N/cap
  // forwards, not N serial). Order-preserving by construction.
  return mapWithConcurrency(texts, embedOne, EMBED_BATCH_CONCURRENCY);
}

/**
 * Parallel map with a concurrency cap. Results keep input order
 * (indexed write-back); the first rejection rejects the batch.
 */
export async function mapWithConcurrency<T, U>(
  items: T[],
  fn: (item: T, index: number) => Promise<U>,
  cap: number = EMBED_BATCH_CONCURRENCY,
): Promise<U[]> {
  const limit = Math.max(1, Math.floor(cap));
  const out = new Array<U>(items.length);
  for (let start = 0; start < items.length; start += limit) {
    const batch = items.slice(start, start + limit);
    const vectors = await Promise.all(
      batch.map((item, m) => fn(item, start + m)),
    );
    vectors.forEach((v, m) => {
      out[start + m] = v;
    });
  }
  return out;
}

async function embedOne(text: string): Promise<Float32Array> {
  const chunks = chunkText(text);
  if (chunks.length === 1) return embed(chunks[0]);
  // average chunk embeddings for long texts G21 512 window
  const embs = await Promise.all(chunks.map((c) => embed(c)));
  const dim = embs[0]?.length ?? activeDim;
  const avg = new Float32Array(dim);
  for (const e of embs)
    for (let i = 0; i < dim; i++) avg[i] += e[i] / embs.length;
  // re-normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += avg[i] * avg[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dim; i++) avg[i] /= norm;
  return avg;
}
