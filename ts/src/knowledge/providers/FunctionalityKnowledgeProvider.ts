import type { KnowledgeRecord } from "../types";
import type { KnowledgeProvider } from "../KnowledgeService";
import { sourceHash } from "../sourceHash";
import { tokenizeText } from "../hybridSearch";
import { FUNCTIONALITY_QUERY_TOP } from "../../config/retrieval";
import {
  FUNCTIONALITY_CORPUS_VERSION,
  buildFunctionalityCorpus,
} from "../functionalities";

/**
 * FunctionalityKnowledgeProvider — serves the app-capabilities corpus
 * (statistical methods from BL TEST_META + wrangle/guide overlays) as
 * system knowledge. Same shape as DictionaryKnowledgeProvider: global
 * records (workspaceId "system"), lexical pre-rank per query, full hybrid
 * ranking downstream in KnowledgeService.search. No IDB writes — the corpus
 * is small (~70 records) and static per corpus version.
 */
export class FunctionalityKnowledgeProvider implements KnowledgeProvider {
  async provide(
    workspaceId: string,
    notebook?: unknown,
    query: string = "",
  ): Promise<KnowledgeRecord[]> {
    void notebook;
    void workspaceId;
    try {
      const corpus = buildFunctionalityCorpus();
      const ranked = rankFunctionality(query, corpus).slice(
        0,
        FUNCTIONALITY_QUERY_TOP,
      );
      const now = Date.now();
      return await Promise.all(
        ranked.map(async (item) => {
          const sh = await sourceHash(
            `functionality:${FUNCTIONALITY_CORPUS_VERSION}:${item.id}`,
          );
          const id =
            item.kind === "guide" ? `guide::${item.id}` : `func::${item.id}`;
          return {
            id,
            workspaceId: "system",
            notebookId: "system",
            kind: item.kind,
            text: item.text,
            metadata: {
              source: "functionality",
              functionalityId: item.id,
              family: item.family,
              uiPath: item.uiPath,
              verified: item.verified,
              corpusVersion: FUNCTIONALITY_CORPUS_VERSION,
            },
            provenance: {
              workspaceId: "system",
              notebookId: "system",
              contentHash: `functionality:${FUNCTIONALITY_CORPUS_VERSION}`,
            },
            sourceHash: sh,
            createdAt: now,
            updatedAt: now,
          } satisfies KnowledgeRecord;
        }),
      );
    } catch {
      return [];
    }
  }
}

/**
 * Keyword prefilter (no embeddings spent) — token overlap against
 * name+family+text, stable order on ties so empty queries degrade to
 * corpus order, never a cliff. Mirrors rankDictionaryTerms.
 */
function rankFunctionality<
  T extends { name: string; family: string; text: string },
>(query: string, items: T[]): T[] {
  const tokens = tokenizeText(query);
  if (tokens.length === 0) return [...items];
  const scored = items.map((item) => {
    const hay = `${item.name} ${item.family} ${item.text}`.toLowerCase();
    let hits = 0;
    for (const tok of tokens) if (hay.includes(tok)) hits++;
    return { item, hits };
  });
  scored.sort((a, b) => b.hits - a.hits);
  return scored.map((s) => s.item);
}
