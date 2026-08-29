# AGENTS.md — Polymorpha Stella (Knowledge/Stella Library)

> **⚠️ DeepSeek Peak Pricing:** DeepSeek charges **2× during peak hours**
> (UTC 1:00–4:00 AM and 6:00–10:00 AM · UTC+8: 9 AM–12 noon and 2–6 PM).
> If current time is peak, **ask the user to verify** before starting any AI task.

> **Purpose:** **Library** `@polymorpha/stella` `git+https://github.com/Polymorpha-io/polymorpha-stella.git#main` — single source of truth for **Stella/RAG/embedder/knowledge/vector/representation/notebook** (`G25` one semantic retrieval plane, `G26` KnowledgeRecord boundary). Wraps `@xenova/transformers` `Xenova/all-MiniLM-L6-v2` 384d + `nbformat` thin adapter. Depends on `@polymorpha/business-logic` via `git+https` (`hashString`, `DICTIONARY_TERMS`, `RagProfiler` primitive), never vice-versa. Consumed by `Polymorpha-io/polymorpha` UI and verified by `Polymorpha-io/polymorpha-tests` central `suites/stella`.
> **Last updated:** 2026-08-23 · **Ticket prefix:** `POLY-`

---

## ⚠️ DeepSeek Peak Pricing Warning

DeepSeek charges **2× regular price during peak hours**:

| Period         | UTC           | UTC+8              |
| -------------- | ------------- | ------------------ |
| Morning peak   | 1:00–4:00 AM  | 9:00 AM–12:00 noon |
| Afternoon peak | 6:00–10:00 AM | 2:00–6:00 PM       |

Before starting any AI task, check the current UTC time. If you're in a peak window, **ask the user to verify** before proceeding.

---

## Repository Role — Knowledge/Stella Library (Single Source of Truth for G25/G26)

**This repo is the Stella Library.** Every Stella/RAG/embedder/knowledge decision lives here and **nowhere else**. `Polymorpha-io/polymorpha` is thin UI that imports via `git+https`; `Polymorpha-io/polymorpha-business-logic` stays Stella-free.

| Layer              | Repo                                          | Contract                                                                                                                                                                                                                                                                   |
| ------------------ | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Logic**          | `Polymorpha-io/polymorpha-business-logic`     | Generic `hashString`/`compress`/`DICTIONARY_TERMS`/`RagProfiler` primitive `python/rag/profiler.py`. **Never imports `@polymorpha/stella`** (`D21` no circular).                                                                                                           |
| **Stella Library** | `Polymorpha-io/polymorpha-stella` (this repo) | Owns `ts/src/{knowledge,embeddings,lib/vector,lib/representation,lib/rag/pipelines,notebook,stella/{brain,models}}` + `python/polymorpha_stella/rag` thin adapter. Imports `@polymorpha/business-logic` via `git+https`, never vice-versa `G15b`.                          |
| UI                 | `Polymorpha-io/polymorpha`                    | Imports `{KnowledgeService,BrainService,EmbeddingService,DatasetRepresentationService,VectorStore} from "@polymorpha/stella"` + `{hashString} from "@polymorpha/business-logic"`; keeps `StellaPanel`/`StellaRagPanel`/`NotebookView` + stores + `StellaConfig` injection. |
| Verification       | `Polymorpha-io/polymorpha-tests`              | Mirrors `ts` parity + `python/polymorpha_stella` into `suites/stella` via `scripts/sync.mjs` + `suites/polymorpha` E2E `stella-knowledge`/`stella-rag`/`notebook-stella-aware` `T6` `concurrency>1`.                                                                       |

**Rule:** Before writing any new Stella helper (embedder, vector, knowledge provider, RAG pipeline, notebook lineage), search this repo first. If it belongs to Stella/Knowledge, it belongs _here_, not in `polymorpha` (`G15b`).

---

## Ecosystem — 4-Repo Interconnect (Source of Truth)

> **Canonical diagram lives in `Polymorpha-io/polymorpha` `AGENTS.md#ecosystem---4-repo-interconnect`** (`https://raw.githubusercontent.com/Polymorpha-io/polymorpha/main/AGENTS.md#ecosystem---4-repo-interconnect`). This file’s copy MUST stay identical — if drift, `polymorpha/AGENTS.md` wins (`diff -u`).

### Ecosystem Graph

