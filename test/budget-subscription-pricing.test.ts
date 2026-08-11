/**
 * FRA-22903: `claude-cli:*` bills a flat-rate Claude subscription seat, not
 * metered API credit, so it must price at $0 in the budget ledger.
 *
 * Pre-fix, lookupPricing fell through to the `provider:model` tail lookup and
 * priced `claude-cli:claude-sonnet-4-6` off ANTHROPIC_PRICING['claude-sonnet-4-6']
 * at the metered $3/$15 per 1M. Routing work to the subscription in order to
 * *save* API credit therefore charged the API dollar cap and tripped the daily
 * ceiling — halting a run that had spent nothing.
 */

import { describe, expect, it, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetTracker } from '../src/core/budget/budget-tracker.ts';

const tmpDirs: string[] = [];
function auditPath(): string {
  const d = mkdtempSync(join(tmpdir(), 'gbrain-subprice-'));
  tmpDirs.push(d);
  return join(d, 'budget.jsonl');
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('subscription-billed providers price at $0 (FRA-22903)', () => {
  it('charges nothing for claude-cli chat traffic', () => {
    const t = new BudgetTracker({
      label: 'test:claude-cli',
      maxCostUsd: 1,
      auditPath: auditPath(),
      maxDailyCostUsd: 0,
    });

    // Token volume that would cost ~$1.65 at the metered Sonnet rate
    // (100k in @ $3/1M + 100k out @ $15/1M = $1.80) — enough to blow the $1
    // cap outright, which is exactly the pre-fix failure.
    t.record({
      modelId: 'claude-cli:claude-sonnet-4-6',
      inputTokens: 100_000,
      outputTokens: 100_000,
      kind: 'chat',
    });

    expect(t.snapshot().cumulativeCostUsd).toBe(0);
    expect(t.snapshot().callsRecorded).toBe(1);
  });

  it('still prices the metered anthropic recipe for the same model', () => {
    const t = new BudgetTracker({
      label: 'test:anthropic',
      auditPath: auditPath(),
      maxDailyCostUsd: 0,
    });

    t.record({
      modelId: 'anthropic:claude-sonnet-4-6',
      inputTokens: 100_000,
      outputTokens: 100_000,
      kind: 'chat',
    });

    // Guards against a blanket "anything claude is free" regression: the API
    // route must keep costing real money.
    expect(t.snapshot().cumulativeCostUsd).toBeGreaterThan(0);
  });

  it('keeps subscription token counts auditable despite the $0 price', () => {
    const p = auditPath();
    const t = new BudgetTracker({
      label: 'test:audit',
      auditPath: p,
      maxDailyCostUsd: 0,
    });

    t.record({
      modelId: 'claude-cli:claude-sonnet-4-6',
      inputTokens: 1234,
      outputTokens: 567,
      kind: 'chat',
    });

    expect(existsSync(p)).toBe(true);
    const rows = readFileSync(p, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l))
      .filter(r => r.event === 'record');

    expect(rows).toHaveLength(1);
    // $0 must mean "consumes no API credit", NOT "invisible": subscription
    // seats carry their own rate limits, so volume has to stay reviewable.
    expect(rows[0].model).toBe('claude-cli:claude-sonnet-4-6');
    expect(rows[0].input_tokens).toBe(1234);
    expect(rows[0].output_tokens).toBe(567);
    expect(Number(rows[0].actual_cost_usd)).toBe(0);
  });

  it('does not let subscription traffic consume the daily ceiling', () => {
    const t = new BudgetTracker({
      label: 'test:daily',
      auditPath: auditPath(),
      // A ceiling far below what this volume would cost on the metered route.
      maxDailyCostUsd: 0.5,
    });

    // Pre-fix this threw BudgetExhausted('daily_cost') after spending $0 of
    // real credit — the subscription route could not be used at all.
    for (let i = 0; i < 5; i++) {
      t.record({
        modelId: 'claude-cli:claude-sonnet-4-6',
        inputTokens: 50_000,
        outputTokens: 50_000,
        kind: 'chat',
      });
    }

    expect(t.snapshot().cumulativeCostUsd).toBe(0);
    expect(t.snapshot().callsRecorded).toBe(5);
  });
});
