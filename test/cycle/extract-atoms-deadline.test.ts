// FRA-23196 — wall-clock bound on runPhaseExtractAtoms.
//
// The phase inherited three nominal bounds from the drain it replaced
// (`b6656679`) and only the 50-page discovery cap was live: the $0.30
// BudgetTracker records $0.0000 under `claude-cli` subscription routing, and
// the drain's `windowSeconds` check was simply not carried over. These tests
// pin the replacement bound, and — just as importantly — pin that a deadline
// skip is reported in fields of its OWN, because the FRA-23196 trigger check
// reads `pages_skipped_budget` / `budget_exhausted` as proof the DOLLAR cap
// stopped being inert. Folding deadline skips into those would make the
// trigger misfire on every truncated batch.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { ChatResult, ChatOpts } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const ATOM_JSON = JSON.stringify([
  { title: 'A', atom_type: 'insight', body: 'body a' },
]);

function stubChat(): (o: ChatOpts) => Promise<ChatResult> {
  return async (_o: ChatOpts) => ({
    text: ATOM_JSON,
    blocks: [{ type: 'text', text: ATOM_JSON }],
    stopReason: 'end',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5',
    providerId: 'anthropic',
  });
}

function pages(n: number): Array<{ slug: string; content: string; contentHash: string }> {
  return Array.from({ length: n }, (_, i) => ({
    slug: `p${i}`,
    content: `page ${i} body`,
    contentHash: `${i}`.padStart(16, 'a'),
  }));
}

/**
 * Clock that advances `stepMs` on every read. The deadline is checked once
 * per work item, so a step larger than the window trips it after the first
 * item regardless of how fast the stub chat resolves.
 */
function tickingClock(startMs: number, stepMs: number): () => number {
  let t = startMs;
  return () => {
    const v = t;
    t += stepMs;
    return v;
  };
}

describe('extract_atoms wall-clock bound (FRA-23196)', () => {
  test('stops between items once the window is spent and reports warn', async () => {
    const r = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      dryRun: true,
      _transcripts: [],
      _pages: pages(5),
      _chat: stubChat(),
      windowSeconds: 10,
      // First read anchors the loop (t=0 → deadline 10_000); each later read
      // is +6s, so the check trips on the second item (t=12_000).
      _now: tickingClock(0, 6_000),
    });

    const d = r.details as Record<string, unknown>;
    expect(r.status).toBe('warn');
    expect(d.deadline_exceeded).toBe(true);
    expect(d.window_seconds).toBe(10);
    expect(Number(d.pages_skipped_deadline)).toBeGreaterThan(0);
    // Durable partial progress: the items before the deadline still ran.
    expect(Number(d.pages_processed)).toBeGreaterThan(0);
    expect(Number(d.pages_processed) + Number(d.pages_skipped_deadline)).toBe(5);
    expect(r.summary).toContain('deadline-skipped');
  });

  test('deadline skips stay OUT of the budget fields the trigger reads', async () => {
    const r = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      dryRun: true,
      _transcripts: [],
      _pages: pages(5),
      _chat: stubChat(),
      windowSeconds: 10,
      _now: tickingClock(0, 6_000),
    });

    const d = r.details as Record<string, unknown>;
    expect(d.deadline_exceeded).toBe(true);
    // These two are the FRA-23196 trigger-A predicate. A wall-clock stop must
    // not touch them or the trigger reads it as "the $0.30 cap went live".
    expect(d.budget_exhausted).toBe(false);
    expect(Number(d.pages_skipped_budget)).toBe(0);
  });

  test('a batch that finishes inside the window is ok, not warn', async () => {
    const r = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      dryRun: true,
      _transcripts: [],
      _pages: pages(3),
      _chat: stubChat(),
      windowSeconds: 3600,
      _now: tickingClock(0, 1_000),
    });

    const d = r.details as Record<string, unknown>;
    expect(r.status).toBe('ok');
    expect(d.deadline_exceeded).toBe(false);
    expect(Number(d.pages_skipped_deadline)).toBe(0);
    expect(Number(d.pages_processed)).toBe(3);
    expect(r.summary).not.toContain('deadline-skipped');
  });

  test('windowSeconds <= 0 disables the bound (escape hatch)', async () => {
    const r = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      dryRun: true,
      _transcripts: [],
      _pages: pages(4),
      _chat: stubChat(),
      windowSeconds: 0,
      // Clock races far past any plausible window; with the bound disabled
      // every item must still be processed.
      _now: tickingClock(0, 10_000_000),
    });

    const d = r.details as Record<string, unknown>;
    expect(r.status).toBe('ok');
    expect(d.deadline_exceeded).toBe(false);
    expect(Number(d.pages_processed)).toBe(4);
  });

  test('the default window is applied when nothing is configured', async () => {
    const r = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      dryRun: true,
      _transcripts: [],
      _pages: pages(2),
      _chat: stubChat(),
    });

    const d = r.details as Record<string, unknown>;
    // 900s = half the 1800s autopilot-cycle job timeout.
    expect(Number(d.window_seconds)).toBe(900);
    expect(d.deadline_exceeded).toBe(false);
    expect(Number(d.pages_processed)).toBe(2);
  });

  test('cycle.extract_atoms.window_seconds config overrides the default', async () => {
    await engine.setConfig('cycle.extract_atoms.window_seconds', '42');
    const r = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      dryRun: true,
      _transcripts: [],
      _pages: pages(2),
      _chat: stubChat(),
    });

    const d = r.details as Record<string, unknown>;
    expect(Number(d.window_seconds)).toBe(42);
  });

  test('an explicit windowSeconds opt beats the config (the drain path)', async () => {
    await engine.setConfig('cycle.extract_atoms.window_seconds', '900');
    const r = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      dryRun: true,
      _transcripts: [],
      _pages: pages(2),
      _chat: stubChat(),
      windowSeconds: 120,
    });

    const d = r.details as Record<string, unknown>;
    expect(Number(d.window_seconds)).toBe(120);
  });
});
