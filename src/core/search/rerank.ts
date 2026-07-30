/**
 * v0.35.0.0+ — reranker call-site abstraction.
 *
 * Slots into hybridSearch after `dedupResults()` and before
 * `enforceTokenBudget()`. Takes the top `topNIn` candidates by current RRF
 * order, sends them to `gateway.rerank()`, and re-orders by the
 * cross-encoder's relevance score. The un-reranked long tail keeps its
 * original RRF order — preserves recall vs. truncating to topNIn.
 *
 * Fail-open posture: every error class (auth, network, timeout, rate-limit,
 * payload-too-large, unknown) logs to the rerank-audit JSONL and returns
 * the original RRF order unchanged. Search reliability beats reranker
 * quality; a flaky upstream must never break search.
 *
 * FAIL-CLOSED opt-in (FRA-22966): measurement callers — the qrels correctness
 * gate and baseline replay — set `opts.failClosed`. For them a silent
 * degradation is worse than an error: un-reranked ordering drops
 * first_relevant_hit from 0.571 to 0.143 on the validated qrels set, so a
 * one-query reranker blip reads as a catastrophic retrieval regression. With
 * `failClosed` the call throws `RerankUnavailableError` and the gate marks
 * the run inconclusive instead of publishing a degraded number. Production
 * search never sets this — the default stays fail-open.
 *
 * Caller (hybridSearch) decides whether the reranker fires via
 * `opts.reranker?.enabled`. Mode-bundle resolution defaults this to `true`
 * for tokenmax and `false` for conservative/balanced.
 */

import { createHash } from 'crypto';
import type { SearchResult } from '../types.ts';
import { rerank as gatewayRerank, RerankError, type RerankInput, type RerankResult } from '../ai/gateway.ts';
import { logRerankFailure, type RerankFailureReason } from '../rerank-audit.ts';

export interface RerankerOpts {
  enabled: boolean;
  /** How many of the top results to send to the reranker (default 30). */
  topNIn: number;
  /** Truncate the reranked output to this many (null = no truncate). */
  topNOut: number | null;
  /** Provider:model override. When undefined, gateway uses configured default. */
  model?: string;
  /** Per-call timeout in ms (default 5000 — propagates to gateway.rerank). */
  timeoutMs?: number;
  /**
   * FRA-22966 — measurement posture. When true, any reranker failure (upstream
   * error OR a malformed/empty response) throws `RerankUnavailableError`
   * instead of silently returning the un-reranked RRF order. Set ONLY by
   * eval/bench code paths; production search leaves it unset (fail-open).
   */
  failClosed?: boolean;
  /**
   * Test seam — when set, applyReranker calls this instead of gateway.rerank.
   * Production must NEVER set this.
   */
  rerankerFn?: (input: RerankInput) => Promise<RerankResult[]>;
  /**
   * FRA-23173 — evidence-window measurement seam. The unit being ranked here
   * is the PAGE, but the document handed to the cross-encoder is one chunk
   * (see `buildDocuments`). Supplying this lets a `docStrategy` other than
   * the default widen the window to more of the page. hybrid.ts wires it
   * (it owns the engine handle); applyReranker stays engine-free.
   *
   * Returns the page's text chunks, already ordered most-relevant-first for
   * the query. Must fail soft (return `[]`) — a fetch error degrades the
   * document, it must never break search.
   */
  chunkFetcher?: (r: SearchResult, limit: number) => Promise<string[]>;
  /**
   * FRA-23173 — which document construction to send upstream. Defaults to
   * `best_chunk`, i.e. production behaviour before FRA-23173. The wider
   * windows exist to be MEASURED against the qrels correctness gate before
   * any of them becomes the default; see the ablation table on FRA-23173.
   */
  docStrategy?: RerankDocStrategy;
}

/**
 * FRA-23173 — how `buildDocuments` turns a page-level candidate into the one
 * string the cross-encoder scores.
 *
 * - `best_chunk`       one chunk, no title. Production default. A 1-chunk stub
 *                      is represented in full; a 5-chunk page at ~27%.
 * - `title_best_chunk` adds the page title. Costs nothing (title is already on
 *                      SearchResult) — MEASURED no-op on the gate, kept because
 *                      it is the honest zero-cost half of the fix.
 * - `topk_chunks`      title + the K chunks that best match the query.
 * - `whole_page`       title + every text chunk.
 *
 * The last two need `chunkFetcher`; without it they degrade to
 * `title_best_chunk` rather than failing.
 */
export type RerankDocStrategy = 'best_chunk' | 'title_best_chunk' | 'topk_chunks' | 'whole_page';

/** Chunks requested per page under `topk_chunks`. */
const TOPK_CHUNKS = 3;
/** Upper bound on chunks pulled under `whole_page`, so one pathological page
 *  cannot blow the upstream payload limit for the whole batch. */
const WHOLE_PAGE_CHUNK_CAP = 20;

/**
 * Build the per-candidate document strings for the reranker call.
 *
 * Exported for measurement: the FRA-23173 ablation compares strategies on a
 * fixed candidate pool, and doing that through the real builder is what makes
 * the comparison trustworthy.
 *
 * Never throws — a `chunkFetcher` failure falls back to the title+best-chunk
 * document for that candidate.
 */
