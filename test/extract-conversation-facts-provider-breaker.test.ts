/**
 * FRA-22906 — provider-rejection circuit breaker.
 *
 * The incident: on 2026-07-27 the Anthropic credit balance emptied. Every
 * extraction request came back HTTP 400 before the model ran, and the loop
 * attempted all 1,548 conversation pages anyway — twice — then reported
 * `pages_failed: 1548`. That number reads as "the corpus is broken" and sent
 * diagnosis after a data-quality problem that did not exist.
 *
 * What these tests pin:
 *   - N consecutive request-level rejections abort; N-1 do not.
 *   - "Consecutive" really is consecutive: a success or an ordinary page
 *     failure in between resets the streak, so a long healthy run is never
 *     ended by rejections scattered across it.
 *   - A malformed page (no provider status) still only fails that page.
 *   - The breaker sees through the `cause` chain, which is how the status
 *     survives being wrapped in a per-segment Error by the extract loop.
 *   - Driven through the real worker pool, a rejecting provider stops the
 *     run after a bounded number of items instead of all of them.
 */

import { describe, test, expect } from 'bun:test';
import {
  createProviderRejectionBreaker,
  PROVIDER_REJECTION_ABORT_THRESHOLD,
} from '../src/commands/extract-conversation-facts.ts';
import { runSlidingPool } from '../src/core/worker-pool.ts';

/** A provider rejection as it actually arrives: status on a nested cause. */
function rejection(message = 'Your credit balance is too low to access the Anthropic API.'): Error {
  const transport = Object.assign(new Error(message), { status: 400 });
  // The extract loop wraps the gateway error in a per-segment Error; the
  // status only survives because that wrap threads `cause`.
  return new Error(`segment 2026-01-01..2026-01-02 extraction failed (provider_error): ${message}`, {
    cause: transport,
  });
}

/** A page that is genuinely broken — nothing to do with the provider. */
function pageDefect(): Error {
  return new Error('segment extraction failed (malformed_output)');
}

describe('createProviderRejectionBreaker', () => {
  test('aborts on the Nth consecutive rejection, not before', () => {
    const breaker = createProviderRejectionBreaker();
    for (let i = 1; i < PROVIDER_REJECTION_ABORT_THRESHOLD; i++) {
      expect(breaker.onFailure(rejection())).toBe('continue');
      expect(breaker.tripped).toBe(false);
    }
    expect(breaker.onFailure(rejection())).toBe('abort');
    expect(breaker.tripped).toBe(true);
  });

  test('surfaces the provider message as the reason', () => {
    const breaker = createProviderRejectionBreaker(2);
    breaker.onFailure(rejection());
    expect(breaker.reason).toBeNull(); // not tripped yet — nothing to report
    breaker.onFailure(rejection());
    expect(breaker.reason).toContain('credit balance is too low');
  });

  test('a success between rejections resets the streak', () => {
    const breaker = createProviderRejectionBreaker(3);
    breaker.onFailure(rejection());
    breaker.onFailure(rejection());
    breaker.onSuccess();
    // Two more rejections would have tripped a naive total counter.
    expect(breaker.onFailure(rejection())).toBe('continue');
    expect(breaker.onFailure(rejection())).toBe('continue');
    expect(breaker.tripped).toBe(false);
  });

  test('an ordinary page failure between rejections resets the streak', () => {
    const breaker = createProviderRejectionBreaker(3);
    breaker.onFailure(rejection());
    breaker.onFailure(rejection());
    expect(breaker.onFailure(pageDefect())).toBe('continue');
    expect(breaker.onFailure(rejection())).toBe('continue');
    expect(breaker.tripped).toBe(false);
  });

  test('a malformed page never trips the breaker on its own', () => {
    const breaker = createProviderRejectionBreaker(3);
    for (let i = 0; i < 50; i++) {
      expect(breaker.onFailure(pageDefect())).toBe('continue');
    }
    expect(breaker.tripped).toBe(false);
  });

  test('429 is not a request-level rejection — it may have generated output', () => {
    const breaker = createProviderRejectionBreaker(2);
    const rateLimited = new Error('rate limited', {
      cause: Object.assign(new Error('429'), { status: 429 }),
    });
    breaker.onFailure(rateLimited);
    breaker.onFailure(rateLimited);
    expect(breaker.tripped).toBe(false);
  });
});

describe('breaker driven through the real worker pool', () => {
  test('a total provider outage stops after ~N items, not all of them', async () => {
    // 1,548 is the real backlog size from the incident.
    const pages = Array.from({ length: 1548 }, (_, i) => `chat/page-${i}`);
    const breaker = createProviderRejectionBreaker();
    let attempted = 0;

    const poolResult = await runSlidingPool({
      items: pages,
      workers: 1,
      onItem: async () => {
        attempted++;
        throw rejection();
      },
      onError: (error) => breaker.onFailure(error),
      failureLabel: (slug) => slug,
    });

    expect(breaker.tripped).toBe(true);
    expect(attempted).toBe(PROVIDER_REJECTION_ABORT_THRESHOLD);
    expect(poolResult.aborted).toBe(true);
    // The pre-fix behaviour — and the thing the incident report actually said.
    expect(attempted).toBeLessThan(pages.length);
  });

  test('a healthy run with one bad page and one blip still processes everything', async () => {
    const pages = Array.from({ length: 200 }, (_, i) => `chat/page-${i}`);
    const breaker = createProviderRejectionBreaker();
    let processed = 0;

    const poolResult = await runSlidingPool({
      items: pages,
      workers: 1,
      onItem: async (slug: string) => {
        if (slug === 'chat/page-7') throw pageDefect();
        if (slug === 'chat/page-90') throw rejection();
        processed++;
      },
      onError: (error) => breaker.onFailure(error),
      failureLabel: (slug) => slug,
    });

    expect(breaker.tripped).toBe(false);
    expect(poolResult.aborted).toBe(false);
    expect(processed).toBe(pages.length - 2);
    expect(poolResult.errored).toBe(2);
  });
});
