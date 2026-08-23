import type {
  RagDatasetProfile,
  RagPipelineName,
  PipelineStatus,
  RagProfileState,
} from "@/lib/rag/types";

const mem = new Map<string, RagProfileState>();
let active: string | null = null;

type RagStoreState = {
  byDataset: Map<string, RagProfileState>;
  activeUploadId: string | null;
  profile: RagDatasetProfile;
  status: Record<RagPipelineName, PipelineStatus>;
  isProfiling: boolean;
  hash: string | null;
  updatedAt: number | null;
  startProfiling: (hash: string, uploadId?: string | null) => void;
  setStatus: (
    name: RagPipelineName,
    status: PipelineStatus,
    uploadId?: string | null,
  ) => void;
  setPipelineResult: <K extends keyof RagDatasetProfile>(
    name: RagPipelineName,
    key: K,
    value: RagDatasetProfile[K],
    uploadId?: string | null,
  ) => void;
  finishProfiling: (uploadId?: string | null) => void;
  setActiveUpload: (uploadId: string | null) => void;
  setSample: (
    sample: RagProfileState["sample"],
    uploadId?: string | null,
  ) => void;
  reset: (uploadId?: string | null) => void;
};

function createRagStore() {
  const state: RagStoreState = {
    byDataset: mem,
    activeUploadId: active,
    profile: {
      dataset: null,
      perColumn: null,
      missing: null,
      duplicate: null,
      quality: null,
    } as RagDatasetProfile,
    status: {
      dataset: "pending",
      perColumn: "pending",
      missing: "pending",
      duplicate: "pending",
      quality: "pending",
    } as Record<RagPipelineName, PipelineStatus>,
    isProfiling: false,
    hash: null,
    updatedAt: null,
    startProfiling: (hash: string, uploadId?: string | null) => {
      const uid = uploadId ?? "__single__";
      mem.set(uid, {
        profile: {
          dataset: null,
          perColumn: null,
          missing: null,
          duplicate: null,
          quality: null,
        },
        status: {
          dataset: "pending",
          perColumn: "pending",
          missing: "pending",
          duplicate: "pending",
          quality: "pending",
        },
        isProfiling: true,
        error: null,
        hash,
        updatedAt: Date.now(),
        uploadId: uid,
        contentHash: null,
        sample: null,
      });
      (
        state as unknown as { byDataset: Map<string, RagProfileState> }
      ).byDataset = mem;
    },
    setStatus: (
      name: RagPipelineName,
      status: PipelineStatus,
      uploadId?: string | null,
    ) => {
      const uid = (uploadId ?? active ?? "__single__") as string;
      const cur = mem.get(uid);
      if (cur) {
        cur.status[name] = status;
        cur.isProfiling = Object.values(cur.status).some(
          (v) => v === "running",
        );
      }
    },
    setPipelineResult: <K extends keyof RagDatasetProfile>(
      name: RagPipelineName,
      key: K,
      value: RagDatasetProfile[K],
      uploadId?: string | null,
    ) => {
      const uid = (uploadId ?? active ?? "__single__") as string;
      const cur = mem.get(uid);
      if (cur) {
        (cur.profile as unknown as Record<string, unknown>)[key as string] =
          value;
        cur.status[name] = "done";
      }
    },
    finishProfiling: (uploadId?: string | null) => {
      const uid = (uploadId ?? active ?? "__single__") as string;
      const cur = mem.get(uid);
      if (cur) cur.isProfiling = false;
    },
    setActiveUpload: (uploadId: string | null) => {
      active = uploadId;
      (state as unknown as { activeUploadId: string | null }).activeUploadId =
        active;
    },
    setSample: (
      sample: RagProfileState["sample"],
      uploadId?: string | null,
    ) => {
      const uid = (uploadId ?? active ?? "__single__") as string;
      const cur = mem.get(uid);
      if (cur) cur.sample = sample;
      else
        mem.set(uid, {
          profile: {
            dataset: null,
            perColumn: null,
            missing: null,
            duplicate: null,
            quality: null,
          },
          status: {
            dataset: "pending",
            perColumn: "pending",
            missing: "pending",
            duplicate: "pending",
            quality: "pending",
          },
          isProfiling: false,
          error: null,
          hash: null,
          updatedAt: Date.now(),
          uploadId: uid,
          contentHash: null,
          sample,
        });
    },
    reset: (uploadId?: string | null) => {
      if (uploadId) mem.delete(uploadId);
      else mem.clear();
      if (!uploadId) {
        active = null;
        (state as unknown as { activeUploadId: string | null }).activeUploadId =
          null;
      }
    },
  };

  const fn = (selector?: (s: RagStoreState) => unknown) =>
    (selector ? (selector(state) as unknown) : state) as unknown;
  (fn as unknown as { getState: () => RagStoreState }).getState = () => state;
  (
    fn as unknown as {
      setState: (
        partial:
          | Partial<RagStoreState>
          | ((s: RagStoreState) => Partial<RagStoreState>),
      ) => void;
    }
  ).setState = (
    partial:
      Partial<RagStoreState> | ((s: RagStoreState) => Partial<RagStoreState>),
  ) => {
    const patch =
      typeof partial === "function"
        ? (partial as (s: RagStoreState) => Partial<RagStoreState>)(state)
        : partial;
    if (patch.byDataset !== undefined) {
      mem.clear();
      for (const [k, v] of (
        patch.byDataset as Map<string, RagProfileState>
      ).entries())
        mem.set(k, v);
      (
        state as unknown as { byDataset: Map<string, RagProfileState> }
      ).byDataset = mem;
    }
    if (patch.activeUploadId !== undefined) {
      active = patch.activeUploadId as string | null;
      (state as unknown as { activeUploadId: string | null }).activeUploadId =
        active;
    }
    Object.assign(state, patch);
  };
  // also expose direct methods on the function for convenience
  (
    fn as unknown as {
      getState: () => RagStoreState;
      setState: (p: Partial<RagStoreState>) => void;
    }
  ).getState = () => state;
  return fn as unknown as ((
    selector?: (s: RagStoreState) => unknown,
  ) => unknown) & {
    getState: () => RagStoreState;
    setState: (
      partial:
        Partial<RagStoreState> | ((s: RagStoreState) => Partial<RagStoreState>),
    ) => void;
  };
}

export const useRagStore = createRagStore();
