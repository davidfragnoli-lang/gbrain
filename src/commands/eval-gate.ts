/**
 * gbrain eval gate — fail CI on retrieval regressions OR correctness drops (v0.41).
 *
 * Two gating paths (per CEO D8 + eng D6/D7):
 *
 *   - Regression gate (--baseline X.baseline.ndjson): replays baseline
 *     queries against current brain; computes jaccard / top-1 stability /
 *     latency multiplier; catches REGRESSIONS during refactors.
 *
 *   - Correctness gate (--qrels Y.qrels.json): runs qrels queries against
 *     current brain via bare hybridSearch; computes recall@K /
 *     first_relevant_hit_rate / expected_top1_hit_rate; catches retrieval
 *     QUALITY drops against known-right answers.
 *
 * Both can be passed together; both must pass for verdict `pass`. At least
 * one must be set (usage error otherwise).
 *
 * Fail-closed posture (D3): any in-process throw from replay or
 * correctness-gate flips verdict to `fail` with a named breach. Per
 * codex round-2 #7, replay runs in-process (NOT spawn subprocess) to avoid
 * the gbrain-version-drift bug class for source-tree CI runs.
 *
 * Latency math CORRECTED (codex round-2 #2): the gate uses
 * `(baseline_mean_latency_ms + mean_latency_delta_ms) / baseline_mean_latency_ms <= multiplier`.
 * The earlier formula (`delta / baseline <= multiplier`) would let a 2.5x
 * slowdown pass at multiplier=2.0.
 *
 * Reranker posture (FRA-22966): both gates search FAIL-CLOSED. A reranker
 * outage degrades ordering enough to look like a catastrophic regression
 * (first_relevant_hit 0.571 → 0.143 on the validated qrels set), so instead
 * of scoring those queries the gate reports verdict `inconclusive`. That is
 * still a non-zero exit — a run whose reranker was down never gates anything
 * green — but it is distinguishable from a real quality drop, and it must
 * never be published as a baseline. `--allow-reranker-fail-open` restores the
 * pre-fix behavior for debugging.
 *
 * Exit codes: 0 PASS, 1 FAIL or INCONCLUSIVE (regression, throw, or reranker
 * outage), 2 USAGE.
 */

import { existsSync, readFileSync } from 'node:fs';
import type { BrainEngine } from '../core/engine.ts';
import {
  parseBaselineFile,
  type BaselineFile,
  type BaselineThresholds,
} from '../core/bench/baseline-file.ts';
import {
  DEFAULT_QRELS_THRESHOLDS,
  parseQrelsFile,
  type QrelsFile,
} from '../core/bench/qrels-file.ts';
import { runCorrectnessGate, type CorrectnessResult } from '../core/bench/correctness-gate.ts';
import { replayCore, type ReplaySummary } from './eval-replay.ts';

interface GateOpts {
  help?: boolean;
  baseline?: string;
  qrels?: string;
  k?: number;
  json?: boolean;
  thresholdJaccard?: number;
  thresholdTop1?: number;
  thresholdLatencyMultiplier?: number;
  thresholdRecallAtK?: number;
  thresholdFirstRelevantHit?: number;
  thresholdExpectedTop1?: number;
  allowRerankerFailOpen?: boolean;
}

interface Breach {
  metric: string;
  observed?: number;
  threshold?: number;
  reason?: string;
  error_tail?: string;
}

interface GateResult {
  schema_version: 1;
  /**
   * `inconclusive` (FRA-22966) = the reranker was unavailable for at least one
   * query, so the numbers below describe a degraded retrieval stack rather
   * than the brain. Exits non-zero like `fail`, but must not be treated as a
   * regression signal or published as a baseline.
   */
  verdict: 'pass' | 'fail' | 'inconclusive';
  regression_gate: {
    ran: boolean;
    baseline_path?: string;
    summary?: ReplaySummary;
    thresholds?: BaselineThresholds;
    latency_skipped?: boolean;
    breaches?: Breach[];
  };
  correctness_gate: {
    ran: boolean;
    qrels_path?: string;
    summary?: CorrectnessResult['summary'];
    thresholds?: {
      recall_at_k: number;
      first_relevant_hit: number;
      expected_top1: number;
    };
    breaches?: Breach[];
  };
}

