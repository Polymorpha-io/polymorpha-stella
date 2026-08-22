/**
 * G24: Checked CacheService T3 (datasets/blobs, hash→Dataset) — embeddings are Float32Array vectors keyed by modelVersion+textHash, not Datasets; reusing CacheService would conflate 50MB dataset quota with 20MB vector quota and pollute LRU. Thin dedicated IDB mirrors CacheService LRU/inflight/openDB patterns.
 */
import type { EmbeddingEntry } from "./types";

const DB_NAME = "polymorpha-embeddings";
const DB_VERSION = 1;
const STORE = "embeddings";
const MAX_ENTRIES = 10000;
const MAX_BYTES = 20 * 1024 * 1024; // ~20MB vectors

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "embeddingKey" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function estimateBytes(entry: EmbeddingEntry): number {
  return entry.vector.byteLength + 200;
}

export class EmbeddingCache {
  async get(embeddingKey: string): Promise<EmbeddingEntry | null> {
    try {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const t = db.transaction(STORE, "readonly");
        const req = t.objectStore(STORE).get(embeddingKey);
        req.onsuccess = () => {
          const val = (req.result as EmbeddingEntry) ?? null;
          if (
            val &&
            val.vector instanceof Float32Array === false &&
            ArrayBuffer.isView(val.vector)
          ) {
            // IDB may return ArrayBuffer-backed object; coerce
            val.vector = new Float32Array(
              (val.vector as unknown as ArrayBuffer).slice
                ? (val.vector as unknown as Float32Array)
                : (val.vector as Float32Array),
            );
          }
          resolve(val);
        };
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      });
    } catch {
      return null;
    }
  }

  async set(entry: EmbeddingEntry): Promise<void> {
    entry.lastAccessedAt = Date.now();
    entry.createdAt = entry.createdAt || Date.now();
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, "readwrite");
      t.objectStore(STORE).put(entry);
      t.oncomplete = () => {
        db.close();
        resolve();
      };
      t.onerror = () => {
        db.close();
        reject(t.error);
      };
    });
    // opportunistic LRU trim
    this.trimIfNeeded().catch(() => {});
  }

  async setMany(entries: EmbeddingEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const now = Date.now();
    for (const e of entries) {
      e.lastAccessedAt = now;
      e.createdAt = e.createdAt || now;
    }
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, "readwrite");
      const s = t.objectStore(STORE);
      for (const e of entries) s.put(e);
      t.oncomplete = () => {
        db.close();
        resolve();
      };
      t.onerror = () => {
        db.close();
        reject(t.error);
      };
    });
    this.trimIfNeeded().catch(() => {});
  }

  async touch(embeddingKey: string): Promise<void> {
    const e = await this.get(embeddingKey);
    if (!e) return;
    e.lastAccessedAt = Date.now();
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, "readwrite");
      t.objectStore(STORE).put(e);
      t.oncomplete = () => {
        db.close();
        resolve();
      };
      t.onerror = () => {
        db.close();
        reject(t.error);
      };
    });
  }

  async has(embeddingKey: string): Promise<boolean> {
    const v = await this.get(embeddingKey);
    return !!v;
  }

  async invalidate(embeddingKey: string): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, "readwrite");
      t.objectStore(STORE).delete(embeddingKey);
      t.oncomplete = () => {
        db.close();
        resolve();
      };
      t.onerror = () => {
        db.close();
        reject(t.error);
      };
    });
  }

  async clear(): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, "readwrite");
      t.objectStore(STORE).clear();
      t.oncomplete = () => {
        db.close();
        resolve();
      };
      t.onerror = () => {
        db.close();
        reject(t.error);
      };
    });
  }

  private async trimIfNeeded(): Promise<void> {
    const db = await openDb();
    const all: EmbeddingEntry[] = await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, "readonly");
      const req = t.objectStore(STORE).getAll();
      req.onsuccess = () => resolve((req.result as EmbeddingEntry[]) || []);
      req.onerror = () => reject(req.error);
      t.oncomplete = () => db.close();
    });
    if (all.length <= MAX_ENTRIES) {
      let total = 0;
      for (const e of all) total += estimateBytes(e);
      if (total <= MAX_BYTES) return;
    }
    // LRU by lastAccessedAt
    all.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
    const targetCount = Math.floor(MAX_ENTRIES * 0.8);
    const toRemove = all.slice(0, Math.max(0, all.length - targetCount));
    if (toRemove.length === 0) return;
    const db2 = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db2.transaction(STORE, "readwrite");
      const s = t.objectStore(STORE);
      for (const r of toRemove) s.delete(r.embeddingKey);
      t.oncomplete = () => {
        db2.close();
        resolve();
      };
      t.onerror = () => {
        db2.close();
        reject(t.error);
      };
    });
  }

  async count(): Promise<number> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, "readonly");
      const req = t.objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      t.oncomplete = () => db.close();
    });
  }
}

export const embeddingCache = new EmbeddingCache();
