/**
 * FRA-22903 — cross-process DAILY spend ceiling, read from the budget audit
 * ledger.
 *
 * Why this exists
 * ---------------
 * `BudgetTracker` caps a SINGLE invocation (`maxCostUsd`). It holds its
 * cumulative total in memory, so every new tracker starts at $0. That is
 * correct for "this command may spend at most $N", but it means there is no
 * ceiling on a *repeating* caller.
 *
 * On 2026-07-27 the autopilot phase `conversation_facts_backfill` ran with a
 * per-cycle cap of $5 and a cycle period of ~600s. Each cycle built a fresh
 * tracker, spent up to its $5, and exited — a structural ceiling of roughly
 * $720/day with nothing between it and the API key. Observed: $49.89 in ~3h
 * on top of an $80 authorised drain, for a $141.91 day against a ~$80 budget.
 *
 * A per-invocation cap can never bound a per-day bill. This module adds the
 * missing axis.
 *
 * How it works
 * ------------
 * The budget audit JSONL (`~/.gbrain/audit/budget-YYYY-Www.jsonl`) is already
 * the operator's source of truth for real spend — every priced call appends an
 * `event:"record"` row carrying `actual_cost_usd`. We reuse it as the shared
 * accumulator: summing today's `record` rows gives total spend across EVERY
 * gbrain process (autopilot, jobs worker, interactive CLI), not just this one.
 *
 * The ledger is the single source of truth. The cached total is only ever
 * derived from bytes actually read off disk — never incremented by hand — so a
 * process reading back its own freshly-appended row cannot double-count it.
 *
 * Reads are incremental: we remember a byte offset per file and parse only the
 * bytes appended since the last read. A full rescan happens once per UTC day
 * rollover (and on truncation/rotation). This matters — the live ledger is
 * ~37MB / 118k lines per week, and the hot path runs tens of thousands of times
 * per drain.
 *
 * Known limitations (deliberate, documented rather than over-engineered):
 *   - Audit appends are best-effort (a disk-full audit never gates an LLM
 *     call). If a write is lost, the day total under-counts by that row.
 *   - Between throttled refreshes the total can lag by up to REFRESH_MS worth
 *     of concurrent spend. At the observed peak burn (~$24/h) that is ~$0.007.
 *     `forceFresh` bypasses the throttle near the cap so the boundary itself is
 *     enforced against a current read.
 *   - Rows are attributed to a UTC day, matching the `ts` field they carry.
 */

import { openSync, readSync, fstatSync, closeSync } from 'node:fs';

/** Default ceiling on all gbrain LLM spend per UTC day, in USD. */
export const DEFAULT_MAX_DAILY_COST_USD = 100;

/**
 * Minimum gap between incremental ledger reads on the hot path. Bounds syscall
 * volume during a 37k-call drain while keeping the total near-current.
 */
const REFRESH_MS = 1_000;

/**
 * When the day total reaches this fraction of the cap, callers should stop
 * trusting the throttled cache and force a fresh read, so the boundary is
 * decided on current data rather than up-to-REFRESH_MS-stale data.
 */
export const NEAR_CAP_FRACTION = 0.9;

interface LedgerCursor {
  /** UTC day (YYYY-MM-DD) the running total belongs to. */
  day: string;
  /** Bytes of the file already parsed. */
  offset: number;
  /** Inode of the file the offset refers to, to detect replacement. */
  ino: number;
  /** Sum of `actual_cost_usd` over today's `record` rows seen so far. */
  total: number;
  /**
   * Per-tracker breakdown of `total`, keyed by the `tracker_id` stamped on each
   * record row. Lets a live tracker subtract its OWN rows and substitute its
   * exact in-memory cumulative instead — see readDailySpendUsd's
   * `excludeTrackerId`. Bounded by the number of trackers created in a day.
   */
  byTracker: Map<string, number>;
  /** Trailing partial line carried across reads (an append may split a line). */
  tail: string;
  /** Wall-clock ms of the last read, for throttling. */
  lastReadMs: number;
}

const cursors = new Map<string, LedgerCursor>();

/** Test seam: drop all cached cursors so a test can start from a clean slate. */
export function _resetDailyLedgerCacheForTest(): void {
  cursors.clear();
}

function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Read `[offset, size)` from an already-open fd as UTF-8. */
function readRange(fd: number, offset: number, size: number): string {
  const length = size - offset;
  if (length <= 0) return '';
  const buf = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const n = readSync(fd, buf, read, length - read, offset + read);
    if (n <= 0) break;
    read += n;
  }
  return buf.subarray(0, read).toString('utf8');
}

/**
 * Fold newly-appended ledger bytes into `cursor`, counting only `record` rows
 * whose `ts` falls on `cursor.day`. Malformed lines are skipped: a corrupt
 * audit row must not crash a caller, and under-counting is the safe direction
 * for a best-effort ledger.
 */