function parseArgs(args: string[]): GateOpts {
  const opts: GateOpts = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];
    switch (arg) {
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--baseline':
        opts.baseline = next;
        i++;
        break;
      case '--qrels':
        opts.qrels = next;
        i++;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--allow-reranker-fail-open':
        opts.allowRerankerFailOpen = true;
        break;
      case '-k':
      case '--k':
        opts.k = Number(next);
        i++;
        break;
      case '--threshold-jaccard':
        opts.thresholdJaccard = Number(next);
        i++;
        break;
      case '--threshold-top1':
        opts.thresholdTop1 = Number(next);
        i++;
        break;
      case '--threshold-latency-multiplier':
        opts.thresholdLatencyMultiplier = Number(next);
        i++;
        break;
      case '--threshold-recall-at-k':
        opts.thresholdRecallAtK = Number(next);
        i++;
        break;
      case '--threshold-first-relevant-hit':
        opts.thresholdFirstRelevantHit = Number(next);
        i++;
        break;
      case '--threshold-expected-top1':
        opts.thresholdExpectedTop1 = Number(next);
        i++;
        break;
      default:
        break;
    }
  }
  return opts;
}

function printHelp(): void {
  console.log(`gbrain eval gate — fail CI on retrieval regressions or correctness drops

Usage:
  gbrain eval gate --baseline X.baseline.ndjson [flags]      # regression-only
  gbrain eval gate --qrels Y.qrels.json [flags]              # correctness-only
  gbrain eval gate --baseline X --qrels Y [flags]            # both required

Required (at least one):
  --baseline FILE              Baseline NDJSON from \`gbrain bench publish\`
  --qrels FILE                 Qrels JSON (\`{schema_version, queries: [...]}\` shape)

Thresholds (override baseline metadata; CLI > embedded > defaults):
  --threshold-jaccard FLOAT          Regression: mean Jaccard floor (default ${0.85})
  --threshold-top1 FLOAT             Regression: top-1 stability floor (default ${0.80})
  --threshold-latency-multiplier FLOAT
                                     Regression: current/baseline latency cap (default ${2.0}x)
  --threshold-recall-at-k FLOAT      Correctness: mean recall@k floor (default ${DEFAULT_QRELS_THRESHOLDS.recall_at_k})
  --threshold-first-relevant-hit FLOAT
                                     Correctness: first-relevant-hit-rate floor (default ${DEFAULT_QRELS_THRESHOLDS.first_relevant_hit})
  --threshold-expected-top1 FLOAT    Correctness: expected_top1-hit-rate floor (default ${DEFAULT_QRELS_THRESHOLDS.expected_top1})
  -k, --k N                          Top-K for recall@K (default ${DEFAULT_QRELS_THRESHOLDS.k})

Reranker posture:
  --allow-reranker-fail-open   Score queries even when the cross-encoder call
                               fails (pre-FRA-22966 behavior). Default is
                               fail-CLOSED: a reranker outage makes the run
                               INCONCLUSIVE instead of a fake regression.
                               Numbers from a fail-open run are NOT
                               baseline-worthy.

Output:
  --json                       Print JSON envelope to stdout
  -h, --help                   Show this help

Exit codes:
  0   All requested gates passed
  1   At least one breach (regression or correctness), in-process throw, OR an
      inconclusive run (reranker unavailable)
  2   Usage error (no flags, file missing, malformed JSON)
`);
}

/** Breach metric that downgrades the verdict to `inconclusive` (FRA-22966). */
const RERANKER_UNAVAILABLE_METRIC = 'reranker_unavailable';

