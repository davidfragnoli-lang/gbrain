/**
 * issue #1801 fix #3 — doctor surfaces the wedged-queue signature as a health
 * ERROR (and the latent `state`→`status` regression in the remote queue_health
 * check is gone).
 *
 * computeWedgedQueueCheck is Postgres-only (short-circuits to ok on PGLite), so
 * we run its grouped SQL on a real PGLite engine behind a `kind: 'postgres'`
 * stub. Seeds verify: wedged → fail; live-lock → ok; null-completions →
 * conservative ok (the supervisor's startup-grace-aware watchdog owns that case);
 * per-queue grouping so a healthy queue doesn't mask a wedged one (Codex #15).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { computeQueueHealthCheck, computeWedgedQueueCheck } from '../src/commands/doctor.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let base: PGLiteEngine;
let pgLike: BrainEngine;

beforeAll(async () => {
  base = new PGLiteEngine();
  await base.connect({});
  await base.initSchema();
  // computeWedgedQueueCheck only reads .kind + .executeRaw.
  pgLike = {
    kind: 'postgres',
    executeRaw: base.executeRaw.bind(base),
  } as unknown as BrainEngine;
});

afterAll(async () => {
  await base.disconnect();
});

beforeEach(async () => {
  // Wipe only minion_jobs (preserve config/version that ensureSchema reads).
  await base.executeRaw('DELETE FROM minion_jobs');
});

async function seed(
  queue: string,
  name: string,
  status: string,
  extra: {
    lockUntilSql?: string;
    updatedAtSql?: string;
    createdAtSql?: string;
    // FRA-23078: the backlog-vs-wedge split reads finished_at (drain rate) and
    // started_at (in-flight work), so seeds need to set them.
    finishedAtSql?: string;
    startedAtSql?: string;
  } = {},
): Promise<void> {
  await base.executeRaw(
    `INSERT INTO minion_jobs (name, queue, status, lock_until, updated_at, created_at, finished_at, started_at)
     VALUES ($1, $2, $3, ${extra.lockUntilSql ?? 'NULL'}, ${extra.updatedAtSql ?? 'now()'}, ${extra.createdAtSql ?? 'now()'}, ${extra.finishedAtSql ?? 'NULL'}, ${extra.startedAtSql ?? 'NULL'})`,
    [name, queue, status],
  );
}

describe('issue #2557 — queue_health catches deferred embed with no worker', () => {
  it('warns when old embed-backfill jobs have no live worker for their queue', async () => {
    await seed('default', 'embed-backfill', 'waiting', {
      createdAtSql: "now() - interval '3 hours'",
    });
    const check = await computeQueueHealthCheck(pgLike, {
      readWorkers: () => [],
      oldWaitingHours: 1,
    });
    expect(check.status).toBe('warn');
    expect(check.message).toContain('embed-backfill');
    expect(check.message).toContain('no live worker');
    expect(check.message).toContain('gbrain jobs work --queue default');
  });

  it('does not warn for old embed-backfill jobs when a worker is live on that queue', async () => {
    await seed('default', 'embed-backfill', 'waiting', {
      createdAtSql: "now() - interval '3 hours'",
    });
    const check = await computeQueueHealthCheck(pgLike, {
      readWorkers: () => [{ queue: 'default' }],
      oldWaitingHours: 1,
    });
    expect(check.status).toBe('ok');
    // FRA-23078 widened the no-worker sweep from embed-backfill alone to the
    // maintenance job names too, so the ok-message names both classes.
    expect(check.message).toContain('no old maintenance/embed-backfill jobs without a worker');
  });

  // FRA-23078: the same no-worker signal must now fire for maintenance jobs.
  // The maintenance lane is served only by autopilot's managed worker, so
  // "queue up, worker down" is the one starvation surface the lane adds —
  // this test is what keeps it observable.
  it('warns when old maintenance jobs have no live worker for their queue', async () => {
    await seed('maintenance', 'extract-atoms-drain', 'waiting', {
      createdAtSql: "now() - interval '3 hours'",
    });
    const check = await computeQueueHealthCheck(pgLike, {
      readWorkers: () => [{ queue: 'default' }],
      oldWaitingHours: 1,
    });
    expect(check.status).toBe('warn');
    expect(check.message).toContain('extract-atoms-drain');
    expect(check.message).toContain('no live worker');
    expect(check.message).toContain('gbrain jobs work --queue maintenance');
  });
});

// FRA-23078 — depth alone conflated a healthy bulk backfill with a wedge, so
// a 6-hour chronicle_extract drain and a dead worker produced the same warn.
describe('FRA-23078 — queue_health distinguishes draining backlog from wedge', () => {
  it('reports a deep queue with recent completions as a backlog, not a warn', async () => {
    for (let i = 0; i < 12; i++) await seed('default', 'chronicle_extract', 'waiting');
    // Drain evidence: completions for the SAME (name, queue) inside the window.
    for (let i = 0; i < 6; i++) {
      await seed('default', 'chronicle_extract', 'completed', {
        finishedAtSql: "now() - interval '2 min'",
      });
    }
    const check = await computeQueueHealthCheck(pgLike, {
      waitingDepthThreshold: 10,
      drainWindowMinutes: 15,
      readWorkers: () => [{ queue: 'default' }],
    });
    expect(check.status).toBe('ok');
    expect(check.message).toContain('Draining backlog (not a wedge)');
    expect(check.message).toContain('chronicle_extract@default=12');
  });

  it('warns for a deep queue with nothing running and no completions', async () => {
    for (let i = 0; i < 12; i++) await seed('default', 'chronicle_extract', 'waiting');
    const check = await computeQueueHealthCheck(pgLike, {
      waitingDepthThreshold: 10,
      drainWindowMinutes: 15,
      readWorkers: () => [{ queue: 'default' }],
    });
    expect(check.status).toBe('warn');
    expect(check.message).toContain('appears WEDGED');
    expect(check.message).toContain('chronicle_extract');
  });

  it('treats a slow handler with a live-locked job in flight as not wedged', async () => {
    // The false-positive this guards: 12 queued jobs, none finished inside the
    // window because each one takes longer than the window itself.
    for (let i = 0; i < 12; i++) await seed('default', 'autopilot-cycle', 'waiting');
    await seed('default', 'autopilot-cycle', 'active', {
      lockUntilSql: "now() + interval '5 min'",
      startedAtSql: "now() - interval '20 min'",
    });
    const check = await computeQueueHealthCheck(pgLike, {
      waitingDepthThreshold: 10,
      drainWindowMinutes: 15,
      readWorkers: () => [{ queue: 'default' }],
    });
    expect(check.status).toBe('ok');
    expect(check.message).toContain('slow handler, not wedged');
  });

  it('warns when a deep queue has recent failures even if some completed', async () => {
    for (let i = 0; i < 12; i++) await seed('default', 'chronicle_extract', 'waiting');
    await seed('default', 'chronicle_extract', 'completed', {
      finishedAtSql: "now() - interval '2 min'",
    });
    await seed('default', 'chronicle_extract', 'dead', {
      finishedAtSql: "now() - interval '1 min'",
    });
    const check = await computeQueueHealthCheck(pgLike, {
      waitingDepthThreshold: 10,
      drainWindowMinutes: 15,
      readWorkers: () => [{ queue: 'default' }],
    });
    expect(check.status).toBe('warn');
    expect(check.message).toContain('appears WEDGED');
    expect(check.message).toContain('1 failed/dead');
  });
});

describe('issue #1801 fix #3 — computeWedgedQueueCheck', () => {
  it('flags a wedged queue (waiting, 0 active_healthy, stale completion) as fail', async () => {
    await seed('default', 'cycle', 'waiting');
    await seed('default', 'cycle', 'completed', { updatedAtSql: "now() - interval '20 min'" });
    const check = await computeWedgedQueueCheck(pgLike);
    expect(check.status).toBe('fail');
    expect(check.message).toContain("'default'");
  });

  it('does NOT flag when a job holds a live lock (active_healthy > 0)', async () => {
    await seed('default', 'cycle', 'waiting');
    await seed('default', 'cycle', 'active', { lockUntilSql: "now() + interval '5 min'" });
    await seed('default', 'cycle', 'completed', { updatedAtSql: "now() - interval '20 min'" });
    const check = await computeWedgedQueueCheck(pgLike);
    expect(check.status).toBe('ok');
  });

  it('does NOT flag an expired-lock active row as healthy — still wedged (Codex #6)', async () => {
    await seed('default', 'cycle', 'waiting');
    await seed('default', 'cycle', 'active', { lockUntilSql: "now() - interval '2 min'" }); // expired
    await seed('default', 'cycle', 'completed', { updatedAtSql: "now() - interval '20 min'" });
    const check = await computeWedgedQueueCheck(pgLike);
    expect(check.status).toBe('fail'); // expired lock does not count as active_healthy
  });

  it('is conservative on never-completed queues (null mins → ok)', async () => {
    await seed('default', 'cycle', 'waiting'); // no completed row → mins null
    const check = await computeWedgedQueueCheck(pgLike);
    expect(check.status).toBe('ok');
  });

  it('groups by queue — a healthy queue does not mask a wedged one (Codex #15)', async () => {
    // healthy queue
    await seed('q-healthy', 'cycle', 'active', { lockUntilSql: "now() + interval '5 min'" });
    await seed('q-healthy', 'cycle', 'completed', { updatedAtSql: 'now()' });
    // wedged queue
    await seed('q-wedged', 'cycle', 'waiting');
    await seed('q-wedged', 'cycle', 'completed', { updatedAtSql: "now() - interval '30 min'" });
    const check = await computeWedgedQueueCheck(pgLike);
    expect(check.status).toBe('fail');
    expect(check.message).toContain("'q-wedged'");
    expect(check.message).not.toContain("'q-healthy'");
  });

  it('returns ok on PGLite (no multi-process worker surface)', async () => {
    const check = await computeWedgedQueueCheck(base as unknown as BrainEngine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('PGLite');
  });
});

describe('issue #1801 fix #3 — remote queue_health state→status regression', () => {
  it('doctor.ts no longer queries the non-existent `state` column', () => {
    const src = readFileSync(
      join(import.meta.dir, '..', 'src', 'commands', 'doctor.ts'),
      'utf8',
    );
    // The column is `status`; the pre-fix `WHERE state = 'active'` errored every
    // run and the catch silently returned "No queue activity".
    expect(src).not.toContain("state = 'active'");
  });
});
