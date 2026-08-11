/**
 * FRA-23173 — reranker evidence-window (`buildDocuments`) tests.
 *
 * The unit being ranked at the rerank step is the PAGE, but the document sent
 * upstream is one chunk. These pin the strategies that widen that window, and
 * — most importantly — pin `best_chunk` as the default so the measured-neutral
 * production behaviour cannot drift by accident.
 *
 * Pins:
 *  - default (and explicit `best_chunk`) is byte-identical to the pre-FRA-23173
 *    document: chunk text only, no title
 *  - `title_best_chunk` prepends the title without a chunk fetch
 *  - `topk_chunks` / `whole_page` widen the window via the injected fetcher,
 *    and ask it for their own chunk budget
 *  - both wide strategies degrade to title+best-chunk when the fetcher is
 *    absent, throws, or returns nothing — widening is an optimisation, never a
 *    correctness requirement
 *  - empty chunk_text still falls back to the title (defensive, pre-existing)
 */

import { describe, test, expect } from 'bun:test';
import { buildDocuments } from '../../src/core/search/rerank.ts';
import type { SearchResult } from '../../src/core/types.ts';

function makeResult(slug: string, chunk: string, title = slug): SearchResult {
  return {
    slug,
    page_id: 0,
    title,
    type: 'note',
    chunk_text: chunk,
    chunk_source: 'compiled_truth',
    chunk_id: 0,
    chunk_index: 0,
    score: 1,
    stale: false,
  } as SearchResult;
}

const QUERY = 'warehouse capacity';
const head = [makeResult('long-page', 'best chunk body', 'Long Page')];

describe('buildDocuments — default stays production behaviour', () => {
  test('no docStrategy sends chunk text only, no title', async () => {
    expect(await buildDocuments(QUERY, head, {})).toEqual(['best chunk body']);
  });

  test('explicit best_chunk matches the default, and ignores a fetcher', async () => {
    const docs = await buildDocuments(QUERY, head, {
      docStrategy: 'best_chunk',
      chunkFetcher: async () => ['a', 'b', 'c'],
    });
    expect(docs).toEqual(['best chunk body']);
  });

  test('best_chunk falls back to title when chunk text is empty', async () => {
    const docs = await buildDocuments(QUERY, [makeResult('s', '', 'Only Title')], {});
    expect(docs).toEqual(['Only Title']);
  });
});

describe('buildDocuments — widened windows', () => {
  test('title_best_chunk prepends the title and needs no fetcher', async () => {
    let called = false;
    const docs = await buildDocuments(QUERY, head, {
      docStrategy: 'title_best_chunk',
      chunkFetcher: async () => {
        called = true;
        return ['x'];
      },
    });
    expect(docs).toEqual(['Long Page\n\nbest chunk body']);
    expect(called).toBe(false);
  });

  test('topk_chunks asks for 3 chunks and joins them under the title', async () => {
    const limits: number[] = [];
    const docs = await buildDocuments(QUERY, head, {
      docStrategy: 'topk_chunks',
      chunkFetcher: async (_r, limit) => {
        limits.push(limit);
        return ['c1', 'c2', 'c3'];
      },
    });
    expect(limits).toEqual([3]);
    expect(docs).toEqual(['Long Page\n\nc1\n\nc2\n\nc3']);
  });

  test('whole_page asks for a larger, still-bounded chunk budget', async () => {
    const limits: number[] = [];
    await buildDocuments(QUERY, head, {
      docStrategy: 'whole_page',
      chunkFetcher: async (_r, limit) => {
        limits.push(limit);
        return ['c1'];
      },
    });
    expect(limits).toEqual([20]);
  });
});

describe('buildDocuments — widening never breaks the call', () => {
  const narrow = ['Long Page\n\nbest chunk body'];

  test('missing fetcher degrades to title_best_chunk', async () => {
    expect(await buildDocuments(QUERY, head, { docStrategy: 'whole_page' })).toEqual(narrow);
  });

  test('throwing fetcher degrades to title_best_chunk', async () => {
    const docs = await buildDocuments(QUERY, head, {
      docStrategy: 'whole_page',
      chunkFetcher: async () => {
        throw new Error('db down');
      },
    });
    expect(docs).toEqual(narrow);
  });

  test('empty fetcher result degrades to title_best_chunk', async () => {
    const docs = await buildDocuments(QUERY, head, {
      docStrategy: 'topk_chunks',
      chunkFetcher: async () => [],
    });
    expect(docs).toEqual(narrow);
  });
});
