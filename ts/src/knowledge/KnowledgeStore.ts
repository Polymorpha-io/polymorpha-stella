/**
 * G24: Checked CacheService + existing knowledge via UserLibrary chunks — CacheService lacks indexes (by_workspace/by_notebook/by_cell/by_sourceHash) required for provenance queries. Custom IDB with indexes justified; mirrors CacheService openDB/versioning and garbage-collection principles. No vector DB needed for small corpus.
 * v2: adds by_dataset / by_column (provenance) multiEntry indexes for single retrieval plane.
 */
import type { KnowledgeRecord, KnowledgeStoreRecord } from "./types";
import { normalizeKind } from "./types";

const DB_NAME = "polymorpha-knowledge";
const DB_VERSION = 2;
const STORE = "knowledge";

function normalizeRecord(raw: KnowledgeRecord): KnowledgeRecord {
  const kind = normalizeKind(raw.kind as string);
  // Migrate legacy metadata.datasetId / missing provenance to typed provenance
  const prov =
    (raw as unknown as { provenance?: KnowledgeRecord["provenance"] })
      .provenance ?? ({} as KnowledgeRecord["provenance"]);
  const datasetIds =
    prov.datasetIds ??
    ((raw as unknown as { datasetIds?: string[] }).datasetIds as
      string[] | undefined) ??
    (raw.datasetId ? [raw.datasetId] : undefined) ??
    ((raw.metadata as Record<string, unknown> | undefined)?.datasetIds as
      string[] | undefined);
  const columns =
    prov.columns ??
    ((raw.metadata as Record<string, unknown> | undefined)?.columns as
      string[] | undefined) ??
    ((raw.metadata as Record<string, unknown> | undefined)?.column
      ? [(raw.metadata as Record<string, unknown>).column as string]
      : undefined);
  return {
    ...raw,
    kind,
    datasetId: raw.datasetId ?? datasetIds?.[0],
    metadata: raw.metadata ?? {},
    provenance: {
      workspaceId: prov.workspaceId ?? raw.workspaceId,
      notebookId: prov.notebookId ?? raw.notebookId,
      cellId: prov.cellId ?? raw.cellId ?? undefined,
      datasetIds,
      datasetName:
        prov.datasetName ??
        ((raw.metadata as Record<string, unknown> | undefined)?.datasetName as
          string | undefined),
      columns,
      operation:
        prov.operation ??
        ((raw.metadata as Record<string, unknown> | undefined)?.operation as
          string | undefined),
      sourceCellIds: prov.sourceCellIds,
      dependsOn: prov.dependsOn,
      inputHash: prov.inputHash,
      outputHash: prov.outputHash,
      uploadId: prov.uploadId,
      contentHash: prov.contentHash,
      sampleCoverage: prov.sampleCoverage,
      chunkId: prov.chunkId,
      rowIndices: prov.rowIndices,
      executionId: prov.executionId,
    },
  };
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      let store: IDBObjectStore;
      if (!db.objectStoreNames.contains(STORE)) {
        store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("by_workspace", "workspaceId", { unique: false });
        store.createIndex("by_notebook", "notebookId", { unique: false });
        store.createIndex("by_cell", "cellId", { unique: false });
        store.createIndex("by_sourceHash", "sourceHash", { unique: false });
        store.createIndex("by_dataset", "provenance.datasetIds", {
          unique: false,
          multiEntry: true,
        });
        store.createIndex("by_column", "provenance.columns", {
          unique: false,
          multiEntry: true,
        });
      } else {
        const tx = req.transaction!;
        store = tx.objectStore(STORE);
        if (!store.indexNames.contains("by_dataset")) {
          store.createIndex("by_dataset", "provenance.datasetIds", {
            unique: false,
            multiEntry: true,
          });
        }
        if (!store.indexNames.contains("by_column")) {
          store.createIndex("by_column", "provenance.columns", {
            unique: false,
            multiEntry: true,
          });
        }
        // existing stores may lack provenance — records will be normalized on read; indexes will be populated on next put
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class KnowledgeStore {
  async put(record: KnowledgeRecord): Promise<void> {
    const normalized = normalizeRecord(record);
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, "readwrite");
      t.objectStore(STORE).put(normalized as KnowledgeStoreRecord);
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

  async putMany(records: KnowledgeRecord[]): Promise<void> {
    if (records.length === 0) return;
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, "readwrite");
      const s = t.objectStore(STORE);
      for (const r of records)
        s.put(normalizeRecord(r) as KnowledgeStoreRecord);
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

  async getByWorkspace(workspaceId: string): Promise<KnowledgeRecord[]> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, "readonly");
      const idx = t.objectStore(STORE).index("by_workspace");
      const req = idx.getAll(workspaceId);
      req.onsuccess = () =>
        resolve(((req.result as KnowledgeRecord[]) || []).map(normalizeRecord));
      req.onerror = () => reject(req.error);
      t.oncomplete = () => db.close();
    });
  }

  async getByNotebook(notebookId: string): Promise<KnowledgeRecord[]> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, "readonly");
      const idx = t.objectStore(STORE).index("by_notebook");
      const req = idx.getAll(notebookId);
      req.onsuccess = () =>
        resolve(((req.result as KnowledgeRecord[]) || []).map(normalizeRecord));
      req.onerror = () => reject(req.error);
      t.oncomplete = () => db.close();
    });
  }

  async getByCell(cellId: string): Promise<KnowledgeRecord[]> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, "readonly");
      const idx = t.objectStore(STORE).index("by_cell");
      const req = idx.getAll(cellId);
      req.onsuccess = () =>
        resolve(((req.result as KnowledgeRecord[]) || []).map(normalizeRecord));
      req.onerror = () => reject(req.error);
      t.oncomplete = () => db.close();
    });
  }

  async getBySourceHash(sourceHash: string): Promise<KnowledgeRecord | null> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, "readonly");
      const idx = t.objectStore(STORE).index("by_sourceHash");
      const req = idx.get(sourceHash);
      req.onsuccess = () => {
        const raw = req.result as KnowledgeRecord | undefined;
        resolve(raw ? normalizeRecord(raw) : null);
      };
      req.onerror = () => reject(req.error);
      t.oncomplete = () => db.close();
    });
  }

  async getByDatasetId(datasetId: string): Promise<KnowledgeRecord[]> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, "readonly");
      const store = t.objectStore(STORE);
      if (store.indexNames.contains("by_dataset")) {
        const idx = store.index("by_dataset");
        const req = idx.getAll(datasetId);
        req.onsuccess = () =>
          resolve(
            ((req.result as KnowledgeRecord[]) || []).map(normalizeRecord),
          );
        req.onerror = () => reject(req.error);
      } else {
        const req = store.getAll();
        req.onsuccess = () => {
          const all = (req.result as KnowledgeRecord[]) || [];
          resolve(
            all
              .map(normalizeRecord)
              .filter((r) => r.provenance.datasetIds?.includes(datasetId)),
          );
        };
        req.onerror = () => reject(req.error);
      }
      t.oncomplete = () => db.close();
    });
  }

  async getByColumn(column: string): Promise<KnowledgeRecord[]> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, "readonly");
      const store = t.objectStore(STORE);
      if (store.indexNames.contains("by_column")) {
        const idx = store.index("by_column");
        const req = idx.getAll(column);
        req.onsuccess = () =>
          resolve(
            ((req.result as KnowledgeRecord[]) || []).map(normalizeRecord),
          );
        req.onerror = () => reject(req.error);
      } else {
        const req = store.getAll();
        req.onsuccess = () => {
          const all = (req.result as KnowledgeRecord[]) || [];
          resolve(
            all
              .map(normalizeRecord)
              .filter((r) => r.provenance.columns?.includes(column)),
          );
        };
        req.onerror = () => reject(req.error);
      }
      t.oncomplete = () => db.close();
    });
  }

  async remove(id: string): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, "readwrite");
      t.objectStore(STORE).delete(id);
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

  async removeByCell(cellId: string): Promise<void> {
    const recs = await this.getByCell(cellId);
    if (recs.length === 0) return;
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, "readwrite");
      const s = t.objectStore(STORE);
      for (const r of recs) s.delete(r.id);
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

  async clearWorkspace(workspaceId: string): Promise<void> {
    const recs = await this.getByWorkspace(workspaceId);
    if (recs.length === 0) return;
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, "readwrite");
      const s = t.objectStore(STORE);
      for (const r of recs) s.delete(r.id);
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

  async getAll(): Promise<KnowledgeRecord[]> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, "readonly");
      const req = t.objectStore(STORE).getAll();
      req.onsuccess = () =>
        resolve(((req.result as KnowledgeRecord[]) || []).map(normalizeRecord));
      req.onerror = () => reject(req.error);
      t.oncomplete = () => db.close();
    });
  }
}

export const knowledgeStore = new KnowledgeStore();
