/**
 * AI service error hierarchy. Three classes mapping to caller decisions:
 *
 *   AIConfigError     — user fixes: bad key, missing model, dim mismatch.
 *                       Abort + show recovery recipe.
 *   AITransientError  — retryable: SDK retries exhausted, rate limit sustained.
 *                       Propagate so job queue can retry later.
 *   AIServiceError    — base class for both.
 *
 * The `fix` field carries a human-readable recovery recipe agents and humans
 * can act on. The `cause` field preserves the underlying SDK error.
 */

export class AIServiceError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'AIServiceError';
  }
}

export class AIConfigError extends AIServiceError {
  constructor(
    message: string,
    public readonly fix?: string,
    cause?: unknown,
  ) {
    super(message, cause);
    this.name = 'AIConfigError';
  }
}

export class AITransientError extends AIServiceError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'AITransientError';
  }
}

/**
 * Normalize any thrown error into our hierarchy. AI SDK errors are inspected
 * by status code + name; unknown errors default to AITransientError so the
 * caller does not permanently abort on a transient network blip.
 */
export function normalizeAIError(err: unknown, context?: string): AIServiceError {
  if (err instanceof AIServiceError) return err;

  const anyErr = err as { name?: string; status?: number; statusCode?: number; message?: string };
  const status = anyErr?.status ?? anyErr?.statusCode;
  const name = anyErr?.name ?? '';
  const msg = anyErr?.message ?? String(err);
  const ctxPrefix = context ? `[${context}] ` : '';

  // 4xx (except 429) = config-level, non-retryable
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) {
    return new AIConfigError(
      `${ctxPrefix}${msg}`,
      status === 401 || status === 403
        ? 'Check your API key is valid and has access to this model.'
        : 'Check your model id + provider options match the provider API.',
      err,
    );
  }

  // AI SDK named errors
  if (name === 'LoadAPIKeyError' || name === 'InvalidArgumentError') {
    return new AIConfigError(`${ctxPrefix}${msg}`, undefined, err);
  }

  // Everything else (5xx, timeouts, network) = transient
  return new AITransientError(`${ctxPrefix}${msg}`, err);
}

/**
 * FRA-22903: did the provider reject this request BEFORE generating any
 * output?
 *
 * A 4xx other than 429 is a request-level rejection — bad key, bad model,
 * malformed request, or an exhausted credit balance (Anthropic returns HTTP
 * 400 `invalid_request_error` for that). The provider never ran the model, so
 * there are no output tokens and no charge.
 *
 * Excluded on purpose: 429 (rate limit) and 5xx/timeout/network can abort a
 * request that already started streaming, so output may genuinely have been
 * generated and billed. Those keep the pessimistic ceiling.
 *
 * Why it matters: charging a rejected request the full `maxOutputTokens`
 * ceiling let 78 instant failures exhaust a $5 cap in 26 seconds, and inflated
 * the 2026-07-27 ledger by $64.80 of spend that never reached the provider.
 */
export function isRequestRejectedBeforeGeneration(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const anyErr = err as { status?: number; statusCode?: number; cause?: unknown };
    const status = anyErr.status ?? anyErr.statusCode;
    if (typeof status === 'number') {
      return status >= 400 && status < 500 && status !== 429;
    }
    // SDK wrappers frequently nest the transport error carrying the status.
    if (anyErr.cause && anyErr.cause !== err) {
      return isRequestRejectedBeforeGeneration(anyErr.cause);
    }
  }
  return false;
}
