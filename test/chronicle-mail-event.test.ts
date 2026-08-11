/**
 * v0.42.x — Life Chronicle (#2390) mail → timeline event lane (FRA-1316).
 * PGLite in-memory. Covers: email eligibility (header-derived, body-gate
 * exempt), the deterministic proposal builder (field tolerance + null guards),
 * and the end-to-end extract → event page + projection → last-seen / day path.
 * No LLM judge is injected — the mail lane is deterministic by construction.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isChronicleEligible } from '../src/core/chronicle/eligibility.ts';
import { buildMailEventProposal } from '../src/core/chronicle/mail-event.ts';
import { runChronicleExtract } from '../src/core/chronicle/extract-events.ts';

let engine: PGLiteEngine;

async function countEvents(): Promise<number> {
  const r = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE type = 'event'`);
  return Number(r[0].n);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });

describe('isChronicleEligible — email', () => {
  test('email type is eligible', () => {
    expect(isChronicleEligible({ type: 'email', slug: 'emails/2025-03-14-x', body: 'hi' }).ok).toBe(true);
  });
  test('emails/ slug rescues a note-typed page', () => {
    expect(isChronicleEligible({ type: 'note', slug: 'emails/2025-03-14-x', body: 'hi' }).ok).toBe(true);
  });
  test('a one-line mail is NOT body-gated (header-derived)', () => {
    // Same short body that excludes a meeting must NOT exclude a mail.
    expect(isChronicleEligible({ type: 'meeting', slug: 'meetings/x', body: 'ok' })).toEqual({ ok: false, reason: 'too_short' });
    expect(isChronicleEligible({ type: 'email', slug: 'emails/x', body: 'ok' }).ok).toBe(true);
  });
});

describe('buildMailEventProposal', () => {
  test('builds one event from from/to/subject/received_at', () => {
    const p = buildMailEventProposal({
      slug: 'emails/2025-03-14-order',
      frontmatter: {
        from: 'companies/swatch-group',
        to: ['people/david'],
        subject: 'Q2 order confirmation',
        received_at: '2025-03-14T09:22:00Z',
      },
    });
    expect(p).not.toBeNull();
    expect(p!.when).toBe('2025-03-14T09:22:00Z');
    expect(p!.what).toBe('Q2 order confirmation');
    expect(p!.kind).toBe('email');
    expect(p!.who[0]).toBe('companies/swatch-group'); // sender first
    expect(p!.who).toContain('people/david');
  });

  test('tolerant field names: sender/recipients/date + dedup, sender-first', () => {
    const p = buildMailEventProposal({
      slug: 'emails/x',
      frontmatter: {
        sender: 'orders@swatch.com',
        recipients: ['orders@swatch.com', 'david@fragno.co'], // dup sender
        subject: 'Re: shipment',
        date: '2025-06-01',
      },
    });
    expect(p!.who).toEqual(['orders@swatch.com', 'david@fragno.co']);
    expect(p!.when).toBe('2025-06-01');
  });

  test('falls back to effective_date and title when frontmatter is sparse', () => {
    const p = buildMailEventProposal({
      slug: 'emails/x', title: 'Invoice #42',
      frontmatter: { from: 'acme' }, effectiveDate: '2025-01-05',
    });
    expect(p!.when).toBe('2025-01-05');
    expect(p!.what).toBe('Invoice #42');
  });

  test('null when no parseable date', () => {
    expect(buildMailEventProposal({ slug: 'emails/x', title: 'Hi', frontmatter: { from: 'a', subject: 's' } })).toBeNull();
    expect(buildMailEventProposal({ slug: 'emails/x', title: 'Hi', frontmatter: { subject: 's', received_at: 'not-a-date' } })).toBeNull();
  });

  test('null when no subject or title', () => {
    expect(buildMailEventProposal({ slug: 'emails/x', frontmatter: { from: 'a', received_at: '2025-01-01' } })).toBeNull();
  });
});

describe('runChronicleExtract — mail (deterministic, no judge)', () => {
  const SLUG = 'emails/2025-03-14-swatch-order';

  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM timeline_entries');
    await engine.executeRaw(`DELETE FROM pages WHERE type = 'event' OR slug = '${SLUG}'`);
    await engine.putPage(SLUG, {
      type: 'email',
      title: 'Q2 order confirmation',
      compiled_truth: 'Confirmed.', // deliberately short — header event, not body
      frontmatter: {
        type: 'email',
        from: 'companies/swatch-group',
        to: ['people/david'],
        subject: 'Q2 order confirmation',
        received_at: '2025-03-14T09:22:00Z',
      },
    });
  });

  test('an email page emits exactly one event + timeline projection', async () => {
    const r = await runChronicleExtract(engine, { slug: SLUG });
    expect(r.status).toBe('extracted');
    expect(r.events_written).toBe(1);
    expect(await countEvents()).toBe(1);
    const day = await engine.getTimelineForDate('2025-03-14', { sourceId: 'default' });
    expect(day.length).toBe(1);
    expect(day[0].summary).toBe('Q2 order confirmation');
    expect(day[0].page_slug).toBe(SLUG); // projection keyed to the mail (depth) page
    expect(day[0].event_slug?.startsWith('life/events/2025-03-14-')).toBe(true);
    expect(day[0].kind).toBe('email');
  });

  test('acceptance: last-seen returns the received date for the supplier', async () => {
    await runChronicleExtract(engine, { slug: SLUG });
    const ls = await engine.getLastSeen('companies/swatch-group', { asof: '2025-03-24' });
    expect(ls.last_date).toBe('2025-03-14');
    expect(ls.days_ago).toBe(10);
    // LIKE-match on a bare supplier token also resolves.
    const ls2 = await engine.getLastSeen('swatch-group', { asof: '2025-03-15' });
    expect(ls2.last_date).toBe('2025-03-14');
  });

  test('idempotent: running twice yields one event + one projection', async () => {
    await runChronicleExtract(engine, { slug: SLUG });
    await runChronicleExtract(engine, { slug: SLUG });
    expect(await countEvents()).toBe(1);
    const day = await engine.getTimelineForDate('2025-03-14', { sourceId: 'default' });
    expect(day.length).toBe(1);
  });

  test('a mail with no usable date emits nothing (no garbage write)', async () => {
    const bad = 'emails/2025-no-date';
    await engine.putPage(bad, { type: 'email', title: 'x', compiled_truth: 'x', frontmatter: { type: 'email', subject: 'x' } });
    const before = await countEvents();
    const r = await runChronicleExtract(engine, { slug: bad });
    expect(r.status).toBe('no_events');
    expect(await countEvents()).toBe(before);
  });
});
