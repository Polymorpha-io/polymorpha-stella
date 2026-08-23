import type { Dataset } from "@/types";

type DataStoreState = {
  uploadId: string | null;
  raw: Dataset | null;
  rawHash: string | null;
  objective: string | null;
  cleaningConfig: Record<string, unknown> | null;
  cleaned: Dataset | null;
  appliedSteps: Array<{
    id: string;
    description: string;
    config: Record<string, unknown> & { type: string; column?: string };
  }>;
  cleaningDiff: {
    rowsRemoved?: number;
    valuesImputed?: Record<string, unknown>;
  } | null;
  results: Record<string, unknown> | null;
  workspaceId: string | null;
  reset: () => void;
};

function createStub() {
  const state: DataStoreState = {
    uploadId: null,
    raw: null,
    rawHash: null,
    objective: null,
    cleaningConfig: null,
    cleaned: null,
    appliedSteps: [],
    cleaningDiff: null,
    results: null,
    workspaceId: null,
    reset: () => {
      state.uploadId = null;
      state.raw = null;
      state.rawHash = null;
      state.objective = null;
      state.cleaningConfig = null;
      state.cleaned = null;
      state.appliedSteps = [];
      state.cleaningDiff = null;
      state.results = null;
      state.workspaceId = null;
    },
  };
  const fn = (selector?: (s: DataStoreState) => unknown) =>
    (selector ? (selector(state) as unknown) : state) as unknown;
  (fn as unknown as { getState: () => DataStoreState }).getState = () => state;
  (
    fn as unknown as { setState: (partial: Partial<DataStoreState>) => void }
  ).setState = (partial: Partial<DataStoreState>) => {
    Object.assign(state, partial);
  };
  return fn as unknown as ((
    selector?: (s: DataStoreState) => unknown,
  ) => unknown) & {
    getState: () => DataStoreState;
    setState: (partial: Partial<DataStoreState>) => void;
  };
}

export const useDataStore = createStub();

export type DataState = ReturnType<typeof useDataStore.getState>;
