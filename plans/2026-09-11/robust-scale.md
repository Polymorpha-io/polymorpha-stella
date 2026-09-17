# Robust + Scale — stella leg (2026-09-11)

Parent: `polymorpha/plans/2026-09-11/robust-scale.md`.
Affected Repos: [business-logic ☐ stella ☑ polymorpha ☐ tests ☐] + Reason:
knowledge plane owns retrieval semantics (G15b/G25/G26).

## Done this leg

- `ts/src/embeddings/EmbeddingService.ts`: `embedMany` dedupes identical texts
  before model call (order/keys positional-preserved, shared read-only vectors);
  dim-mismatch `console.warn` → warn-once (was per-call noise).
- `ts/vitest.config.ts` (new): `@/ → ./src` alias + `../tests/unit` include so
  canonical unit (`tests/unit`, 2 files) resolves. `npm test` now surfaces the
  pre-existing missing-`fflate` env gap instead of passing vacuously.

## Done this leg (update 2)

- `DatasetKnowledgeProvider.ts` (615) → 331-line orchestrator +
  `providers/dataset/{model,input,records}.ts` (triplicated column push →
  one `pushColumnRecord`; input resolution, synthetic fallback, rep-text
  computation extracted). `tsc -b --noEmit` EXIT 0 (strict:true),
  `vitest run` 23/23 green.
- Test env (untracked, local-only): `fflate/docx/xlsx/fake-indexeddb` copied
  into root `node_modules` (BL root `package.json` omits them; `npm install`
  fails graph-less with git deps — durable fix below). `vitest.setup.ts`
  polyfills IDB; config `testTimeout: 60000` (cold Xenova download ~15s).
  No mirrored test file touched (central `diff` identical — verified).

## Known gap (needs user ack, G1-adjacent)

- `vitest run` 23/23 green (real Xenova model, warm cache ~5s). The 3
  `dataset-column` failures met along the way were environmental only
  (missing alias config → missing fflate → missing IDB → 5s default timeout),
  never code bugs.
- Durable (tracked) fixes proposed, NOT applied (need G1/G8 ack + quiet
  window): declare `fflate/docx/xlsx` in BL root `package.json` (consumers
  never install `ts/package.json` deps), declare `fake-indexeddb` in stella
  devDeps, then `npm update @polymorpha/business-logic` in consumers.

## Deferred

- `DatasetKnowledgeProvider:615` split → `dataset/{columns,sampling,embed}.ts`.
- `EmbeddingWorker` Phase 2 (Worker + Comlink batch) — sequential loop is
  honest about main-thread constraint; dedupe above captures most of the win.
- `KnowledgeService .catch(()=>[])` fan-out: intentional per-source degradation
  with SCORE_FALLBACK — kept; observability via DEV-gated warn is follow-up.

## Verification

- `npx tsc -b --noEmit` EXIT 0. Central owner: `suites/stella`.
