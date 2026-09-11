import { hashString, HASH_PREFIX_LEN } from "@polymorpha/business-logic";

/**
 * sourceHash — single canonical content hash for KnowledgeRecord ids.
 *
 * Primary: SHA-256 hex (first 16) via business-logic `hashString` — matches
 * `python/polymorpha_stella/rag/profiler.py` (`hashlib.sha256(...).hexdigest()[:16]`)
 * so TS and Py records for the same input share ids (G21 hash truth).
 * Fallback (WebCrypto unavailable, e.g. non-secure context): djb2 base36.
 * The fallback intentionally diverges — a loud, distinct shape rather than a
 * silent near-match — so mixed-origin stores are detectable, never merged.
 */
export async function sourceHash(text: string): Promise<string> {
  try {
    const hex = await hashString(text);
    return hex.slice(0, HASH_PREFIX_LEN);
  } catch {
    let h = 5381;
    for (let i = 0; i < text.length; i++)
      h = (Math.imul(33, h) ^ text.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }
}
