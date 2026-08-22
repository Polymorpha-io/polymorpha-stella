/**
 * G24: Checked WorkspaceState.ts (existing gzip + Firebase Storage + workspaceCache) — reuses same Storage path pattern and cache invalidation, thin adapter for notebook.json.gz per workspace (not per dataset).
 */
import { getBytes, ref, uploadBytes } from "firebase/storage";
import { workspaceCache, CACHE_TTL } from "@/lib/cache";
import { compressGzip, decompressGzip } from "@/lib/compression";
import type { Notebook } from "./types";
import type { WorkspaceHost } from "@/lib/WorkspaceServiceTypes";

export async function serializeNotebook(
  notebook: Notebook,
): Promise<Uint8Array> {
  return compressGzip(JSON.stringify(notebook));
}

export async function deserializeNotebook(
  blob: ArrayBuffer,
): Promise<Notebook> {
  const decompressed = await decompressGzip(blob);
  const text = new TextDecoder().decode(decompressed);
  const raw = JSON.parse(text) as Notebook;
  // minimal migration: ensure fields exist
  if (!raw.version) raw.version = 1;
  if (!raw.cells) raw.cells = [];
  return raw;
}

export async function saveNotebook(
  host: WorkspaceHost,
  workspaceId: string,
  notebook: Notebook,
): Promise<void> {
  if (!host.storage) return;
  try {
    const compressed = await serializeNotebook(notebook);
    const path = `users/${host.uid}/workspaces/${workspaceId}/notebook.json.gz`;
    await uploadBytes(ref(host.storage, path), compressed);
    if (host.db) {
      try {
        const { doc, updateDoc, serverTimestamp } =
          await import("firebase/firestore");
        await updateDoc(
          doc(host.db, "users", host.uid, "workspaces", workspaceId),
          {
            updatedAt: serverTimestamp(),
          },
        );
      } catch {}
    }
    workspaceCache.invalidate(host.uid, "notebook", workspaceId);
  } catch (err) {
    console.warn("[NotebookStorage] saveNotebook failed", err);
  }
}

export async function loadNotebook(
  host: WorkspaceHost,
  workspaceId: string,
): Promise<Notebook | null> {
  if (!host.storage) return null;
  const cached = workspaceCache.get<Notebook | null>(
    host.uid,
    "notebook",
    workspaceId,
  );
  if (cached !== undefined) return cached;
  const path = `users/${host.uid}/workspaces/${workspaceId}/notebook.json.gz`;
  try {
    const bytes = await getBytes(ref(host.storage, path));
    const nb = await deserializeNotebook(bytes);
    workspaceCache.set(
      host.uid,
      "notebook",
      nb,
      CACHE_TTL.workspace,
      workspaceId,
    );
    return nb;
  } catch (err) {
    const code = (err as { code?: string })?.code ?? "";
    if (code.includes("object-not-found") || code.includes("not-found")) {
      workspaceCache.set(
        host.uid,
        "notebook",
        null,
        CACHE_TTL.workspace,
        workspaceId,
      );
      return null;
    }
    if (
      code.includes("permission-denied") ||
      code.includes("unauthenticated")
    ) {
      console.warn(
        "[NotebookStorage] loadNotebook permission denied",
        path,
        code,
      );
      return null;
    }
    console.warn("[NotebookStorage] loadNotebook failed", path, err);
    return null;
  }
}
