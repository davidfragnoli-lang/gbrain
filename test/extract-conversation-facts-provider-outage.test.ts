/**
 * FRA-22906: circuit-break `extract-conversation-facts` on consecutive
 * request-level provider rejections.
 *
 * The 2026-07-27 zero-credit outage is the shape under test. Anthropic
 * returned HTTP 400 for every request, and the bulk loop attempted all 1,548
 * conversation pages anyway, then reported `pages_failed: 1548`. That number
 * reads as "1,548 broken pages" — a corpus data-quality problem — when the
 * actual cause was one account-level condition. Diagnosis went after the
 * corpus first and lost real time on FRA-22903.
 *
 * Layering: `extract-conversation-facts-provider-breaker.test.ts` pins the
 * breaker's decision logic in isolation, and drives it through a bare worker
 * pool. This file is the end-to-end half — it runs the real command against a
 * real PGLite brain with a stubbed transport, so it can assert what the unit
 * layer structurally cannot: how many paid calls the run actually made, and
 * which counter on the returned result the outage lands in.
 *
 * What these tests pin, in the order the issue's acceptance criteria state
 * them:
 *   1. A run of request-level rejections stops after
 *      PROVIDER_REJECTION_ABORT_THRESHOLD pages instead of attempting every
 *      page. Asserted on the transport call count, not just on the result —
 *      the whole complaint was about work performed, not about reporting.
 *   2. The result names the provider failure and does NOT report the pages as
 *      failed.
 *   3. A single genuinely-bad page still fails only that page: neither a
 *      malformed extractor response nor an isolated 4xx ends the run.
 *
 * Hermetic via __setChatTransportForTests + __setEmbedTransportForTests.
 *
 * Test-isolation invariants (per CLAUDE.md R3+R4):
 *   - One PGLite engine per file, created in beforeAll, disposed in afterAll
 *   - Per-test state reset in beforeEach
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  __setChatTransportForTests,
  __setEmbedTransportForTests,
  resetGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import {
  runExtractConversationFactsCore,
  PROVIDER_REJECTION_ABORT_THRESHOLD,
  PER_SEGMENT_SOURCE_PREFIX,
  TERMINAL_AUDIT_SOURCE,
} from '../src/commands/extract-conversation-facts.ts';

/** Pages seeded per test. Comfortably above the abort threshold so "stopped
 * early" and "attempted everything" are far apart and can't be confused. */
const PAGE_COUNT = 8;

/** Two messages a day apart → two segments, so a page that survives its first
 * segment makes a second call. Mirrors the real corpus shape. */
function sampleBody(): string {
  return [
    '**Alice Example** (2024-03-15 9:00 AM): Hi, I just signed the offer letter for Acme Corp.',
    '**Bob Demo** (2024-03-15 9:01 AM): Congrats! What is the title?',
    '**Alice Example** (2024-03-16 8:00 AM): Update: I started at Acme Corp this morning.',
    '**Bob Demo** (2024-03-16 8:05 AM): Day one! How is it?',
  ].join('\n');
}

function pageTitle(i: number): string {
  return `Circuit page ${String(i).padStart(2, '0')}`;
}

/**
 * An Anthropic-shaped request-level rejection: HTTP 400 before any generation.
 * `isRequestRejectedBeforeGeneration` keys on the status, and the production
 * path reaches it through two layers of wrapping (gateway `normalizeAIError`,
 * then the per-segment `Error(..., { cause })`), so building the error this way
 * also exercises that the status survives the trip.
 */
function rejection(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}

const CREDIT_BALANCE_MESSAGE =
  'Your credit balance is too low to access the Anthropic API';

