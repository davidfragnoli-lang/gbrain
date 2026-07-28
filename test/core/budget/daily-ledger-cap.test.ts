/**
 * FRA-22903 — cross-process daily spend ceiling.
 *
 * The failure this pins: `maxCostUsd` bounds ONE invocation and resets on every
 * new tracker, so a phase capped at $5/cycle running every ~10min had a
 * structural ceiling of ~$720/day. These tests assert that a repeating caller
 * is now bounded, that the bound is shared across processes via the ledger, and
 * that the ledger total is never double-counted.
 *
 * Hermetic: no DB, no network, no ~/.gbrain. Every tracker gets a tmpdir
 * `auditPath`, which also pins `dailyLedgerPaths` to that one file.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from '../../helpers/with-env.ts';
import { BudgetTracker, BudgetExhausted } from '../../../src/core/budget/budget-tracker.ts';
import {
  readDailySpendUsd,
  resolveDailyCapUsd,
  DEFAULT_MAX_DAILY_COST_USD,
  _resetDailyLedgerCacheForTest,
} from '../../../src/core/budget/daily-ledger-cap.ts';

const MODEL = 'claude-sonnet-4-6';

let tmp: string;
let auditPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-daily-cap-'));
  auditPath = join(tmp, 'budget.jsonl');
  _resetDailyLedgerCacheForTest();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A `record` row shaped exactly like the ones BudgetTracker.record() writes. */
function recordRow(costUsd: number, ts: string): string {
  return JSON.stringify({
    schema_version: 1,
    ts,
    event: 'record',
    label: 'test',
    kind: 'chat',
    model: MODEL,
    input_tokens: 1000,
    output_tokens: 100,
    actual_cost_usd: costUsd,
    cumulative_cost_usd: costUsd,
  }) + '\n';
}

function todayTs(hhmmss = '12:00:00'): string {
  return `${new Date().toISOString().slice(0, 10)}T${hhmmss}.000Z`;
}

function yesterdayTs(): string {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return `${d.toISOString().slice(0, 10)}T12:00:00.000Z`;
}

describe('readDailySpendUsd', () => {
  test('sums only today\'s record rows, ignoring prior days', () => {
    writeFileSync(
      auditPath,
      recordRow(5, yesterdayTs()) + recordRow(1.5, todayTs()) + recordRow(2.5, todayTs()),
    );
    expect(readDailySpendUsd([auditPath])).toBeCloseTo(4.0, 6);
  });

  test('ignores non-record events (reserve, denial, unpriced)', () => {
    writeFileSync(
      auditPath,
      JSON.stringify({ event: 'reserve', ts: todayTs(), projected_cost_usd: 99 }) + '\n' +
        JSON.stringify({ event: 'reserve_denied', ts: todayTs(), projected_cost_usd: 99 }) + '\n' +
        JSON.stringify({ event: 'record_unpriced', ts: todayTs(), input_tokens: 10 }) + '\n' +
        recordRow(3, todayTs()),
    );
    expect(readDailySpendUsd([auditPath])).toBeCloseTo(3.0, 6);
  });

  test('picks up rows appended by another process (incremental read)', () => {
    writeFileSync(auditPath, recordRow(2, todayTs()));
    expect(readDailySpendUsd([auditPath])).toBeCloseTo(2.0, 6);

    // Simulate a concurrent gbrain process appending to the shared ledger.
    appendFileSync(auditPath, recordRow(3, todayTs()));
    // forceFresh bypasses the read throttle, as the near-cap path does.
    expect(readDailySpendUsd([auditPath], { forceFresh: true })).toBeCloseTo(5.0, 6);
  });

  test('does not double-count when re-read (total is ledger-derived only)', () => {
    writeFileSync(auditPath, recordRow(2, todayTs()) + recordRow(3, todayTs()));
    for (let i = 0; i < 5; i++) {
      expect(readDailySpendUsd([auditPath], { forceFresh: true })).toBeCloseTo(5.0, 6);
    }
  });

  test('handles a line split across two appends', () => {
    const row = recordRow(4, todayTs());
    const cut = Math.floor(row.length / 2);
    writeFileSync(auditPath, row.slice(0, cut));
    // Partial line must contribute nothing yet — parsing it would throw.
    expect(readDailySpendUsd([auditPath], { forceFresh: true })).toBeCloseTo(0, 6);
    appendFileSync(auditPath, row.slice(cut));
    expect(readDailySpendUsd([auditPath], { forceFresh: true })).toBeCloseTo(4.0, 6);
  });

  test('skips malformed rows instead of throwing', () => {
    writeFileSync(auditPath, '{"event":"record" NOT JSON\n' + recordRow(1, todayTs()));
    expect(readDailySpendUsd([auditPath], { forceFresh: true })).toBeCloseTo(1.0, 6);
  });

  test('missing ledger reads as $0 rather than throwing', () => {
    expect(readDailySpendUsd([join(tmp, 'does-not-exist.jsonl')])).toBe(0);
  });

  test('recovers from truncation by rescanning (size shrank)', () => {
    writeFileSync(auditPath, recordRow(6, todayTs()) + recordRow(6, todayTs()));
    expect(readDailySpendUsd([auditPath], { forceFresh: true })).toBeCloseTo(12.0, 6);
    // Shorter file: the cached offset now points past EOF and is meaningless.
    writeFileSync(auditPath, recordRow(1, todayTs()));
    expect(readDailySpendUsd([auditPath], { forceFresh: true })).toBeCloseTo(1.0, 6);
  });

  test('recovers from replacement by rescanning (inode changed)', () => {
    // A same-size replacement is invisible to a size check, so the reader also
    // compares inodes — this is the case rotation actually produces.
    writeFileSync(auditPath, recordRow(6, todayTs()));
    expect(readDailySpendUsd([auditPath], { forceFresh: true })).toBeCloseTo(6.0, 6);
    rmSync(auditPath);
    writeFileSync(auditPath, recordRow(1, todayTs()));
    expect(readDailySpendUsd([auditPath], { forceFresh: true })).toBeCloseTo(1.0, 6);
  });

  test('own rows can be excluded so a live tracker substitutes its exact total', () => {
    writeFileSync(
      auditPath,
      JSON.stringify({
        schema_version: 1, ts: todayTs(), event: 'record', label: 'other',
        actual_cost_usd: 4, tracker_id: 'other-proc',
      }) + '\n' +
      JSON.stringify({
        schema_version: 1, ts: todayTs(), event: 'record', label: 'mine',
        actual_cost_usd: 6, tracker_id: 'mine',
      }) + '\n',
    );
    expect(readDailySpendUsd([auditPath], { forceFresh: true })).toBeCloseTo(10.0, 6);
    expect(
      readDailySpendUsd([auditPath], { forceFresh: true, excludeTrackerId: 'mine' }),
    ).toBeCloseTo(4.0, 6);
  });
});