function consume(cursor: LedgerCursor, chunk: string): void {
  const lines = (cursor.tail + chunk).split('\n');
  // The final element is either '' (chunk ended on a newline) or a partial
  // line whose remaining bytes have not been written yet. Carry it forward.
  cursor.tail = lines.pop() ?? '';
  for (const line of lines) {
    if (line.length === 0) continue;
    // Cheap pre-filter: skip the JSON.parse for rows that cannot contribute.
    // `record_unpriced` rows carry no cost, and reserve/deny rows are not
    // spend. Only `"event":"record"` adds to the total.
    if (!line.includes('"event":"record"')) continue;
    let row: { event?: string; ts?: string; actual_cost_usd?: unknown; tracker_id?: unknown };
    try {
      row = JSON.parse(line) as typeof row;
    } catch {
      continue;
    }
    if (row.event !== 'record') continue;
    if (typeof row.ts !== 'string' || !row.ts.startsWith(cursor.day)) continue;
    const cost = row.actual_cost_usd;
    if (typeof cost === 'number' && Number.isFinite(cost)) {
      cursor.total += cost;
      const id = row.tracker_id;
      if (typeof id === 'string') {
        cursor.byTracker.set(id, (cursor.byTracker.get(id) ?? 0) + cost);
      }
    }
  }
}

/**
 * Total USD recorded across `paths` for the current UTC day.
 *
 * Pass every ledger file that could hold today's rows. Callers normally pass
 * both the tracker's own audit path and the current default path: those differ
 * only across an ISO-week rotation, and because rows are day-filtered a given
 * row lives in exactly one file, so summing both cannot double-count.
 *
 * @param forceFresh bypass the read throttle (use near the cap boundary).
 */
export function readDailySpendUsd(
  paths: readonly string[],
  opts: { nowMs?: number; forceFresh?: boolean; excludeTrackerId?: string } = {},
): number {
  const nowMs = opts.nowMs ?? Date.now();
  const day = utcDay(nowMs);
  let total = 0;

  for (const path of new Set(paths)) {
    let cursor = cursors.get(path);

    // A new day invalidates the running total: rescan from byte 0 so rows
    // written earlier today by other processes are picked up.
    if (!cursor || cursor.day !== day) {
      cursor = { day, offset: 0, ino: -1, total: 0, byTracker: new Map(), tail: '', lastReadMs: 0 };
      cursors.set(path, cursor);
    }

    const stale = nowMs - cursor.lastReadMs >= REFRESH_MS;
    if (stale || opts.forceFresh) {
      let fd: number | undefined;
      try {
        fd = openSync(path, 'r');
        const st = fstatSync(fd);
        const size = st.size;
        // The offset only means something for the file we read it from. A
        // different inode (rotation, atomic replace) or a shrunk file makes it
        // meaningless, so re-derive the day total from byte 0. Inode is checked
        // as well as size because a same-size replacement is invisible to a
        // size comparison alone.
        if (cursor.ino !== st.ino || size < cursor.offset) {
          cursor.offset = 0;
          cursor.total = 0;
          cursor.byTracker.clear();
          cursor.tail = '';
          cursor.ino = st.ino;
        }
        if (size > cursor.offset) {
          consume(cursor, readRange(fd, cursor.offset, size));
          cursor.offset = size;
        }
        cursor.lastReadMs = nowMs;
      } catch {
        // Missing/unreadable ledger: contribute what we have. A ledger that
        // cannot be read must not hard-fail an LLM call — the tracker's own
        // per-invocation cap still applies.
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }

    total += cursor.total;
    // Caller supplies its own exact in-memory cumulative instead of its
    // (possibly stale, possibly unflushed) rows on disk.
    if (opts.excludeTrackerId !== undefined) {
      total -= cursor.byTracker.get(opts.excludeTrackerId) ?? 0;
    }
  }

  return total;
}

/**
 * Resolve the daily ceiling for a tracker.
 *
 * Precedence: explicit option > `GBRAIN_MAX_DAILY_COST_USD` env >
 * {@link DEFAULT_MAX_DAILY_COST_USD}.
 *
 * Returns `undefined` (gate disabled) when the resolved value is `0`, negative,
 * or one of `off` / `none` / `unlimited`. That escape hatch exists so an
 * operator can deliberately authorise a larger single-day program without
 * editing code — an explicit, auditable act, unlike the previous state where
 * no ceiling existed at all.
 */
export function resolveDailyCapUsd(explicit?: number): number | undefined {
  if (explicit !== undefined) {
    return Number.isFinite(explicit) && explicit > 0 ? explicit : undefined;
  }
  const raw = process.env.GBRAIN_MAX_DAILY_COST_USD?.trim();
  if (raw !== undefined && raw.length > 0) {
    if (/^(off|none|unlimited)$/i.test(raw)) return undefined;
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed)) return parsed > 0 ? parsed : undefined;
    // Unparseable value: fall through to the default rather than silently
    // running uncapped. A typo must not disable the ceiling.
  }
  return DEFAULT_MAX_DAILY_COST_USD;
}
