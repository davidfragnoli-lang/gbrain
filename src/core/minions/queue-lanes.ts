/**
 * Queue lane constants — side-effect-free constant module (FRA-23078).
 *
 * Before this module every job shared one queue (`default`) served by the two
 * worker processes (the standalone supervisor's and autopilot's own child
 * worker). A bulk backfill therefore head-of-line-blocked the nightly's own
 * maintenance work: on 2026-07-29 a ~7,955-job `chronicle_extract` backfill
 * entered `default` at 01:05Z and the autopilot cycles, sync, and
 * extract-atoms-drain submitted right behind it were still `waiting` two hours
 * later. Nothing was wedged — the queue drained at ~1,040 jobs/h — but the
 * brain ran ~6h with no maintenance, and `gbrain doctor` reported that as
 * several unrelated warns (`extract_atoms_backlog`, `cycle_freshness`) instead
 * of the one cause.
 *
 * The split is two-sided, because either half alone leaves a hole:
 *
 *   1. MAINTENANCE_QUEUE — the autopilot submitters target their own lane, and
 *      autopilot's managed child worker is bound to it. `MinionQueue.claim()`
 *      filters `WHERE queue = $3`, so a bulk backfill on `default` is simply
 *      invisible to that worker. This is the isolation guarantee.
 *
 *      Crucially the lane is served by the *same process tree that submits to
 *      it*: autopilot spawns its worker under ChildWorkerSupervisor, so the
 *      lane cannot outlive its own worker. A separate launchd-supervised
 *      worker would have added a new silent-starvation surface (queue up,
 *      worker down, jobs waiting forever) — this shape has none, and
 *      `queue_health`'s no-worker check covers the residual case where
 *      autopilot itself is down.
 *
 *   2. BULK_JOB_PRIORITY — mass-backfill submitters deprioritize themselves on
 *      `default`. Claim order is `ORDER BY priority ASC, created_at ASC`
 *      (LOWER number = claimed first), so bulk rows sort behind every
 *      ordinary `default` submission regardless of arrival time. This matters
 *      independently of the lane split: on 2026-07-29 two `embed-backfill`
 *      jobs at priority 5 were also starved, because they were *below* the
 *      backfill's implicit priority 0. Deprioritizing bulk fixes that class
 *      without needing a lane for every caller.
 *
 * This file must stay pure — no imports, no filesystem, no env reads. Both
 * queue core and the doctor import it.
 */

/**
 * Dedicated lane for scheduled maintenance work (autopilot cycles, global
 * maintenance, freshness sync, atoms drains).
 *
 * Served by autopilot's managed child worker (`gbrain jobs work --queue
 * maintenance`). Do NOT point the standalone supervisor here: it defaults to
 * `default` and is what keeps bulk work draining.
 */
export const MAINTENANCE_QUEUE = 'maintenance';

/** The queue every non-maintenance job still uses. */
export const DEFAULT_QUEUE = 'default';

/**
 * Priority for mass-backfill submitters on `default`.
 *
 * Claim order is `priority ASC` — 0 is the implicit default and is claimed
 * FIRST, so a *higher* number is a *lower* priority. 10 leaves room both above
 * (ordinary work at 0, `embed-backfill` at 5) and below (a future
 * even-cheaper lane) without reordering anything already in flight.
 */
export const BULK_JOB_PRIORITY = 10;

/**
 * Job names that must never be starved by bulk work, and that are therefore
 * expected to live on {@link MAINTENANCE_QUEUE}.
 *
 * Used by the `queue_health` doctor check to decide which waiting jobs deserve
 * a no-live-worker warning. Keep in sync with the autopilot submitters in
 * commands/autopilot.ts and commands/autopilot-fanout.ts.
 */
export const MAINTENANCE_JOB_NAMES: ReadonlySet<string> = new Set([
  'autopilot-cycle',
  'autopilot-global-maintenance',
  'sync',
  'extract-atoms-drain',
]);