describe('resolveDailyCapUsd', () => {
  test('defaults to DEFAULT_MAX_DAILY_COST_USD when nothing is set', async () => {
    await withEnv({ GBRAIN_MAX_DAILY_COST_USD: undefined }, () => {
      expect(resolveDailyCapUsd()).toBe(DEFAULT_MAX_DAILY_COST_USD);
    });
  });

  test('explicit option wins over env', async () => {
    await withEnv({ GBRAIN_MAX_DAILY_COST_USD: '250' }, () => {
      expect(resolveDailyCapUsd(30)).toBe(30);
    });
  });

  test('env overrides the default', async () => {
    await withEnv({ GBRAIN_MAX_DAILY_COST_USD: '250' }, () => {
      expect(resolveDailyCapUsd()).toBe(250);
    });
  });

  test('0 and "off" disable the gate (deliberate, auditable escape hatch)', async () => {
    await withEnv({ GBRAIN_MAX_DAILY_COST_USD: undefined }, () => {
      expect(resolveDailyCapUsd(0)).toBeUndefined();
    });
    await withEnv({ GBRAIN_MAX_DAILY_COST_USD: 'off' }, () => {
      expect(resolveDailyCapUsd()).toBeUndefined();
    });
  });

  test('a typo falls back to the default rather than running uncapped', async () => {
    await withEnv({ GBRAIN_MAX_DAILY_COST_USD: 'ten dollars' }, () => {
      expect(resolveDailyCapUsd()).toBe(DEFAULT_MAX_DAILY_COST_USD);
    });
  });
});