function isFinitePos(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

/** True when any breach in the list is a reranker outage. */
function hasRerankerOutage(breaches: Breach[] | undefined): boolean {
  return (breaches ?? []).some(b => b.metric === RERANKER_UNAVAILABLE_METRIC);
}

/**
 * Headline verdict from both gates' breach lists (FRA-22966).
 *
 * A reranker outage outranks every other verdict: the surviving queries were
 * measured over a shrunken, non-comparable denominator, so neither `pass` nor
 * `fail` is a claim we can make. Co-occurring breaches stay in the envelope —
 * only the headline changes — and `inconclusive` still exits non-zero, so a
 * degraded run can never gate anything green.
 */
export function resolveVerdict(
  regressionBreaches: Breach[] | undefined,
  correctnessBreaches: Breach[] | undefined,
): GateResult['verdict'] {
  if (hasRerankerOutage(regressionBreaches) || hasRerankerOutage(correctnessBreaches)) {
    return 'inconclusive';
  }
  const anyBreach = (regressionBreaches?.length ?? 0) > 0 || (correctnessBreaches?.length ?? 0) > 0;
  return anyBreach ? 'fail' : 'pass';
}

function runRegressionGate(
  engine: BrainEngine,
  baselinePath: string,
  cliOverrides: Pick<GateOpts, 'thresholdJaccard' | 'thresholdTop1' | 'thresholdLatencyMultiplier' | 'allowRerankerFailOpen'>,
): Promise<GateResult['regression_gate']> {
  return (async () => {
    let baselineFile: BaselineFile;
    try {
      const content = readFileSync(baselinePath, 'utf-8');
      baselineFile = parseBaselineFile(content);
    } catch (err) {
      // USAGE-style failure (file missing or malformed). Surface as a gate
      // breach since the gate ran in PASS posture and now can't proceed.
      return {
        ran: true,
        baseline_path: baselinePath,
        breaches: [{
          metric: 'baseline_parse',
          reason: 'baseline_unreadable',
          error_tail: (err as Error).message,
        }],
      };
    }

    // Threshold precedence: CLI > embedded > defaults (defaults built into baseline at publish time).
    const thresholds: BaselineThresholds = {
      jaccard: cliOverrides.thresholdJaccard ?? baselineFile.metadata.thresholds.jaccard,
      top1: cliOverrides.thresholdTop1 ?? baselineFile.metadata.thresholds.top1,
      latency_multiplier: cliOverrides.thresholdLatencyMultiplier ?? baselineFile.metadata.thresholds.latency_multiplier,
    };

    let summary: ReplaySummary;
    try {
      const out = await replayCore(engine, {
        against: baselinePath,
        allowRerankerFailOpen: cliOverrides.allowRerankerFailOpen,
      });
      summary = out.summary;
    } catch (err) {
      // D3 fail-closed on in-process throw (codex round-2 #7).
      return {
        ran: true,
        baseline_path: baselinePath,
        thresholds,
        breaches: [{
          metric: 'replay_in_process',
          reason: 'replay_threw',
          error_tail: (err as Error).message,
        }],
      };
    }

    const breaches: Breach[] = [];
    // FRA-22966 — replayed rows whose reranker call failed are excluded from
    // mean_jaccard, so the metrics below describe a partial row set. Flag it
    // before the threshold comparisons so the verdict reads `inconclusive`.
    if (summary.rows_reranker_unavailable > 0) {
      breaches.push({
        metric: RERANKER_UNAVAILABLE_METRIC,
        observed: summary.rows_reranker_unavailable,
        threshold: 0,
        reason: 'reranker_unavailable_run_not_measurable',
      });
    }
    if (summary.mean_jaccard < thresholds.jaccard) {
      breaches.push({
        metric: 'mean_jaccard',
        observed: summary.mean_jaccard,
        threshold: thresholds.jaccard,
      });
    }
    if (summary.top1_stability_rate < thresholds.top1) {
      breaches.push({
        metric: 'top1_stability_rate',
        observed: summary.top1_stability_rate,
        threshold: thresholds.top1,
      });
    }

    // Corrected latency math (codex round-2 #2):
    // ratio = (baseline + delta) / baseline; must be <= multiplier.
    // Skip the check when baseline_mean_latency_ms <= 0 (synthetic baselines).
    const baselineMean = baselineFile.metadata.baseline_mean_latency_ms;
    let latencySkipped = false;
    if (isFinitePos(baselineMean)) {
      const ratio = (baselineMean + summary.mean_latency_delta_ms) / baselineMean;
      if (ratio > thresholds.latency_multiplier) {
        breaches.push({
          metric: 'latency_ratio',
          observed: ratio,
          threshold: thresholds.latency_multiplier,
        });
      }
    } else {
      latencySkipped = true;
      console.error(
        `[eval gate] WARN: baseline_mean_latency_ms is ${baselineMean}; skipping latency check.`,
      );
    }

    return {
      ran: true,
      baseline_path: baselinePath,
      summary,
      thresholds,
      ...(latencySkipped ? { latency_skipped: true } : {}),
      ...(breaches.length > 0 ? { breaches } : {}),
    };
  })();
}

function runCorrectnessGateDispatch(
  engine: BrainEngine,
  qrelsPath: string,
  k: number,
  cliOverrides: Pick<GateOpts, 'thresholdRecallAtK' | 'thresholdFirstRelevantHit' | 'thresholdExpectedTop1' | 'allowRerankerFailOpen'>,
): Promise<GateResult['correctness_gate']> {
  return (async () => {
    let qrelsFile: QrelsFile;
    try {
      const content = readFileSync(qrelsPath, 'utf-8');
      qrelsFile = parseQrelsFile(content);
    } catch (err) {
      return {
        ran: true,
        qrels_path: qrelsPath,
        breaches: [{
          metric: 'qrels_parse',
          reason: 'qrels_unreadable',
          error_tail: (err as Error).message,
        }],
      };
    }

    const thresholds = {
      recall_at_k: cliOverrides.thresholdRecallAtK ?? DEFAULT_QRELS_THRESHOLDS.recall_at_k,
      first_relevant_hit: cliOverrides.thresholdFirstRelevantHit ?? DEFAULT_QRELS_THRESHOLDS.first_relevant_hit,
      expected_top1: cliOverrides.thresholdExpectedTop1 ?? DEFAULT_QRELS_THRESHOLDS.expected_top1,
    };

    let result: CorrectnessResult;
    try {
      result = await runCorrectnessGate(engine, qrelsFile, {
        k,
        allowRerankerFailOpen: cliOverrides.allowRerankerFailOpen,
      });
    } catch (err) {
      return {
        ran: true,
        qrels_path: qrelsPath,
        thresholds,
        breaches: [{
          metric: 'correctness_gate',
          reason: 'orchestrator_threw',
          error_tail: (err as Error).message,
        }],
      };
    }

    const breaches: Breach[] = [];
    // FRA-22966: reranker outages are reported on their own metric so the
    // caller can tell "un-measurable" apart from "the brain got worse". They
    // are still breaches — the run never passes — but they set verdict
    // `inconclusive`.
    if (result.summary.queries_reranker_unavailable > 0) {
      const downQueries = result.per_query.filter(p => p.reranker_unavailable).slice(0, 5);
      breaches.push({
        metric: RERANKER_UNAVAILABLE_METRIC,
        observed: result.summary.queries_reranker_unavailable,
        threshold: 0,
        reason: 'reranker_unavailable_run_not_measurable',
        error_tail: downQueries.map(p => `${p.query_id}: ${p.error_message}`).join(' | '),
      });
    }
    const otherErrored = result.per_query.filter(p => p.errored && !p.reranker_unavailable);
    if (otherErrored.length > 0) {
      // Per-query throws are gate failures (Finding 2D).
      breaches.push({
        metric: 'queries_errored',
        observed: otherErrored.length,
        threshold: 0,
        reason: 'one_or_more_qrels_queries_threw',
        error_tail: otherErrored.slice(0, 5).map(p => `${p.query_id}: ${p.error_message}`).join(' | '),
      });
    }
    if (result.summary.mean_recall_at_k < thresholds.recall_at_k) {
      breaches.push({
        metric: 'mean_recall_at_k',
        observed: result.summary.mean_recall_at_k,
        threshold: thresholds.recall_at_k,
      });
    }
    if (result.summary.first_relevant_hit_rate < thresholds.first_relevant_hit) {
      breaches.push({
        metric: 'first_relevant_hit_rate',
        observed: result.summary.first_relevant_hit_rate,
        threshold: thresholds.first_relevant_hit,
      });
    }
    // Only enforce expected_top1 floor when at least one query had it set.
    if (result.summary.expected_top1_denominator > 0 &&
        result.summary.expected_top1_hit_rate < thresholds.expected_top1) {
      breaches.push({
        metric: 'expected_top1_hit_rate',
        observed: result.summary.expected_top1_hit_rate,
        threshold: thresholds.expected_top1,
      });
    }

    return {
      ran: true,
      qrels_path: qrelsPath,
      summary: result.summary,
      thresholds,
      ...(breaches.length > 0 ? { breaches } : {}),
    };
  })();
}

function printHumanOutput(result: GateResult): void {
  const overall = result.verdict === 'pass'
    ? '✅ PASS'
    : result.verdict === 'inconclusive'
      ? '⚠️  INCONCLUSIVE'
      : '❌ FAIL';
  console.log(`Verdict: ${overall}`);
  if (result.verdict === 'inconclusive') {
    console.log('  The cross-encoder reranker was unavailable for one or more queries.');
    console.log('  This is NOT a retrieval regression, and these numbers must NOT be');
    console.log('  published as a baseline. Re-run once the reranker provider is healthy.');
  }
  console.log('');

  if (result.regression_gate.ran) {
    console.log('Regression gate (--baseline)');
    const r = result.regression_gate;
    if (r.summary) {
      console.log(`  mean_jaccard:        ${r.summary.mean_jaccard.toFixed(3)} (floor ${r.thresholds?.jaccard ?? '?'})`);
      console.log(`  top1_stability:      ${(r.summary.top1_stability_rate * 100).toFixed(1)}% (floor ${(((r.thresholds?.top1 ?? 0)) * 100).toFixed(0)}%)`);
      if (!r.latency_skipped) {
        console.log(`  mean_latency_delta:  ${r.summary.mean_latency_delta_ms >= 0 ? '+' : ''}${r.summary.mean_latency_delta_ms.toFixed(0)}ms`);
      } else {
        console.log(`  latency:             SKIPPED (baseline_mean_latency_ms <= 0)`);
      }
    }
    if (r.breaches && r.breaches.length > 0) {
      console.log(`  BREACHES:`);
      for (const b of r.breaches) {
        const obs = b.observed !== undefined ? ` observed=${b.observed.toFixed(3)}` : '';
        const thr = b.threshold !== undefined ? ` threshold=${b.threshold.toFixed(3)}` : '';
        const reason = b.reason ? ` reason=${b.reason}` : '';
        console.log(`    - ${b.metric}${obs}${thr}${reason}`);
        if (b.error_tail) console.log(`      ${b.error_tail.slice(0, 200)}`);
      }
    }
    console.log('');
  }

  if (result.correctness_gate.ran) {
    console.log('Correctness gate (--qrels)');
    const c = result.correctness_gate;
    if (c.summary) {
      const rerankerNote = c.summary.queries_reranker_unavailable > 0
        ? `, ${c.summary.queries_reranker_unavailable} reranker-unavailable`
        : '';
      console.log(`  queries_run:           ${c.summary.queries_run}/${c.summary.queries_total} (${c.summary.queries_errored} errored${rerankerNote})`);
      console.log(`  mean_recall@${c.summary.k}:        ${c.summary.mean_recall_at_k.toFixed(3)} (floor ${c.thresholds?.recall_at_k ?? '?'})`);
      console.log(`  first_relevant_hit:    ${(c.summary.first_relevant_hit_rate * 100).toFixed(1)}% (floor ${(((c.thresholds?.first_relevant_hit ?? 0)) * 100).toFixed(0)}%)`);
      if (c.summary.expected_top1_denominator > 0) {
        console.log(`  expected_top1_hit:     ${(c.summary.expected_top1_hit_rate * 100).toFixed(1)}% over ${c.summary.expected_top1_denominator} queries (floor ${(((c.thresholds?.expected_top1 ?? 0)) * 100).toFixed(0)}%)`);
      }
    }
    if (c.breaches && c.breaches.length > 0) {
      console.log(`  BREACHES:`);
      for (const b of c.breaches) {
        const obs = b.observed !== undefined ? ` observed=${typeof b.observed === 'number' ? b.observed.toFixed(3) : b.observed}` : '';
        const thr = b.threshold !== undefined ? ` threshold=${typeof b.threshold === 'number' ? b.threshold.toFixed(3) : b.threshold}` : '';
        const reason = b.reason ? ` reason=${b.reason}` : '';
        console.log(`    - ${b.metric}${obs}${thr}${reason}`);
        if (b.error_tail) console.log(`      ${b.error_tail.slice(0, 200)}`);
      }
    }
  }
}

export async function runEvalGate(engine: BrainEngine, args: string[]): Promise<void> {
  const opts = parseArgs(args);
  if (opts.help) {
    printHelp();
    return;
  }

  if (!opts.baseline && !opts.qrels) {
    console.error('Error: at least one of --baseline or --qrels must be set\n');
    printHelp();
    process.exit(2);
  }

  if (opts.baseline && !existsSync(opts.baseline)) {
    console.error(`Error: baseline file not found: ${opts.baseline}`);
    process.exit(2);
  }
  if (opts.qrels && !existsSync(opts.qrels)) {
    console.error(`Error: qrels file not found: ${opts.qrels}`);
    process.exit(2);
  }

  const result: GateResult = {
    schema_version: 1,
    verdict: 'pass',
    regression_gate: { ran: false },
    correctness_gate: { ran: false },
  };

  if (opts.baseline) {
    result.regression_gate = await runRegressionGate(engine, opts.baseline, {
      thresholdJaccard: opts.thresholdJaccard,
      thresholdTop1: opts.thresholdTop1,
      thresholdLatencyMultiplier: opts.thresholdLatencyMultiplier,
      allowRerankerFailOpen: opts.allowRerankerFailOpen,
    });
  }

  if (opts.qrels) {
    const k = opts.k ?? DEFAULT_QRELS_THRESHOLDS.k;
    result.correctness_gate = await runCorrectnessGateDispatch(engine, opts.qrels, k, {
      thresholdRecallAtK: opts.thresholdRecallAtK,
      thresholdFirstRelevantHit: opts.thresholdFirstRelevantHit,
      thresholdExpectedTop1: opts.thresholdExpectedTop1,
      allowRerankerFailOpen: opts.allowRerankerFailOpen,
    });
  }

  result.verdict = resolveVerdict(
    result.regression_gate.breaches,
    result.correctness_gate.breaches,
  );

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHumanOutput(result);
  }

  // `inconclusive` exits non-zero too — a run whose reranker was down must
  // never gate anything green (FRA-22966).
  if (result.verdict !== 'pass') process.exit(1);
}

// Exported for tests + e2e LOOP test
export type { GateResult, Breach };
