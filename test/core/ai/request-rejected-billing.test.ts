/**
 * FRA-22903 — a request the provider REJECTED must not be billed like a
 * maximal successful generation.
 *
 * Real incident (2026-07-27): the Anthropic credit balance ran out mid-drain.
 * Every subsequent call returned HTTP 400 `invalid_request_error` ("credit
 * balance is too low") without running the model, yet the gateway charged each
 * one the pessimistic `maxOutputTokens` ceiling (4000 output tokens ≈
 * $0.064/call). 78 instant failures exhausted a $5 cap in 26 seconds, and
 * $64.80 of spend that never reached the provider was written into the ledger
 * that the FRA-22903 daily ceiling is enforced against.
 *
 * The pessimistic fallback is still correct for failures that could have
 * generated output (429, 5xx, timeouts, network) — those stay untouched.
 */

import { describe, test, expect } from 'bun:test';
import {
  isRequestRejectedBeforeGeneration,
  normalizeAIError,
  AIConfigError,
  AITransientError,
} from '../../../src/core/ai/errors.ts';
import { extractUsageFromError } from '../../../src/core/budget/budget-tracker.ts';

/** The exact shape the Anthropic SDK throws on an exhausted credit balance. */
function creditBalanceError(): Error & { status: number } {
  const err = new Error(
    'Your credit balance is too low to access the Anthropic API. ' +
      'Please go to Plans & Billing to upgrade or purchase credits.',
  ) as Error & { status: number };
  err.status = 400;
  return err;
}

describe('isRequestRejectedBeforeGeneration', () => {
  test('true for the credit-exhaustion 400 that caused the incident', () => {
    expect(isRequestRejectedBeforeGeneration(creditBalanceError())).toBe(true);
  });

  test('true for other request-level rejections (401, 403, 404)', () => {
    for (const status of [400, 401, 403, 404]) {
      expect(isRequestRejectedBeforeGeneration({ status })).toBe(true);
    }
  });

  test('false for 429 — a rate limit can abort a started stream', () => {
    expect(isRequestRejectedBeforeGeneration({ status: 429 })).toBe(false);
  });

  test('false for 5xx, timeouts and unknown errors', () => {
    expect(isRequestRejectedBeforeGeneration({ status: 500 })).toBe(false);
    expect(isRequestRejectedBeforeGeneration({ status: 529 })).toBe(false);
    expect(isRequestRejectedBeforeGeneration(new Error('socket hang up'))).toBe(false);
    expect(isRequestRejectedBeforeGeneration(null)).toBe(false);
    expect(isRequestRejectedBeforeGeneration(undefined)).toBe(false);
  });

  test('reads a status nested under `cause` (SDK wrapper envelopes)', () => {
    const wrapped = new Error('provider call failed') as Error & { cause: unknown };
    wrapped.cause = { status: 400 };
    expect(isRequestRejectedBeforeGeneration(wrapped)).toBe(true);
  });

  test('a self-referential cause chain terminates', () => {
    const err = new Error('loop') as Error & { cause: unknown };
    err.cause = err;
    expect(isRequestRejectedBeforeGeneration(err)).toBe(false);
  });
});

describe('billing a rejected request (the gateway catch-block contract)', () => {
  // Mirrors the gateway: rejected-before-generation zeroes the fallback,
  // everything else keeps the pessimistic ceiling.
  function billFor(err: unknown, estimatedInput: number, maxOutput: number) {
    const rejected = isRequestRejectedBeforeGeneration(err);
    return extractUsageFromError(err, {
      inputTokens: rejected ? 0 : estimatedInput,
      outputTokens: rejected ? 0 : maxOutput,
    });
  }

  test('credit exhaustion bills zero tokens, not the 4000-token ceiling', () => {
    expect(billFor(creditBalanceError(), 1876, 4000)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  test('a 5xx still bills the pessimistic ceiling (A3 preserved)', () => {
    expect(billFor({ status: 503 }, 1876, 4000)).toEqual({
      inputTokens: 1876,
      outputTokens: 4000,
    });
  });

  test('a rate limit still bills the pessimistic ceiling', () => {
    expect(billFor({ status: 429 }, 1876, 4000)).toEqual({
      inputTokens: 1876,
      outputTokens: 4000,
    });
  });

  test('real usage on the error always wins over either default', () => {
    const err = { status: 400, usage: { input_tokens: 120, output_tokens: 7 } };
    expect(billFor(err, 1876, 4000)).toEqual({ inputTokens: 120, outputTokens: 7 });
  });

  test('the incident arithmetic: 78 rejections no longer exhaust a $5 cap', () => {
    // Pre-fix each rejection was billed 1876 in + 4000 out at sonnet pricing
    // = $0.0656, so 78 of them cleared $5. Post-fix they cost nothing.
    const perCallPreFix = (1876 / 1_000_000) * 3 + (4000 / 1_000_000) * 15;
    expect(perCallPreFix * 78).toBeGreaterThan(5);

    let billed = 0;
    for (let i = 0; i < 78; i++) {
      const u = billFor(creditBalanceError(), 1876, 4000);
      billed += (u.inputTokens / 1_000_000) * 3 + (u.outputTokens / 1_000_000) * 15;
    }
    expect(billed).toBe(0);
  });
});

describe('error classification is unchanged by the new helper', () => {
  test('credit exhaustion still normalizes to a non-retryable config error', () => {
    const norm = normalizeAIError(creditBalanceError(), 'chat(anthropic:sonnet)');
    expect(norm).toBeInstanceOf(AIConfigError);
    expect(norm.message).toContain('credit balance');
  });

  test('5xx still normalizes to transient', () => {
    expect(normalizeAIError({ status: 503, message: 'overloaded' })).toBeInstanceOf(
      AITransientError,
    );
  });
});