describe('BudgetTracker daily ceiling (the FRA-22903 regression)', () => {
  test('a repeating caller is bounded even though each tracker starts fresh', () => {
    // Reproduces the 2026-07-27 shape: a phase capped at $5 per invocation,
    // re-invoked in a loop. Pre-fix this could run forever; the day ceiling
    // must stop it.
    writeFileSync(auditPath, '');
    const DAILY = 12;
    let cycles = 0;
    let denied = false;

    for (let i = 0; i < 100; i++) {
      // Each cycle builds a NEW tracker with its own $5 cap — the exact
      // pattern in cycle/conversation-facts-backfill.ts.
      const tracker = new BudgetTracker({
        maxCostUsd: 5,
        maxDailyCostUsd: DAILY,
        label: 'conversation_facts_backfill:brain-wide',
        auditPath,
      });
      try {
        // ~$1.5/call at sonnet pricing: 100k in + 100k out.
        for (let call = 0; call < 4; call++) {
          tracker.reserve({
            modelId: MODEL,
            estimatedInputTokens: 100_000,
            maxOutputTokens: 100_000,
            kind: 'chat',
          });
          tracker.record({ modelId: MODEL, inputTokens: 100_000, outputTokens: 100_000, kind: 'chat' });
        }
      } catch (err) {
        if (err instanceof BudgetExhausted && err.reason === 'daily_cost') {
          denied = true;
          break;
        }
        // per-invocation cap hit: that is the loop continuing to the next cycle
      }
      cycles++;
    }

    expect(denied).toBe(true);
    // The whole point: it stopped, and it stopped near the day ceiling.
    const spent = readDailySpendUsd([auditPath], { forceFresh: true });
    expect(spent).toBeLessThanOrEqual(DAILY);
    expect(cycles).toBeLessThan(100);
  });

  test('reserve() denies when the day total is already at the ceiling', () => {
    // Spend recorded by an *earlier process* today.
    writeFileSync(auditPath, recordRow(20, todayTs('01:00:00')));
    const tracker = new BudgetTracker({
      maxCostUsd: 5,
      maxDailyCostUsd: 20,
      label: 'later-process',
      auditPath,
    });

    expect(() =>
      tracker.reserve({
        modelId: MODEL,
        estimatedInputTokens: 1000,
        maxOutputTokens: 1000,
        kind: 'chat',
      }),
    ).toThrow(BudgetExhausted);

    // ...and it is the DAILY reason, not the per-invocation one: this tracker
    // has spent $0 of its own $5.
    try {
      tracker.reserve({ modelId: MODEL, estimatedInputTokens: 1000, maxOutputTokens: 1000, kind: 'chat' });
    } catch (err) {
      expect((err as BudgetExhausted).reason).toBe('daily_cost');
      expect((err as BudgetExhausted).cap).toBe(20);
    }
    expect(tracker.totalSpent).toBe(0);
  });

  test('writes a daily_cap_denied audit row an operator can grep', () => {
    writeFileSync(auditPath, recordRow(20, todayTs('01:00:00')));
    const tracker = new BudgetTracker({
      maxDailyCostUsd: 20,
      label: 'phase-x',
      auditPath,
    });
    expect(() =>
      tracker.reserve({ modelId: MODEL, estimatedInputTokens: 1000, maxOutputTokens: 1000, kind: 'chat' }),
    ).toThrow(BudgetExhausted);

    const rows = readFileSync(auditPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const denial = rows.find((r) => r.event === 'daily_cap_denied');
    expect(denial).toBeDefined();
    expect(denial!.schema_version).toBe(1);
    expect(denial!.label).toBe('phase-x');
    expect(denial!.max_daily_cost_usd).toBe(20);
    expect(denial!.daily_spent_usd).toBeCloseTo(20, 6);
  });

  test('yesterday\'s spend does not count against today', () => {
    writeFileSync(auditPath, recordRow(500, yesterdayTs()));
    const tracker = new BudgetTracker({
      maxDailyCostUsd: 20,
      label: 'fresh-day',
      auditPath,
    });
    expect(() =>
      tracker.reserve({ modelId: MODEL, estimatedInputTokens: 1000, maxOutputTokens: 1000, kind: 'chat' }),
    ).not.toThrow();
  });

  test('disabled ceiling (0) restores uncapped behavior for authorised programs', () => {
    writeFileSync(auditPath, recordRow(5000, todayTs()));
    const tracker = new BudgetTracker({
      maxDailyCostUsd: 0,
      label: 'authorised-drain',
      auditPath,
    });
    expect(() =>
      tracker.reserve({ modelId: MODEL, estimatedInputTokens: 1000, maxOutputTokens: 1000, kind: 'chat' }),
    ).not.toThrow();
  });

  test('a normal small run under the ceiling is unaffected', () => {
    writeFileSync(auditPath, '');
    const tracker = new BudgetTracker({
      maxCostUsd: 5,
      maxDailyCostUsd: 100,
      label: 'ordinary',
      auditPath,
    });
    tracker.reserve({ modelId: MODEL, estimatedInputTokens: 1000, maxOutputTokens: 500, kind: 'chat' });
    tracker.record({ modelId: MODEL, inputTokens: 1000, outputTokens: 500, kind: 'chat' });
    expect(tracker.totalSpent).toBeGreaterThan(0);
    expect(tracker.totalSpent).toBeLessThan(1);
  });
});
