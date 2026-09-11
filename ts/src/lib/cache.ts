import {
  DYNAMIC_SYNC_TTL_MS,
  QUOTAS_CACHE_TTL_MS,
} from "@polymorpha/business-logic";

type CacheKey = string;
const mem = new Map<CacheKey, { v: unknown; exp: number }>();
export const CACHE_TTL = {
  workspace: DYNAMIC_SYNC_TTL_MS,
  quota: QUOTAS_CACHE_TTL_MS,
  default: QUOTAS_CACHE_TTL_MS,
} as const;
function key(uid: string, ns: string, id: string): CacheKey {
  return `${uid}:${ns}:${id}`;
}
export const workspaceCache = {
  get<T>(uid: string, ns: string, id: string): T | undefined {
    const k = key(uid, ns, id);
    const e = mem.get(k);
    if (!e) return undefined;
    if (Date.now() > e.exp) {
      mem.delete(k);
      return undefined;
    }
    return e.v as T;
  },
  set(uid: string, ns: string, v: unknown, ttl: number, id: string): void {
    mem.set(key(uid, ns, id), { v, exp: Date.now() + ttl });
  },
  invalidate(uid: string, ns: string, id: string): void {
    mem.delete(key(uid, ns, id));
  },
};
