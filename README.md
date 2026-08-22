# polymorpha-stella — Knowledge/Stella Library

> **Library** `@polymorpha/stella` `git+https://github.com/Polymorpha-io/polymorpha-stella.git#main` — single source of truth for **Stella/RAG/embedder/knowledge/vector/representation/notebook** (`G25/G26` single semantic retrieval plane). Wraps `@xenova/transformers` `Xenova/all-MiniLM-L6-v2` 384d + `nbformat` thin adapter + `fflate`. Depends on `@polymorpha/business-logic` (`hashString`, `DICTIONARY_TERMS`, `RagProfiler` primitive) via `git+https`, never vice-versa.

**Consumers:** `Polymorpha-io/polymorpha` UI `import { KnowledgeService, BrainService, EmbeddingService } from "@polymorpha/stella"` + `Polymorpha-io/polymorpha-tests` central `suites/stella` mirror via `scripts/sync.mjs`.

**Deps:** `ts/dist` `vitest` `typescript` + `python/polymorpha_stella` wheel `StellaRagProfiler`.

See `AGENTS.md` for ecosystem graph and `ts/src/index.ts` for public exports.