```
                       ┌─────────────────────────────────┐
                       │  polymorpha-business-logic      │
                       │  Logic Layer (G15/G16)          │
                       │  ts/src/{core,stats,io,         │
                       │    exporters,dict,utils,        │
                       │    networking} + py/{Stats,ML,  │
                       │    Cleaner,IO,schemas,RagProf}  │
                       └──────────────┬──────────────────┘
                                      │ git+https://github.com/Polymorpha-io/polymorpha-business-logic.git#main
                                      │ TS: import { hashString } from '@polymorpha/business-logic'
                                      │ Py: from polymorpha.rag import RagProfiler
                                      ▼
                       ┌─────────────────────────────────┐
                       │  polymorpha-stella ★            │
                       │  Knowledge/Stella Library       │
                       │  (G15b/G16b, G25/G26)           │
                       │  ts/src/{knowledge,embeddings,  │
                       │    lib/vector,lib/representation│
                       │    lib/rag/pipelines,notebook,  │
                       │    stella/{brain,models}} +     │
                       │  py/polymorpha_stella/rag       │
                       └──────────────┬──────────────────┘
                                      │ git+https://github.com/Polymorpha-io/polymorpha-stella.git#main
                                      │ TS: import { KnowledgeService, BrainService } from '@polymorpha/stella'
                                      │ Py: from polymorpha_stella.rag import StellaRagProfiler
                                      ▼
                       ┌─────────────────────────────────┐
                       │  polymorpha                     │
                       │  UI Layer (G8)  11 sub-units    │
                       │  Pipeline 01→Workspace 02→Auth  │
                       │  03→Data Services 04→Dictionary │
                       │  05→Stats 06→Cloud Functions 07 │
                       │  →Infra 08→Analytics 09→UI Prim │
                       │  10→Stella/Knowledge 11         │
                       └──────────────┬──────────────────┘
                                      │ validated by
                                      ▼
                       ┌─────────────────────────────────┐
                       │  polymorpha-tests               │
                       │  Verification Layer (G22)       │
                       │  suites/polymorpha/{unit,api,   │
                       │    e2e,mocks,generators} +      │
                       │  suites/business-logic/python   │
                       │  (347) + suites/stella/{unit,   │
                       │    e2e,python} + fixtures       │
                       │  sync.mjs --check G21 hash      │
                       └─────────────────────────────────┘
```

### Cross-Repo Guardrail Quick-Ref

| Guardrail                            | This repo (Stella Library)                                                                                                                                                                                                                                                                           | Business-logic                                                                                                     | Polymorpha (UI)                                                                                                                                                        | Tests                                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **G15** generic single source        | This repo is `G15b` for Stella — before new Stella helper/search `@polymorpha/stella` first                                                                                                                                                                                                          | **Authoritative G15** — never imports `@polymorpha/stella` (`D21` `rg "@polymorpha/stella" ts/ python/` must be 0) | `git+https://github.com/Polymorpha-io/polymorpha-stella.git#main` → `node_modules/@polymorpha/stella`; also `business-logic` via `git+https`; never local `C:\Users\*` | Imports both via `git+https` `node_modules/@polymorpha/{business-logic,stella}` + wheel, never local fallback                 |
| **G16b** keep Wrangler in sync       | **Exception to G8:** direct `git push origin main` required (consumers `polymorpha` `polymorpha-tests` fetch `main` at install)                                                                                                                                                                      | Same `G16` direct `main`                                                                                           | After `stella` or `business-logic` push to `main`, run `npm update @polymorpha/{business-logic,stella}` + `npm run build`                                              | `UPSTREAMS` `git ls-remote` fetch new SHAs; `node scripts/sync.mjs` to pull                                                   |
| **G22** central test registry        | Tests mirrored — `tests/unit` canonical here, mirrored via `UPSTREAMS` `Polymorpha-io/polymorpha-stella` `dest: suites/stella`                                                                                                                                                                       | Tests mirrored via `UPSTREAMS` `Polymorpha-io/polymorpha-business-logic`                                           | Tests decluttered — `polymorpha/tests/` only `g10-strict-inventory.test.ts` dual-resident                                                                              | **Canonical** `implementation → identify central suite → sync/check → run central tests → build → E2E` `G22`                  |
| **G25** one semantic retrieval plane | **Authoritative** — all artifacts → `KnowledgeRecord.kind` → `EmbeddingService` → `VectorStore` behind `KnowledgeService.search()`; no `BrainService → UserLibrary → VectorStore`                                                                                                                    | No Stella deps                                                                                                     | `BrainService → KnowledgeService.search()` only; consumers `StellaPanel`/`BrainService` depend on `KnowledgeSearchRequest→KnowledgeResult`                             | `suites/stella/unit` proves plane `dataset_profile/column_semantic/data_representative/relationship` + `knowledgeStore` `IDB` |
| **G26** KnowledgeRecord boundary     | `KnowledgeRecord is semantic boundary` — providers `*KnowledgeProvider → KnowledgeRecord[]`                                                                                                                                                                                                          |
| **G27** cross-repo propagation       | **This repo is subject to G27** — if Stella/Knowledge/vector/notebook changed here, pipeline `business-logic → stella → polymorpha → tests` applies; after `git push origin main` `G16b`, consumers `npm update @polymorpha/stella` + `npm run build`; plan `Affected Repos` + `suites/stella` `G22` | Business-logic `G27` — `polymorpha-stella` imports `business-logic` `hashString`/`RagProfiler` `G15b`              | Polymorpha `G27` canonical — thin UI `KnowledgeService.search()` `G26` only `StellaPanel`                                                                              | Tests `G27` — `suites/stella/unit` 19+4 its + `suites/polymorpha/e2e/stella-knowledge.spec.ts` `T6` `concurrency>1`           |     | N/A | Consumers `BrainService` never `VectorStore/clientStore/DatasetRepresentationService` directly | Verifies boundary via `stella-notebook-pipeline.test.ts` |