describe('extract-conversation-facts — provider circuit breaker (FRA-22906)', () => {
  let engine: PGLiteEngine;
  let repoDir: string;

  /** Per-test transport policy, keyed on the rendered turn text (which
   * carries the page title) so a single page can be singled out. Returning
   * an Error throws it; returning a string uses it as the response body. */
  let respond: (content: string) => Error | string;
  /** Every paid extraction call the run actually made. The load-bearing
   * number for "aborts after N pages instead of attempting all of them". */
  let extractionAttempts = 0;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    repoDir = mkdtempSync(join(tmpdir(), 'gbrain-provider-circuit-'));

    __setChatTransportForTests(async (opts): Promise<ChatResult> => {
      extractionAttempts++;
      const content = String(opts.messages[0]?.content ?? '');
      const outcome = respond(content);
      if (outcome instanceof Error) throw outcome;
      return {
        text: outcome,
        blocks: [],
        stopReason: 'end',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
        model: 'stub:stub',
        providerId: 'stub',
      };
    });

    __setEmbedTransportForTests(
      (async () => ({
        embeddings: [Array.from({ length: 1536 }, () => 0.1)],
      })) as never,
    );
  });

  afterAll(async () => {
    __setChatTransportForTests(null);
    __setEmbedTransportForTests(null);
    resetGateway();
    await engine.disconnect();
    rmSync(repoDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    extractionAttempts = 0;
    respond = () =>
      JSON.stringify({
        facts: [
          {
            fact: 'Alice Example joined Acme Corp',
            kind: 'event',
            entity: 'companies/acme-corp',
            confidence: 1.0,
            notability: 'high',
          },
        ],
      });

    await engine.executeRaw(
      `DELETE FROM facts WHERE source LIKE 'cli:extract-conversation-facts%'`,
    );
    await engine.executeRaw(
      `DELETE FROM op_checkpoints WHERE op = 'extract-conversation-facts'`,
    );
    await engine.executeRaw(`DELETE FROM extract_rollup_7d`);
    await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'conversations/circuit-%'`);
    await engine.setConfig('facts.extraction_enabled', 'true');
    await engine.setConfig('conversation_parser.llm_fallback_enabled', 'false');
    await engine.setConfig('sync.repo_path', repoDir);

    for (let i = 0; i < PAGE_COUNT; i++) {
      await engine.putPage(`conversations/circuit-${String(i).padStart(2, '0')}`, {
        type: 'conversation',
        title: pageTitle(i),
        compiled_truth: sampleBody(),
        timeline: '',
        frontmatter: {},
      });
    }
  });

  /**
   * `workers: 1` is deliberate. The breaker counts consecutive rejections
   * across whatever the pool happens to have in flight, so with N workers the
   * attempt count lands somewhere in [threshold, threshold + N - 1]. Pinning
   * one worker makes "stopped at exactly 3" an exact assertion instead of a
   * range, which is what distinguishes this test from the bug it guards.
   */
  const runBulk = () =>
    runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      types: ['conversation'],
      sleepMs: 0,
      workers: 1,
    });

  test('a provider rejecting every request stops the run after the threshold', async () => {
    respond = () => rejection(CREDIT_BALANCE_MESSAGE);

    const result = await runBulk();

    // The whole point of the issue: work performed, not just work reported.
    expect(extractionAttempts).toBe(PROVIDER_REJECTION_ABORT_THRESHOLD);
    expect(extractionAttempts).toBeLessThan(PAGE_COUNT);
    expect(result.pages_processed).toBe(0);
  });

  test('the result names the provider failure instead of blaming the pages', async () => {
    respond = () => rejection(CREDIT_BALANCE_MESSAGE);

    const result = await runBulk();

    expect(result.provider_unavailable).toBe(true);
    expect(result.provider_error).toContain('credit balance');
    // The load-bearing assertion. `pages_failed` is what read as "1,548
    // broken pages"; a provider outage must never land there.
    expect(result.pages_failed).toBe(0);
    expect(result.pages_provider_rejected).toBe(PROVIDER_REJECTION_ABORT_THRESHOLD);
    expect(result.facts_inserted).toBe(0);
  });

  test('a single malformed extractor response fails only that page', async () => {
    const badTitle = pageTitle(3);
    respond = (content) =>
      content.includes(badTitle)
        ? 'this is not JSON and never parses'
        : JSON.stringify({
            facts: [
              {
                fact: 'Alice Example joined Acme Corp',
                kind: 'event',
                entity: 'companies/acme-corp',
                confidence: 1.0,
                notability: 'high',
              },
            ],
          });

    const result = await runBulk();

    // A bad page is a page problem: it fails, the run continues, and the
    // breaker never arms because a malformed body is not a rejection.
    expect(result.pages_failed).toBe(1);
    expect(result.pages_processed).toBe(PAGE_COUNT - 1);
    expect(result.provider_unavailable).toBeFalsy();
    expect(result.pages_provider_rejected).toBe(0);
  });

  test('isolated request-level rejections do not arm the breaker', async () => {
    // One 4xx surrounded by successes — an oversized payload or a one-off
    // auth blip. Consecutive-counting is the reason this stays a one-page
    // problem; a naive "N rejections total" counter would end a healthy
    // multi-thousand-page run on scattered noise.
    const badTitle = pageTitle(3);
    const good = JSON.stringify({
      facts: [
        {
          fact: 'Alice Example joined Acme Corp',
          kind: 'event',
          entity: 'companies/acme-corp',
          confidence: 1.0,
          notability: 'high',
        },
      ],
    });
    respond = (content) =>
      content.includes(badTitle) ? rejection('request too large') : good;

    const result = await runBulk();

    expect(result.provider_unavailable).toBeFalsy();
    expect(result.pages_processed).toBe(PAGE_COUNT - 1);
    // Rejected, but reported as a rejection rather than as a page defect.
    expect(result.pages_provider_rejected).toBe(1);
    expect(result.pages_failed).toBe(0);
  });

  test('a non-request-level provider outage still walks the whole backlog', async () => {
    // Guards the breaker's scope. A 5xx / network error may have already
    // started generating, and is often transient per-request, so it keeps the
    // pre-existing tolerant behaviour: every page is attempted and every
    // failure is a real failure. Narrowing that here would silently change
    // what a flaky network run reports.
    respond = () => new Error('synthetic transport outage');

    const result = await runBulk();

    expect(result.provider_unavailable).toBeFalsy();
    expect(result.pages_failed).toBe(PAGE_COUNT);
    expect(result.pages_provider_rejected).toBe(0);
  });

  /**
   * The issue filed one open question alongside the fix: `deleteOrphanFactsForPage`
   * runs BEFORE extraction, so "a failure between delete and re-insert could
   * drop facts". Now that the breaker deliberately aborts runs mid-flight, that
   * window is entered on purpose rather than only during a crash, so it is
   * worth an executable answer instead of an argument.
   *
   * The answer is that it is safe, and the reason is narrow enough to be worth
   * pinning: the same DELETE also removes the page's terminal audit row. A page
   * that dies mid-extraction therefore ends up *uncertified*, so the next run
   * re-enumerates it and rebuilds it from scratch. The facts are transiently
   * gone but never durably lost, and never duplicated on replay.
   *
   * If someone ever narrows that DELETE to spare the terminal row — an
   * innocent-looking optimisation — this test fails, and it should: the page
   * would then read as complete while holding only a partial extraction.
   */
  test('a page that dies mid-extraction is left replayable, not silently emptied', async () => {
    const slug = 'conversations/circuit-00';
    const runOnePage = () =>
      runExtractConversationFactsCore(engine, {
        sourceId: 'default',
        slug,
        types: ['conversation'],
        sleepMs: 0,
      });
    const countRows = async (source: string): Promise<number> => {
      const rows = await engine.executeRaw<{ count: string | number }>(
        `SELECT COUNT(*) AS count FROM facts
          WHERE source_id = 'default' AND source_markdown_slug = $1 AND source = $2`,
        [slug, source],
      );
      return Number(rows[0]?.count ?? 0);
    };

    // Die on the second of the page's two segments — after segment 1 has
    // already committed rows, which is exactly the window the note worried about.
    const good = respond;
    let calls = 0;
    respond = (content) =>
      ++calls === 2 ? new Error('synthetic mid-page outage') : good(content);

    await expect(runOnePage()).rejects.toThrow('synthetic mid-page outage');

    // Segment 1's facts are on disk, but the page was never certified, so it
    // stays in the backlog rather than being mistaken for finished work.
    expect(await countRows(PER_SEGMENT_SOURCE_PREFIX)).toBe(1);
    expect(await countRows(TERMINAL_AUDIT_SOURCE)).toBe(0);

    respond = good;
    const replay = await runOnePage();

    expect(replay.pages_processed).toBe(1);
    // The partial row is cleaned rather than appended to — this is what keeps
    // replay from double-counting the segments it already extracted once.
    expect(replay.orphan_facts_cleaned).toBe(1);
    expect(await countRows(PER_SEGMENT_SOURCE_PREFIX)).toBe(2);
    expect(await countRows(TERMINAL_AUDIT_SOURCE)).toBe(1);
  });
});
