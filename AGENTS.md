# AGENTS.md — Polymorpha Stella (Knowledge/Stella Library)

> **⚠️ DeepSeek Peak Pricing:** DeepSeek charges **2× during peak hours**
> (UTC 1:00–4:00 AM and 6:00–10:00 AM · UTC+8: 9 AM–12 noon and 2–6 PM).
> If current time is peak, **ask the user to verify** before starting any AI task.

> **Purpose:** **Library** `@polymorpha/stella` `git+https://github.com/Polymorpha-io/polymorpha-stella.git#main` — single source of truth for **Stella/RAG/embedder/knowledge/vector/representation/notebook** (`G25` one semantic retrieval plane, `G26` KnowledgeRecord boundary). Wraps `@xenova/transformers` `Xenova/all-MiniLM-L6-v2` 384d + `nbformat` thin adapter. Depends on `@polymorpha/business-logic` via `git+https` (`hashString`, `DICTIONARY_TERMS`, `RagProfiler` primitive), never vice-versa. Consumed by `Polymorpha-io/polymorpha` UI and verified by `Polymorpha-io/polymorpha-tests` central `suites/stella`.
> **Last updated:** 2026-09-19 · **Ticket prefix:** `POLY-`

---

## Repository Role — Knowledge/Stella Library (Single Source of Truth for G25/G26)

**This repo is the Stella Library.** Every Stella/RAG/embedder/knowledge decision lives here and **nowhere else**. `polymorpha` is thin UI that imports via `git+https`; `polymorpha-business-logic` stays Stella-free. Full 4-repo role/contract table: `Polymorpha-io/polymorpha/AGENTS.md` (canonical).

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

### Cross-Repo Detail — canonical link

> Graph + roles stay canonical-identical with `Polymorpha-io/polymorpha/AGENTS.md` (mirror rule). Workflow detail (guardrail counterparts, `G27` walk, classification matrix) lives in ONE place: `polymorpha/docs/ecosystem.md`. This repo's step: knowledge plane `ts/src/{knowledge,embeddings,lib/vector,stella}` (`G25`/`G26`) → `git push origin main` (`G16b`).

## Module Inventory

### TypeScript — `ts/src/` (exported via `ts/src/index.ts`)

| Area                 | Modules                     | Examples |
| -------------------- | --------------------------- | -------- |
| `knowledge`          | Single plane `G25/G26`      | `types` (`KnowledgeRecord` 9 kinds, `KnowledgeSearchRequest→KnowledgeResult`), `KnowledgeService` `search()` + `activeCellId+0.3 dataset+0.2 column+0.2 distance decay`, `KnowledgeStore` IDB, `KnowledgeExtractor` notebook→`KnowledgeRecord[]`, providers `DatasetKnowledgeProvider` (chunked 512) + `RelationshipKnowledgeProvider` (`missingTogether`/`candidateKeys`/`quality`) |
| `embeddings`         | WASM + cache `G24`          | `EmbeddingService` `embed/embedMany/chunkText/cosineSimilarity`, `EmbeddingCache` IDB 20MB/10k LRU `modelVersion:textHash→Float32Array`, `EMBED_DIM 384` |
| `lib/vector`         | Retrieval index `G21`       | `VectorStore` `uid:vector:contentHash:chunkId` federated cosine search, `clientStore` IDB 20MB/10k |
| `lib/representation` | Deterministic sampling `v1` | `DatasetRepresentationService` `buildDatasetProfileEmbedding`/`buildColumnSemanticEmbeddings(limit12)`/`buildDataRepresentativeEmbeddings` `v1-head-tail-quantile-rare` seeded |
| `lib/rag`            | 5 pipelines                 | `pipelineDataset/perColumn/missing/duplicate/quality` (`G20`), `RagService` streaming `profileDatasetStreaming`/`withTimeout` |
| `notebook`           | Notebook semantics `G24`    | `NotebookCell{status provenance}`, `nbformat` adapter, `NotebookContextBuilder` `active+preceding 5+lineage` |
| `stella`             | Brain + models `G24`        | `StellaService` SSE `openai/gpt-oss-20b`, `BrainService` `KnowledgeService.search()` only `G26`, `models/embeddingModel` `@xenova/transformers` `Xenova/all-MiniLM-L6-v2` `chunkText` 512+overlap50 |
| `config`             | Injection `G24`             | `StellaConfig` `{model,dim,chunkTokens,samplingVersion,perColumnLimit,vectorMaxBytes}` — `polymorpha` injects `EMBED_*` from `src/config/index.ts` |

**Entry:** `ts/src/index.ts` re-exports all areas; package `package.json:main = ts/dist/index.js`.

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

`polymorpha/package.json: "@polymorpha/stella": "git+https://github.com/Polymorpha-io/polymorpha-stella.git#main"` — Wrangler resolves both `business-logic` + `stella` `main` at build; local paths are never a source (`G15b`). `polymorpha` provides `StellaConfig` from its `src/config/index.ts` `EMBED_*`.

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

---

## Token Efficiency (TE)

Session-behavior prompts — save tokens by construction. Definitions: `Polymorpha-io/polymorpha/AGENTS.md#token-efficiency-te`.

| Rule | Prompt |
| --- | --- |
| **TE1** | **Context reuse.** Never re-read a file already read this session; reuse plan-file discoveries and prior search results (`E8`/`E14`/`E15`). |
| **TE2** | **Tool frugality.** Batch independent tool calls in parallel; ≤3 targeted greps/globs before broadening (`E7`); search exact symbols first (`E5`). |
| **TE3** | **Output budget.** No preamble/postamble/summaries; cite `file:line` instead of pasting code; never echo diffs or code back unless asked. |
| **TE4** | **One-pass investigation.** Record findings in the plan file so later sessions never rediscover them; compress discoveries into a working model, then stop reading (`E15`). |
| **TE5** | **Progressive validation.** Cheapest check first: syntax/type → targeted test → single build per batch (`G6`). Never restart servers between individual edits. |
