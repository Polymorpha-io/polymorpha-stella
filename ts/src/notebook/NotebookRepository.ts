/**
 * G24: Checked CacheService (T1/T2/T3 generic blob) + Dexie/idb-keyval — CacheService is key-value (datasets/blobs) without indexes (by_workspace/by_cell), cannot query notebooks by workspace efficiently. Reusing CacheService would require full scan. Custom IDB with indexed stores justified, pattern mirrors CacheService openDB/LRU/cross-tab principles. IndexedDB is standard.
 */
import type { Notebook } from "./types";

const DB_NAME = "polymorpha-notebooks";
const DB_VERSION = 1;
const STORE_NOTEBOOKS = "notebooks";
const STORE_OUTPUTS = "outputs";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB not available"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NOTEBOOKS)) {
        db.createObjectStore(STORE_NOTEBOOKS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_OUTPUTS)) {
        db.createObjectStore(STORE_OUTPUTS, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// @ts-expect-error unused helper kept for future notebook ops
async function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T> | Promise<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const objectStore = transaction.objectStore(store);
    let result: T | undefined;
    let requestDone = false;
    const maybe = fn(objectStore);
    if (maybe instanceof Promise) {
      maybe
        .then((v) => {
          result = v;
          requestDone = true;
        })
        .catch(reject);
    } else {
      const req = maybe as unknown as IDBRequest<T>;
      req.onsuccess = () => {
        result = req.result;
        requestDone = true;
      };
      req.onerror = () => reject(req.error);
    }
    transaction.oncomplete = () => {
      db.close();
      if (requestDone) resolve(result as T);
      else resolve(undefined as unknown as T);
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

export class NotebookRepository {
  async get(notebookId: string): Promise<Notebook | null> {
    try {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const t = db.transaction(STORE_NOTEBOOKS, "readonly");
        const req = t.objectStore(STORE_NOTEBOOKS).get(notebookId);
        req.onsuccess = () => resolve((req.result as Notebook) ?? null);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      });
    } catch {
      return null;
    }
  }

  async getByWorkspace(workspaceId: string): Promise<Notebook | null> {
    try {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const t = db.transaction(STORE_NOTEBOOKS, "readonly");
        const store = t.objectStore(STORE_NOTEBOOKS);
        const req = store.getAll();
        req.onsuccess = () => {
          const all = (req.result as Notebook[]) || [];
          const found = all.find((n) => n.workspaceId === workspaceId) ?? null;
          resolve(found);
        };
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      });
    } catch {
      return null;
    }
  }

  async put(notebook: Notebook): Promise<void> {
    notebook.updatedAt = Date.now();
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE_NOTEBOOKS, "readwrite");
      t.objectStore(STORE_NOTEBOOKS).put(notebook);
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

  async delete(notebookId: string): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE_NOTEBOOKS, "readwrite");
      t.objectStore(STORE_NOTEBOOKS).delete(notebookId);
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

  async listByWorkspace(workspaceId: string): Promise<Notebook[]> {
    const one = await this.getByWorkspace(workspaceId);
    return one ? [one] : [];
  }

  async clear(): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE_NOTEBOOKS, "readwrite");
      t.objectStore(STORE_NOTEBOOKS).clear();
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
}

export const notebookRepository = new NotebookRepository();
