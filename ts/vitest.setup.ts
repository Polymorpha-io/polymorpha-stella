/**
 * Vitest setup — IndexedDB polyfill for node env.
 * Mirrors the intent of the MemoryIDB mocks in `tests/unit/notebook/*`
 * (no new dep declared: uses the same `fake-indexeddb` version the UI
 * workspace already pins; durable fix is declaring it in devDeps + BL root
 * fflate/docx/xlsx — see plans/2026-09-11/robust-scale.md).
 */
import "fake-indexeddb/auto";