| **G28** | **Ecosystem Sync — always pull & push all 4 repos (never single-repo stale).** Before ANY work: `git -C <each>/ pull --ff-only origin main` for `polymorpha`, `polymorpha-business-logic`, `polymorpha-stella`, `polymorpha-tests`. After ANY change: push every affected repo + `npm update @polymorpha/{business-logic,stella}` + `node scripts/sync.mjs --check` 4 SHAs `G21` before `npm run build`/`test`. Before done: `git status --short` must be `0` in all 4 checkouts. | Same `G28` — after `business-logic` `git push origin main` `G16`, ensure consumers updated. | **Canonical G28 (Stella):** This repo after `git push origin main` `G16b`, ensure `polymorpha`/`tests` `npm update` + `sync --check` 4 SHAs; never leave stale. | Same `G28` — pull all 4; `node scripts/sync.mjs --check` 4 SHAs `G21`; `git status --short` must be `0` in all 4. |

**Branch & push summary:** This repo → **direct `main`** (`G16b` exception, library); `business-logic` → **direct `main`** (`G16`); `polymorpha` → `feat/* → PR → main` (`G8`); `polymorpha-tests` suite changes → `git push origin main` (`G22`). See per-repo `AGENTS.md` for full rule text.

---

## Ecosystem Feature Propagation Pipeline (G27) — Cross-Repo Walk

> **G27 enforcement:** Every feature traverses 4 repos in order, even if change originates in one. A plan is incomplete without `Affected Repos` checklist and central suite proof.

### Pipeline Order & Designated Purpose

| Phase | Repo             | Designated Purpose (entry → exit)                                                                                                                                                                  | Branch & Push                        |
| ----- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 0     | **Plan**         | Classify → `Affected Repos: [business-logic ☐ stella ☐ polymorpha ☐ tests ☐] + Reason + suite owner` in `G7` plan `Cross-Repo Impact & Propagation`                                                | —                                    |
| 1     | `business-logic` | Domain primitive `ts/src/{core,stats,io,exporters,networking,shared}+python/polymorpha` (`DataCleaner`, `hashString`, `RagProfiler`) → `ts/dist` build                                             | `git push origin main` `G16` direct  |
| 2     | `stella`         | Knowledge plane `ts/src/{knowledge,embeddings,lib/vector,lib/representation,lib/rag,notebook,stella/{brain,models}}+python/polymorpha_stella` `G25/G26`                                            | `git push origin main` `G16b` direct |
| 3     | **Sync**         | Consumers `npm update @polymorpha/{business-logic,stella}` + `npm run build` verify Wrangler `main` fresh                                                                                          | —                                    |
| 4     | `polymorpha`     | Thin UI adapter `hooks/stores → @polymorpha/{business-logic,stella} / FirestoreService → external` `D24` — zero duplication `G15/G15b`                                                             | `feat/* → PR → main` `G8`            |
| 5     | `tests`          | Verification `suites/{polymorpha,business-logic,stella}+fixtures+generators/dataset.ts:G20` → `node scripts/sync.mjs --check` 4 SHAs `G21` → `vitest/playwright/pytest` `concurrency>1` `T6` `G18` | `git push origin main` `G22`         |

**Dependency direction:** `business-logic` (no stella) ← `stella` (imports `business-logic` `G15b`) ← `polymorpha` (imports both) ← `tests` (validates all). Never `C:\Users\*` `G15` — GitHub `git+https#main` + `raw.githubusercontent` `G22`.

### Classification Matrix

