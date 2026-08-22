// EmbeddingWorker — thin wrapper, will be moved to Web Worker later.
// For Phase 1, this runs on main thread via same pipeline, but through central service
// so Batch + dedup + cache is already in place. Worker porting is Phase 2 (G21).

import { embed as modelEmbed, loadEmbeddingModel } from "@/stella/models";

let ready = false;

export async function ensureEmbeddingModelLoaded(): Promise<void> {
  if (ready) return;
  await loadEmbeddingModel();
  ready = true;
}

export async function embedSingle(text: string): Promise<Float32Array> {
  await ensureEmbeddingModelLoaded();
  return modelEmbed(text);
}

export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  await ensureEmbeddingModelLoaded();
  // @xenova/transformers does not expose batched pipeline cheaply on main thread;
  // Sequential but through single load. Future worker will batch via tokenizer batch_encode.
  const out: Float32Array[] = [];
  for (const t of texts) {
    // eslint-disable-next-line no-await-in-loop
    const v = await modelEmbed(t);
    out.push(v);
  }
  return out;
}
