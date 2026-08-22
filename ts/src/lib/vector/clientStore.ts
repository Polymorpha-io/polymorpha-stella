/**
 * clientStore — G21 CacheService pattern reuse for vectors.
 * Mirrors CacheService T3 openDB/LRU/cross-tab but indexed by uid:vector:contentHash:chunkId
 * Separate quota 20MB from datasets 50MB to avoid LRU pollution (G18).
 */
import { EMBED_VECTOR_MAX_BYTES, EMBED_VECTOR_MAX_ENTRIES } from "@/config";
import type { VectorRecord } from "./VectorStore";

const DB_NAME = "polymorpha-vectors";
const DB_VERSION = 1;
const STORE = "vectors";

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
        const s = db.createObjectStore(STORE, { keyPath: "key" });
        s.createIndex("by_uid", "uid", { unique: false });
        s.createIndex("by_contentHash", "contentHash", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB blocked"));
  });
}

type Stored = VectorRecord & { key: string; uid: string; ts: number };

function vectorKey(uid: string, contentHash: string, chunkId: string): string {
  return `${uid}:vector:${contentHash}:${chunkId}`;
}

function estimateBytes(rec: VectorRecord): number {
  return (rec.embedding?.byteLength ?? 0) + rec.text.length * 2 + 300;
}

export async function putVectors(
  uid: string,
  vectors: VectorRecord[],
): Promise<void> {
  if (vectors.length === 0) return;
  const db = await openDb();
  const now = Date.now();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const v of vectors) {
      const key = vectorKey(uid, v.contentHash, v.id);
      const stored: Stored = {
        ...v,
        // IDB can store Float32Array directly but clone via Array.from for safety
        embedding: v.embedding.slice() as Float32Array,
        key,
        uid,
        ts: now,
      };
      store.put(stored);
    }
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
  trimIfNeeded().catch(() => {});
}

export async function getVectors(
  uid: string,
  contentHash: string,
  chunkIds: string[],
): Promise<VectorRecord[]> {
  const db = await openDb();
  const results: VectorRecord[] = [];
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    let pending = chunkIds.length;
    if (pending === 0) {
      resolve();
      return;
    }
    for (const chunkId of chunkIds) {
      const key = vectorKey(uid, contentHash, chunkId);
      const req = store.get(key);
      req.onsuccess = () => {
        const val = req.result as Stored | undefined;
        if (val) {
          // touch LRU
          results.push({
            id: val.id,
            datasetId: val.datasetId,
            uploadId: val.uploadId,
            contentHash: val.contentHash,
            chunkHash: val.chunkHash,
            text: val.text,
            embedding: val.embedding,
            kind: val.kind,
            sample: val.sample,
            workspaceId: val.workspaceId,
          });
        }
        pending--;
        if (pending === 0) resolve();
      };
      req.onerror = () => {
        pending--;
        if (pending === 0) resolve();
      };
    }
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
  // touch
  touchMany(chunkIds.map((c) => vectorKey(uid, contentHash, c))).catch(
    () => {},
  );
  return results;
}

async function touchMany(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      let pending = keys.length;
      for (const k of keys) {
        const req = store.get(k);
        req.onsuccess = () => {
          const val = req.result as Stored | undefined;
          if (val) {
            val.ts = Date.now();
            store.put(val);
          }
          pending--;
          if (pending === 0) resolve();
        };
        req.onerror = () => {
          pending--;
          if (pending === 0) resolve();
        };
      }
      tx.oncomplete = () => db.close();
      tx.onerror = () => {
        db.close();
        resolve();
      };
    });
  } catch {}
}

export async function getAllByUid(uid: string): Promise<VectorRecord[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const idx = tx.objectStore(STORE).index("by_uid");
    const req = idx.getAll(uid);
    req.onsuccess = () => {
      const vals = (req.result as Stored[]) ?? [];
      resolve(
        vals.map((v) => ({
          id: v.id,
          datasetId: v.datasetId,
          uploadId: v.uploadId,
          contentHash: v.contentHash,
          chunkHash: v.chunkHash,
          text: v.text,
          embedding: v.embedding,
          kind: v.kind,
          sample: v.sample,
          workspaceId: v.workspaceId,
        })),
      );
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

export async function getAllByWorkspace(
  uid: string,
  workspaceId: string,
): Promise<VectorRecord[]> {
  const all = await getAllByUid(uid);
  return all.filter((r) => r.workspaceId === workspaceId);
}

export async function deleteByContentHash(
  uid: string,
  contentHash: string,
): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const idx = store.index("by_contentHash");
    const req = idx.openCursor(IDBKeyRange.only(contentHash));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        const val = cursor.value as Stored;
        if (val.uid === uid) cursor.delete();
        cursor.continue();
      } else resolve();
    };
    req.onerror = () => resolve();
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      resolve();
    };
  });
}

async function trimIfNeeded(): Promise<void> {
  const db = await openDb();
  const all: Stored[] = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve((req.result as Stored[]) || []);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
  if (all.length <= EMBED_VECTOR_MAX_ENTRIES) {
    let total = 0;
    for (const e of all) total += estimateBytes(e as VectorRecord);
    if (total <= EMBED_VECTOR_MAX_BYTES) return;
  }
  all.sort((a, b) => a.ts - b.ts);
  const targetCount = Math.floor(EMBED_VECTOR_MAX_ENTRIES * 0.8);
  const overCount = Math.max(0, all.length - targetCount);
  const toRemove = all.slice(0, overCount);
  if (toRemove.length === 0) {
    // byte-based eviction
    let total = 0;
    for (const e of all) total += estimateBytes(e as VectorRecord);
    if (total <= EMBED_VECTOR_MAX_BYTES) return;
    let removed = 0;
    for (const e of all) {
      removed += estimateBytes(e as VectorRecord);
      toRemove.push(e);
      if (total - removed <= EMBED_VECTOR_MAX_BYTES * 0.5) break;
    }
  }
  if (toRemove.length === 0) return;
  const db2 = await openDb();
  await new Promise<void>((resolve) => {
    const tx = db2.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const r of toRemove) store.delete(r.key);
    tx.oncomplete = () => {
      db2.close();
      resolve();
    };
    tx.onerror = () => {
      db2.close();
      resolve();
    };
  });
}

export async function clearAll(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
