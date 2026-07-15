// FRA-1426 — projection pass: link mail-derived timeline events to person
// entity pages.
//
// Runs over the existing mail `event` pages, resolves each event's raw `who`
// participants to canonical entity slugs (see mail-participants.ts), rewrites
// the event's `event.who` to those slugs, and fans out a per-participant
// timeline row onto each resolved entity page. The fan-out row is what lifts
// `doctor graph_coverage` timeline coverage: that metric counts entity pages
// that have a `timeline_entries` row with `page_id = <entity>`.
//
// Fan-out rows carry `event_page_id = NULL` on purpose. The chronicle event
// projection has a UNIQUE (event_page_id, date) partial index — one row per
// event per day — so we cannot attach the same event_page_id to N participant
// rows. Idempotency instead rides the (page_id, date, summary, source) unique,
// with `source = life-chronicle:contact:<eventSlug>` making re-runs a no-op.
// `getLastSeen` still resolves the last-contact DATE via the entity's own
// page_id row (and via the rewritten `who` array), so both acceptance signals
// hold.
import type { BrainEngine } from '../engine.ts';
import { buildEntityIndex, resolveMailWho, type EntityIndex } from './mail-participants.ts';
import { isoDay } from './extract-events.ts';

/**
 * Fan out a per-participant contact timeline row onto each resolved entity
 * page. Shared by the backfill projection pass and the live extract path.
 * Returns the number of NEW rows written (existing rows dedup silently). Rows
 * carry `event_page_id = NULL` — see the module header for why.
 */
export async function fanOutContactRows(
  engine: BrainEngine,
  opts: {
    entitySlugs: string[];
    day: string;
    summary: string;
    eventSlug: string;
    sourceId: string;
    /** entity slug → source_id its page lives under (cross-source fan-out). */
    slugSource?: Map<string, string>;
  },
): Promise<{ written: number; covered: string[] }> {
  const summary = (opts.summary || '(mail)').slice(0, 500);
  const source = `life-chronicle:contact:${opts.eventSlug}`;
  const covered: string[] = [];
  let written = 0;
  for (const slug of opts.entitySlugs) {
    // Entity pages may live under a different source than the mail event
    // (persons in `default`, mail in `swatch-mail`); attach the row to the
    // entity page in its OWN source.
    const entSource = opts.slugSource?.get(slug) ?? opts.sourceId;
    const rows = await engine.executeRaw<{ id: number }>(
      `INSERT INTO timeline_entries (page_id, date, source, summary, detail, event_page_id)
       SELECT pp.id, $2::date, $3, $4, '', NULL
         FROM pages pp
        WHERE pp.slug = $1 AND pp.source_id = $5 AND pp.deleted_at IS NULL
       ON CONFLICT (page_id, date, summary, source) DO NOTHING
       RETURNING id`,
      [slug, opts.day, source, summary, entSource],
    );
    if (rows.length > 0) written++;
    covered.push(slug);
  }
  return { written, covered };
}

export interface ParticipantProjectionResult {
  events_scanned: number;
  events_relinked: number;      // events whose who[] gained ≥1 entity slug
  contact_rows_written: number; // timeline rows fanned out onto entity pages
  entities_covered: number;     // distinct entity slugs that received ≥1 row
}

interface EventRow {
  slug: string;
  depth_slug: string | null;
  when: string | null;
  what: string | null;
  depth_frontmatter: Record<string, unknown> | null;
}

/**
 * Resolve + fan out participants for every mail-derived event page in the
 * source. Idempotent: re-running upserts the same event `who` and no-ops the
 * contact rows. `onProgress` is called every `progressEvery` events for CLI
 * heartbeats.
 */
export async function runMailParticipantProjection(
  engine: BrainEngine,
  opts: {
    /** source holding the mail EVENT + depth pages (e.g. `swatch-mail`). */
    sourceId?: string;
    tz?: string;
    /** prebuilt cross-source entity index; built globally when omitted. */
    index?: EntityIndex;
    signal?: AbortSignal;
    onProgress?: (done: number, total: number) => void;
    progressEvery?: number;
  } = {},
): Promise<ParticipantProjectionResult> {
  const sourceId = opts.sourceId ?? 'default';
  const tz = opts.tz ?? 'UTC';
  // Entity index is cross-source by default (persons in `default`, mail events
  // often in a separate source).
  const index = opts.index ?? (await buildEntityIndex(engine));
  const progressEvery = opts.progressEvery ?? 250;

  // Mail-derived events: kind === 'email'. Join the depth (mail) page so we can
  // re-resolve from the clean from/to/cc frontmatter rather than the already
  // flattened who[].
  const events = await engine.executeRaw<EventRow>(
    `SELECT e.slug AS slug,
            e.frontmatter->'event'->>'depth' AS depth_slug,
            e.frontmatter->'event'->>'when'  AS when,
            e.frontmatter->'event'->>'what'  AS what,
            dp.frontmatter                    AS depth_frontmatter
       FROM pages e
       LEFT JOIN pages dp ON dp.slug = e.frontmatter->'event'->>'depth'
                         AND dp.source_id = $1 AND dp.deleted_at IS NULL
      WHERE e.source_id = $1 AND e.deleted_at IS NULL
        AND e.type = 'event'
        AND e.frontmatter->'event'->>'kind' = 'email'`,
    [sourceId],
  );

  const result: ParticipantProjectionResult = {
    events_scanned: 0,
    events_relinked: 0,
    contact_rows_written: 0,
    entities_covered: 0,
  };
  const coveredEntities = new Set<string>();

  for (const ev of events) {
    if (opts.signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    result.events_scanned++;

    const fm = ev.depth_frontmatter && typeof ev.depth_frontmatter === 'object' ? ev.depth_frontmatter : {};
    const { who, entitySlugs } = resolveMailWho(fm, index);
    // Nothing resolved and no depth frontmatter → skip (leave event untouched).
    if (entitySlugs.length === 0) continue;

    // 1. Rewrite event.who to the canonical (resolved + verbatim) participant
    //    list. Build the jsonb via `to_jsonb($::text[])` from the JS array —
    //    passing `JSON.stringify(who)` to `$::jsonb` binds it as a jsonb STRING
    //    on postgres.js (double-encoded), not an array.
    await engine.executeRaw(
      `UPDATE pages
          SET frontmatter = jsonb_set(frontmatter, '{event,who}', to_jsonb($3::text[]), true)
        WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL`,
      [ev.slug, sourceId, who],
    );
    result.events_relinked++;

    // 2. Fan out a contact row onto each resolved entity page.
    const day = isoDay(ev.when || new Date(0).toISOString(), tz);
    const { written, covered } = await fanOutContactRows(engine, {
      entitySlugs, day, summary: ev.what || '(mail)', eventSlug: ev.slug, sourceId,
      slugSource: index.slugSource,
    });
    result.contact_rows_written += written;
    for (const slug of covered) coveredEntities.add(slug);

    if (result.events_scanned % progressEvery === 0) {
      opts.onProgress?.(result.events_scanned, events.length);
    }
  }

  result.entities_covered = coveredEntities.size;
  opts.onProgress?.(result.events_scanned, events.length);
  return result;
}