export async function buildDocuments(
  query: string,
  head: SearchResult[],
  opts: Pick<RerankerOpts, 'chunkFetcher' | 'docStrategy'>,
): Promise<string[]> {
  const strategy: RerankDocStrategy = opts.docStrategy ?? 'best_chunk';

  // chunk_text is the matched span. Fall back to title if empty (shouldn't
  // happen in practice; defensive). Empty docs would confuse the reranker,
  // but we still send them — the upstream model decides.
  if (strategy === 'best_chunk') return head.map(r => r.chunk_text || r.title || '');

  const titled = (r: SearchResult) =>
    `${r.title ?? ''}\n\n${r.chunk_text ?? ''}`.trim() || r.chunk_text || r.title || '';

  if (strategy === 'title_best_chunk' || !opts.chunkFetcher) return head.map(titled);

  const limit = strategy === 'whole_page' ? WHOLE_PAGE_CHUNK_CAP : TOPK_CHUNKS;
  return Promise.all(
    head.map(async r => {
      let chunks: string[] = [];
      try {
        chunks = await opts.chunkFetcher!(r, limit);
      } catch {
        // Widening the evidence window is an optimisation, never a
        // correctness requirement — degrade to the narrow document.
      }
      if (chunks.length === 0) return titled(r);
      return [r.title ?? '', ...chunks].join('\n\n').trim() || titled(r);
    }),
  );
}

/**
 * Thrown by `applyReranker` only when `opts.failClosed` is set. Signals "this
 * result set is un-measurable", NOT "search is broken" — callers should mark
 * the run inconclusive rather than record a quality regression.
 */
export class RerankUnavailableError extends Error {
  readonly reason: RerankFailureReason | 'malformed_response';
  readonly cause?: unknown;

  constructor(reason: RerankFailureReason | 'malformed_response', message: string, cause?: unknown) {
    super(`reranker unavailable (${reason}): ${message}`);
    this.name = 'RerankUnavailableError';
    this.reason = reason;
    this.cause = cause;
  }
}

/**
 * Structural check — survives the module-instance duplication you get when
 * the CLI and a test import through different specifiers. Callers use this
 * instead of `instanceof` for that reason.
 */
export function isRerankUnavailableError(err: unknown): err is RerankUnavailableError {
  return err instanceof Error && err.name === 'RerankUnavailableError';
}

/** SHA-256 prefix (8 chars) of the query text for privacy-preserving audit. */
function hashQuery(query: string): string {
  return createHash('sha256').update(query, 'utf8').digest('hex').slice(0, 8);
}

/**
 * Reorder the top `topNIn` results by reranker relevance score. The
 * un-reranked tail (any rows past topNIn) preserves its original RRF
 * position — appended after the reordered head in the same order it had
 * coming in.
 *
 * On reranker failure, logs to ~/.gbrain/audit/rerank-failures-* and
 * returns the input array unmodified. Never throws — UNLESS `opts.failClosed`
 * is set, in which case it throws `RerankUnavailableError` after logging.
 *
 * Empty input passes through immediately (no upstream call).
 */
export async function applyReranker(
  query: string,
  results: SearchResult[],
  opts: RerankerOpts,
): Promise<SearchResult[]> {
  if (!opts.enabled || results.length === 0) return results;
  // No documents to rerank when topNIn=0 — pass through (defensive; mode
  // bundles never set 0 in practice).
  if (opts.topNIn <= 0) return results;

  const head = results.slice(0, opts.topNIn);
  const tail = results.slice(opts.topNIn);

  const documents = await buildDocuments(query, head, opts);

  let reranked: RerankResult[];
  try {
    const rerankerFn = opts.rerankerFn ?? gatewayRerank;
    reranked = await rerankerFn({
      query,
      documents,
      timeoutMs: opts.timeoutMs,
      ...(opts.model ? { model: opts.model } : {}),
    });
  } catch (err) {
    const reason: RerankFailureReason =
      err instanceof RerankError ? err.reason : 'unknown';
    const errorSummary = err instanceof Error ? err.message : String(err);
    try {
      logRerankFailure({
        model: opts.model ?? 'unknown',
        reason,
        query_hash: hashQuery(query),
        doc_count: documents.length,
        error_summary: errorSummary,
      });
    } catch {
      // Audit logging must never break search.
    }
    if (opts.failClosed) throw new RerankUnavailableError(reason, errorSummary, err);
    return results;
  }

  // Defensive: if the reranker returned a malformed shape, pass through.
  if (!Array.isArray(reranked) || reranked.length === 0) {
    if (opts.failClosed) {
      throw new RerankUnavailableError(
        'malformed_response',
        `expected a non-empty RerankResult[], got ${Array.isArray(reranked) ? 'an empty array' : typeof reranked}`,
      );
    }
    return results;
  }

  // Build the reordered head. We keep ONLY indices the reranker returned
  // (so a top_n response with fewer items than head.length naturally
  // drops the missing ones — but since we don't pass top_n by default,
  // every input gets a score).
  const seen = new Set<number>();
  const reorderedHead: SearchResult[] = [];
  for (const r of reranked) {
    if (r.index >= 0 && r.index < head.length && !seen.has(r.index)) {
      seen.add(r.index);
      const item = head[r.index]!;
      // Stamp the reranker score onto the result so downstream callers
      // (telemetry, debug, autocut) can see the new ordering signal. Doesn't
      // replace `score` — that's RRF and other consumers may depend on it.
      item.rerank_score = r.relevanceScore;
      // v0.40.4 attribution stamp (D12=A) — rank delta. Positive means
      // rank improved (moved closer to top). new_index is the next
      // push position in reorderedHead; original index was r.index.
      item.reranker_delta = r.index - reorderedHead.length;
      reorderedHead.push(item);
    }
  }
  // If the reranker dropped some head items (rare; usually only happens
  // with explicit top_n), preserve their original positions at the end
  // of the head section so we don't silently lose recall.
  for (let i = 0; i < head.length; i++) {
    if (!seen.has(i)) reorderedHead.push(head[i]!);
  }

  const combined = [...reorderedHead, ...tail];
  return opts.topNOut !== null && opts.topNOut > 0
    ? combined.slice(0, opts.topNOut)
    : combined;
}
