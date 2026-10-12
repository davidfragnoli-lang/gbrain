/**
 * `embed` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler } from '../types.ts';
import { assertEmbedNotStalled } from '../../embed-stall.ts';
import type { PaceKeyOverrides } from '../../pace-mode.ts';
import { BudgetTracker } from '../../budget/budget-tracker.ts';
import { getCurrentBudgetTracker, withBudgetTracker } from '../../ai/gateway.ts';
import { observeAIInvocations, withAIAttribution } from '../../ai/invocation-guard.ts';
import { spendBasis, type SpendAuthorization } from '../spend-record.ts';
import type { MinionJobContext } from '../types.ts';

export interface EmbedJobUsage {
  job_id: number;
  calls: number;
  calls_with_unknown_usage: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  spend_basis: ReturnType<typeof spendBasis> & { authorization: SpendAuthorization | null };
}

/** Job-bound embedding usage persisted in result/progress without a provider call of its own. */
export async function runEmbedJobWithAccounting<T>(
  job: MinionJobContext,
  operation: 'embed' | 'embed-catch-up',
  run: () => Promise<T>,
): Promise<{ value: T; usage: EmbedJobUsage }> {
  const usage = {
    job_id: job.id, calls: 0, calls_with_unknown_usage: 0, input_tokens: 0, output_tokens: 0,
    cache_read_tokens: 0, cache_write_tokens: 0,
  };
  const tracker = getCurrentBudgetTracker() ?? new BudgetTracker({ label: `${operation}:job:${job.id}` });
  const spentBefore = tracker.totalSpent;
  let value!: T;
  let thrown: unknown;
  let failed = false;
  const dispose = observeAIInvocations(event => {
    if (String(event.attribution?.job_id) !== String(job.id) || event.call.kind !== 'embedding') return;
    usage.calls += 1;
    if (!event.usage) { usage.calls_with_unknown_usage += 1; return; }
    usage.input_tokens += event.usage.inputTokens;
    usage.output_tokens += event.usage.outputTokens;
    usage.cache_read_tokens += event.usage.cacheReadTokens ?? 0;
    usage.cache_write_tokens += event.usage.cacheWriteTokens ?? 0;
  });
  try {
    value = await withAIAttribution({ job_id: job.id, job_name: job.name, effect: operation },
      () => getCurrentBudgetTracker() ? run() : withBudgetTracker(tracker, run));
  } catch (error) {
    failed = true;
    thrown = error;
  }
  dispose();
  const basis = spendBasis({ spend_authorization: job.spend?.record ?? null });
  const record: EmbedJobUsage = { ...usage, cost_usd: Math.max(0, tracker.totalSpent - spentBefore),
    spend_basis: { ...basis, authorization: job.spend?.record ?? null } };
  await job.updateTokens?.({ input: record.input_tokens, output: record.output_tokens, cache_read: record.cache_read_tokens });
  await job.updateProgress?.({ phase: 'embed.usage', usage: record });
  if (failed) throw thrown;
  return { value, usage: record };
}

export function makeEmbedHandler(engine: BrainEngine): MinionHandler {
  return async (job) => {
    const { runEmbedCore } = await import('../../../commands/embed.ts');
    // Primary Minion progress channel is job.updateProgress (DB-backed,
    // readable via `gbrain jobs get <id>`). Stderr from the worker daemon
    // only emits coarse job-start / job-done lines; per-page detail lives
    // in the DB. Per Codex review #20.
    const accounted = await runEmbedJobWithAccounting(job, 'embed', () => runEmbedCore(engine, {
      slug: typeof job.data.slug === 'string' ? job.data.slug : undefined,
      slugs: Array.isArray(job.data.slugs) ? (job.data.slugs as string[]) : undefined,
      all: !!job.data.all,
      stale: job.data.all ? false : (job.data.stale !== false),
      // `embed --background` serializes dryRun into the payload (embed.ts's
      // job-args builder). Not reading it back here meant a backgrounded
      // preview embedded for real: API spend and NULL->vector writes from an
      // invocation whose whole point was to do neither.
      dryRun: !!job.data.dryRun,
      sourceId: typeof job.data.sourceId === 'string' ? job.data.sourceId : undefined,
      // Background parity (D7): the doc-recommended recovery
      // `embed --stale --catch-up --include-null-signature --background`
      // used to silently DEGRADE — the payload dropped these four, so the
      // job ran as a plain 30-min-budget stale pass with the grandfather
      // clause intact. Serialize + read them like every other embed knob.
      catchUp: !!job.data.catchUp,
      includeNullSignature: !!job.data.includeNullSignature,
      batchSize: typeof job.data.batchSize === 'number' ? job.data.batchSize : undefined,
      priority: job.data.priority === 'recent' ? 'recent' : undefined,
      // CX1+CX5: pace overrides ride in the job payload as explicit overrides
      // only; runEmbedCore re-resolves env > config > bundle at execution so
      // GBRAIN_PACE_* still wins during an incident.
      ...(job.data.pace && typeof job.data.pace === 'object'
        ? {
            pace: job.data.pace as { perCallMode?: string; perCall?: PaceKeyOverrides },
            // Serialized from the queued payload → config tier so GBRAIN_PACE_*
            // on the worker still wins at execution (Codex P2 escape hatch).
            paceFromBackground: true,
          }
        : {}),
      onProgress: (done, total, embedded) => {
        // Fire-and-forget: progress updates are best-effort and must not
        // block the worker loop.
        job.updateProgress({ done, total, embedded, phase: 'embed.pages' }).catch(() => {});
      },
    }));
    const embedResult = accounted.value;
    // #4599 (X6): a stall-watchdog abort is an error RESULT from core; the
    // handler layer converts it to a FAILED JOB (throw) — never process.exit.
    assertEmbedNotStalled(embedResult);
    // Report what happened, not a constant. `embedded: true` claimed a dry run
    // had embedded, which is the same lie in miniature: `gbrain jobs get`
    // showed it. `embedded` stays the key it always was and stays truthy on a
    // real run (it is now the count, 0 on a dry run).
    return {
      embedded: embedResult.embedded,
      dry_run: !!embedResult.dryRun,
      would_embed: embedResult.would_embed,
      failures: embedResult.failures,
      usage: accounted.usage,
    };
  };
}