| Feature Type                                                 | business-logic                              | stella                     | polymorpha                   | tests                              |
| ------------------------------------------------------------ | ------------------------------------------- | -------------------------- | ---------------------------- | ---------------------------------- |
| Domain (cleaning/stats/export/hash)                          | ☑                                           | ☐ (unless stella consumes) | ☑ (adapter)                  | ☑ `suites/business-logic`          |
| Stella/Knowledge (KnowledgeRecord/embed/vector/RAG/notebook) | ☐ (generic `RagProfiler` only if primitive) | ☑                          | ☑ (StellaPanel/BrainService) | ☑ `suites/stella` + `e2e/stella-*` |
| UI-only (Pipeline/Workspace/Auth/UI)                         | ☐                                           | ☐                          | ☑                            | ☑ `suites/polymorpha/e2e`          |
| Infra (firestore.rules/worker/wrangler)                      | ☐                                           | ☐                          | ☑ (deploy `G12-G14`)         | ☑ `suites/cloud-functions`         |
| Cross-cutting (e.g., new artifact kind)                      | ☑                                           | ☑                          | ☑                            | ☑ all                              |

**Opt-out requires explicit Reason:** `Affected Repos: [polymorpha]` + `Reason: no domain/knowledge contract — verified via rg @polymorpha/business-logic` — reviewers check `D4`.

### Example — Stella `note_cell` kind

Plan: `Affected Repos: [stella☑ polymorpha☑ tests☑ business-logic☐ Reason: no domain primitive]` Suite `suites/stella/unit` + `suites/polymorpha/e2e/stella-knowledge.spec.ts`. Phase 2 `stella: types.ts KnowledgeKind + KnowledgeExtractor → ts/dist → push main` → Phase 3 `npm update @polymorpha/stella` → Phase 4 `polymorpha: StellaPanel kinds filter` → Phase 5 `tests: fixtures/missing.csv → sync --check → test:e2e concurrency>1`.

### Anti-Pattern (forbidden)

`stella` new `KnowledgeRecord.kind` committed and pushed, but `polymorpha` still imports old `stella#main` (no `npm update`) and `tests` has no `suites/stella` case — passes local build, fails `G27` gate + `G15b` + `G22`.

---

## Module Inventory

### TypeScript — `ts/src/` (exported via `ts/src/index.ts`)

| Area                 | Modules                     | Examples                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `knowledge`          | Single plane `G25/G26`      | `types` (`KnowledgeRecord` 9 kinds `KnowledgeSearchRequest→KnowledgeResult`), `KnowledgeService` (`search()` + `activeCellId+0.3 dataset+0.2 column+0.2 distance decay`), `KnowledgeStore` IDB `polymorpha-knowledge` v2, `KnowledgeExtractor` notebook→`KnowledgeRecord[]`, `providers/DatasetKnowledgeProvider` `DatasetRepresentationService→KnowledgeRecord` chunked 512, `providers/RelationshipKnowledgeProvider` `missingTogether/candidateKeys/quality` |
| `embeddings`         | WASM + cache `G24`          | `EmbeddingService` `embed/embedMany/chunkText/cosineSimilarity` + `embeddingService` singleton, `EmbeddingCache` IDB `polymorpha-embeddings` 20MB/10k LRU `modelVersion:textHash→Float32Array`, `EmbeddingWorker` stub, `types` `EMBED_DIM 384`                                                                                                                                                                                                                 |
| `lib/vector`         | Retrieval index `G21`       | `VectorStore` `uid:vector:contentHash:chunkId` `federatedSearch cosine`, `clientStore` IDB `polymorpha-vectors` 20MB/10k                                                                                                                                                                                                                                                                                                                                        |
| `lib/representation` | Deterministic sampling `v1` | `DatasetRepresentationService` `buildDatasetProfileEmbedding`/`buildColumnSemanticEmbeddings(limit12)`/`buildDataRepresentativeEmbeddings` `v1-head-tail-quantile-rare` seeded, `types`                                                                                                                                                                                                                                                                         |
| `lib/rag`            | 5 pipelines                 | `pipelines.ts` `pipelineDataset/perColumn/missing/duplicate/quality` (dataset-agnostic `G20`), `RagService` streaming `profileDatasetStreaming` `hashDatasetLight` `withTimeout`                                                                                                                                                                                                                                                                                |
| `notebook`           | Notebook semantics `G24`    | `types` `NotebookCell{status active/stale/superseded provenance}`, `nbformat.ts` `nbformat.NotebookNode` adapter, `NotebookContextBuilder` `active+preceding 5+lineage`                                                                                                                                                                                                                                                                                         |
| `stella`             | Brain + models `G24`        | `StellaService` `setContext→BrainService.answerStreaming` SSE `openai/gpt-oss-20b`, `brain/BrainService` `KnowledgeService.search()` only `G26`, `brain/Embedder` `cosineSimilarity`, `models/embeddingModel` `@xenova/transformers` `pipeline feature-extraction Xenova/all-MiniLM-L6-v2` `chunkText` 512+overlap50                                                                                                                                            |
| `config`             | Injection `G24`             | `StellaConfig` `{model,dim,chunkTokens,samplingVersion,perColumnLimit,vectorMaxBytes}` — `polymorpha` injects `EMBED_*` from `src/config/index.ts`                                                                                                                                                                                                                                                                                                              |

