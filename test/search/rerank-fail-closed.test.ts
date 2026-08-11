/**
 * FRA-22966 — fail-CLOSED reranker posture for measurement callers.
 *
 * Production search stays fail-open (a flaky cross-encoder must never break
 * search). Eval/bench callers set `failClosed` because on the validated qrels
 * set an un-reranked fallback drops first_relevant_hit 0.571 → 0.143, so a
 * one-query blip reads as a catastrophic retrieval regression — or worse,
 * gets frozen into a published baseline.
 *
 * Pins:
 *  - failClosed unset/false → existing fail-open behavior is untouched
 *  - failClosed=true → upstream error throws RerankUnavailableError
 *  - the RerankError reason is carried through onto the thrown error
 *  - malformed / empty reranker responses also throw under failClosed
 *  - the audit JSONL is still written before throwing (no lost telemetry)
 *  - isRerankUnavailableError does not match ordinary brain errors
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  applyReranker,
  isRerankUnavailableError,
  RerankUnavailableError,
  type RerankerOpts,
} from '../../src/core/search/rerank.ts';
import { RerankError } from '../../src/core/ai/gateway.ts';
import { readRecentRerankFailures } from '../../src/core/rerank-audit.ts';
import type { SearchResult } from '../../src/core/types.ts';

function makeResult(slug: string, score: number): SearchResult {
  return {
    slug,
    page_id: 0,
    title: slug,
    type: 'note',
    chunk_text: `doc ${slug}`,
    chunk_source: 'compiled_truth',
    chunk_id: 0,
    chunk_index: 0,
    score,
    stale: false,
  };
}

const RESULTS = [makeResult('a', 1.0), makeResult('b', 0.9), makeResult('c', 0.8)];

function opts(overrides: Partial<RerankerOpts> = {}): RerankerOpts {
  return {
    enabled: true,
    topNIn: 3,
    topNOut: null,
    model: 'zeroentropyai:zerank-2',
    ...overrides,
  };
}

beforeAll(async () => {
  const { configureGateway } = await import('../../src/core/ai/gateway.ts');
  configureGateway({ env: { ZEROENTROPY_API_KEY: 'test-key' } });
});

afterAll(async () => {
  const { resetGateway } = await import('../../src/core/ai/gateway.ts');
  resetGateway();
});

describe('applyReranker — default posture is unchanged (fail-open)', () => {
  test('upstream error without failClosed returns the un-reranked order', async () => {
    const out = await applyReranker('q', RESULTS, opts({
      rerankerFn: async () => { throw new RerankError('upstream took too long', 'timeout'); },
    }));
    expect(out.map(r => r.slug)).toEqual(['a', 'b', 'c']);
  });

  test('failClosed:false is explicitly fail-open', async () => {
    const out = await applyReranker('q', RESULTS, opts({
      failClosed: false,
      rerankerFn: async () => { throw new RerankError('429', 'rate_limit'); },
    }));
    expect(out.map(r => r.slug)).toEqual(['a', 'b', 'c']);
  });
});

describe('applyReranker — failClosed throws instead of degrading', () => {
  test('upstream error throws RerankUnavailableError', async () => {
    const call = applyReranker('q', RESULTS, opts({
      failClosed: true,
      rerankerFn: async () => { throw new RerankError('upstream took too long', 'timeout'); },
    }));
    await expect(call).rejects.toThrow(RerankUnavailableError);
  });

  test('the RerankError reason is carried onto the thrown error', async () => {
    let caught: unknown;
    try {
      await applyReranker('q', RESULTS, opts({
        failClosed: true,
        rerankerFn: async () => { throw new RerankError('bad key', 'auth'); },
      }));
    } catch (err) {
      caught = err;
    }
    expect(isRerankUnavailableError(caught)).toBe(true);
    expect((caught as RerankUnavailableError).reason).toBe('auth');
    // The operator needs to see WHICH failure class without opening the JSONL.
    expect((caught as Error).message).toContain('auth');
  });

  test('a non-RerankError throw is classified as unknown, still fails closed', async () => {
    let caught: unknown;
    try {
      await applyReranker('q', RESULTS, opts({
        failClosed: true,
        rerankerFn: async () => { throw new Error('socket hang up'); },
      }));
    } catch (err) {
      caught = err;
    }
    expect(isRerankUnavailableError(caught)).toBe(true);
    expect((caught as RerankUnavailableError).reason).toBe('unknown');
  });

  test('empty reranker response throws (silently keeping RRF order is the bug)', async () => {
    let caught: unknown;
    try {
      await applyReranker('q', RESULTS, opts({ failClosed: true, rerankerFn: async () => [] }));
    } catch (err) {
      caught = err;
    }
    expect(isRerankUnavailableError(caught)).toBe(true);
    expect((caught as RerankUnavailableError).reason).toBe('malformed_response');
  });

  test('malformed (non-array) reranker response throws', async () => {
    let caught: unknown;
    try {
      await applyReranker('q', RESULTS, opts({
        failClosed: true,
        rerankerFn: (async () => ({ not: 'an array' })) as unknown as RerankerOpts['rerankerFn'],
      }));
    } catch (err) {
      caught = err;
    }
    expect(isRerankUnavailableError(caught)).toBe(true);
    expect((caught as RerankUnavailableError).reason).toBe('malformed_response');
  });

  test('a healthy reranker is unaffected by failClosed', async () => {
    const out = await applyReranker('q', RESULTS, opts({
      failClosed: true,
      rerankerFn: async () => [
        { index: 2, relevanceScore: 0.99 },
        { index: 0, relevanceScore: 0.5 },
        { index: 1, relevanceScore: 0.1 },
      ],
    }));
    expect(out.map(r => r.slug)).toEqual(['c', 'a', 'b']);
  });

  test('disabled reranker passes through without throwing', async () => {
    // failClosed only governs FAILURE handling — it must not turn a
    // deliberately-disabled reranker (conservative/balanced modes, cross-modal
    // override) into an error.
    const out = await applyReranker('q', RESULTS, opts({
      enabled: false,
      failClosed: true,
      rerankerFn: async () => { throw new Error('must not be called'); },
    }));
    expect(out.map(r => r.slug)).toEqual(['a', 'b', 'c']);
  });
});

describe('applyReranker — failClosed still writes the audit trail', () => {
  test('the failure is logged to the rerank-audit JSONL before throwing', async () => {
    const before = readRecentRerankFailures(1).length;
    await applyReranker('audit-probe-query', RESULTS, opts({
      failClosed: true,
      rerankerFn: async () => { throw new RerankError('ECONNRESET', 'network'); },
    })).catch(() => { /* expected */ });
    const after = readRecentRerankFailures(1);
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1]!.reason).toBe('network');
  });
});

describe('isRerankUnavailableError', () => {
  test('does not match an ordinary brain error', () => {
    expect(isRerankUnavailableError(new Error('connection to postgres failed'))).toBe(false);
    expect(isRerankUnavailableError(new RerankError('x', 'timeout'))).toBe(false);
    expect(isRerankUnavailableError(null)).toBe(false);
    expect(isRerankUnavailableError('reranker unavailable')).toBe(false);
  });
});