**Entry:** `export * from "./knowledge/*"; export * from "./embeddings/*"; export * from "./lib/vector/*"; export * from "./lib/representation/*"; export * from "./lib/rag/*"; export * from "./notebook/*"; export * from "./stella/*";` (`ts/src/index.ts`). Package `package.json:main = ts/dist/index.js`.

### Python — `python/polymorpha_stella/`

| Module            | Role                                                                                                                                                   | Used by                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `rag/profiler.py` | Thin adapter `from polymorpha.rag import RagProfiler as _Base; class StellaRagProfiler(_Base): def to_knowledge_records(...) chunked 512 + provenance` | `polymorpha-stella` TS `DatasetKnowledgeProvider` optional `cloud-functions` fallback `py` |

**Wheel:** `python/` `pyproject.toml` `polymorpha_stella` — `from polymorpha_stella.rag import StellaRagProfiler` (imports `business-logic` primitive, no duplication).

---

## Consumption Contract — How Other Repos Import This Library

### TypeScript (`polymorpha` UI — `G15b`)

```ts
import {
  KnowledgeService,
  BrainService,
  EmbeddingService,
} from "@polymorpha/stella";
import { DatasetKnowledgeProvider } from "@polymorpha/stella";
import { hashString } from "@polymorpha/business-logic"; // still from business-logic, not stella
// Never: from "C:\\Users\\...\\polymorpha-stella" — GitHub-only git+https per G15b
```

`polymorpha/package.json: "@polymorpha/stella": "git+https://github.com/Polymorpha-io/polymorpha-stella.git#main"` — Wrangler `wrangler deploy` resolves both `business-logic` + `stella` `main` at build. `polymorpha` provides `StellaConfig` from its `src/config/index.ts` `EMBED_*`.

### Python

```python
from polymorpha_stella.rag import StellaRagProfiler
# which internally: from polymorpha.rag import RagProfiler
```

---

## Testing Contract — G22 (Central Test Registry Mirror)

> **Single source of truth for tests is `Polymorpha-io/polymorpha-tests`** (`git+https://github.com/Polymorpha-io/polymorpha-tests.git#main`), but this library owns **canonical unit** for its logic (TF mock 384-d, `MemoryIDB`, no WASM). `polymorpha-tests` mirrors via `UPSTREAMS` `Polymorpha-io/polymorpha-stella` `dest: suites/stella`.

**This repo `tests/unit` (19+4 its):** `knowledge/dataset-column.test.ts` (`header-only 30-col no sentinel, profile upgrade no duplicate`) + `notebook/stella-notebook-pipeline.test.ts` (`KnowledgeExtractor`/`KnowledgeStore`/`NotebookContextBuilder`/`KnowledgeService` TF dedup `activeCell+0.3 dataset+0.2 column+0.2 distance`) — canonical, runs `vitest run` isolated.

**Mirrored in `polymorpha-tests` `suites/stella` via `scripts/sync.mjs`:** `UPSTREAMS` `{repo:"Polymorpha-io/polymorpha-stella",dest:"suites/stella",paths:["tests/unit","ts/src/knowledge","python/polymorpha_stella"]}` `git ls-remote` → `.sync-sha.json` `Polymorpha-io/polymorpha-stella` `G21`. During migration `suites/polymorpha/tests/unit/knowledge` may dual-reside `g10` pattern 1 release with `console.warn`.

**E2E stays central:** `stella-rag.spec.ts`/`stella-knowledge.spec.ts`/`notebook-stella-aware.spec.ts` `T6` `fixtures/missing.csv` `concurrency>1` `G18` remain in `polymorpha-tests/suites/polymorpha/e2e` as authoritative (UI orchestration `G25/G26`).

---

## Jira Workflow

Branches follow Jira ticket naming `feat: [POLY-xx]`. Library changes `git add` → `git commit` → `git push origin main` **direct `main`** required (`G16b` exception to `G8`) — consumers fetch `main` at install, do not leave on feature branch.
