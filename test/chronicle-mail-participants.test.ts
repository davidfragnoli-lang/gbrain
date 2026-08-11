/**
 * FRA-1426 — resolve mail participants to person entity slugs.
 * PGLite in-memory. Covers the pure parser (semicolon/comma/angle/quoted
 * splitting, "Last, First" normalization), the DB-backed entity index +
 * resolver, the backfill projection pass, and the extract-time integration
 * that lifts timeline coverage + last-seen for a resolved person.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  parseParticipantField,
  parseMailParticipants,
  normalizeDisplayName,
  buildEntityIndex,
  resolveMailWho,
} from '../src/core/chronicle/mail-participants.ts';
import { runMailParticipantProjection } from '../src/core/chronicle/project-participants.ts';
import { runChronicleExtract } from '../src/core/chronicle/extract-events.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });

describe('parseParticipantField — address-list splitting', () => {
  test('semicolon-separated addresses', () => {
    const p = parseParticipantField('a@x.com;David.Costantino@swatch.com;c@z.de');
    expect(p.map((x) => x.address)).toEqual(['a@x.com', 'david.costantino@swatch.com', 'c@z.de']);
  });
  test('comma-separated addresses (2+ @ triggers comma split)', () => {
    const p = parseParticipantField('Alain.Hamel@distico.ch, David.Fragnoli@distico.ch');
    expect(p.map((x) => x.address)).toEqual(['alain.hamel@distico.ch', 'david.fragnoli@distico.ch']);
  });
  test('"Last, First" with no address is ONE participant (comma not a separator)', () => {
    const p = parseParticipantField('Costantino, David');
    expect(p.length).toBe(1);
    expect(p[0].address).toBeNull();
    expect(p[0].displayName).toBe('David Costantino');
  });
  test('display name with angle address', () => {
    const p = parseParticipantField('ServiceDesk <SGS-ServiceDesk@swatchgroup.com>');
    expect(p.length).toBe(1);
    expect(p[0].address).toBe('sgs-servicedesk@swatchgroup.com');
    expect(p[0].displayName).toBe('ServiceDesk');
  });
  test('bare angle address has no display name', () => {
    const p = parseParticipantField('<David.Fragnoli@distico.ch>');
    expect(p[0].address).toBe('david.fragnoli@distico.ch');
    expect(p[0].displayName).toBeNull();
  });
  test('quoted "Last, First" <addr> pairs comma-separated do not over-split', () => {
    const p = parseParticipantField('"Costantino, David" <d.c@swatch.com>, "Hamel, Alain" <a.h@distico.ch>');
    expect(p.length).toBe(2);
    expect(p[0].address).toBe('d.c@swatch.com');
    expect(p[0].displayName).toBe('David Costantino');
    expect(p[1].address).toBe('a.h@distico.ch');
  });
  test('empty / non-string fields', () => {
    expect(parseParticipantField('')).toEqual([]);
    expect(parseParticipantField(undefined)).toEqual([]);
    expect(parseParticipantField(['a@x.com', 'b@y.com']).map((x) => x.address)).toEqual(['a@x.com', 'b@y.com']);
  });
});

describe('normalizeDisplayName', () => {
  test('swaps two-field Last, First', () => {
    expect(normalizeDisplayName('Costantino, David')).toBe('David Costantino');
  });
  test('leaves multi-comma junk alone', () => {
    expect(normalizeDisplayName('Dufort, Michaël dans Teams')).toBe('Dufort, Michaël dans Teams');
  });
  test('leaves a plain name alone', () => {
    expect(normalizeDisplayName('David Fragnoli')).toBe('David Fragnoli');
  });
});

describe('parseMailParticipants — sender first', () => {
  test('from before to/cc', () => {
    const p = parseMailParticipants({
      from: 'boss@x.com', to: 'a@y.com;b@z.com', cc: 'c@w.com',
    });
    expect(p.map((x) => x.address)).toEqual(['boss@x.com', 'a@y.com', 'b@z.com', 'c@w.com']);
  });
});

describe('buildEntityIndex + resolveMailWho (DB-backed)', () => {
  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM timeline_entries');
    await engine.executeRaw(`DELETE FROM pages`);
    // Two person pages; one page also mentions a colleague's address in a
    // relationship note — the owner-overlap heuristic must attribute correctly.
    await engine.putPage('people/david-costantino', {
      type: 'person', title: 'David Costantino',
      compiled_truth: 'Email: David.Costantino@swatch.com. Works with David.Fragnoli@distico.ch.',
      frontmatter: { type: 'person' },
    });
    await engine.putPage('people/david-fragnoli', {
      type: 'person', title: 'David Fragnoli',
      compiled_truth: 'Email: David.Fragnoli@distico.ch.',
      frontmatter: { type: 'person' },
    });
  });

  test('address resolves to the owner, not the page that quotes it', async () => {
    const index = await buildEntityIndex(engine, { sourceIds: ['default'] });
    expect(index.byEmail.get('david.costantino@swatch.com')).toEqual(['people/david-costantino']);
    expect(index.byEmail.get('david.fragnoli@distico.ch')).toEqual(['people/david-fragnoli']);
  });

  test('resolveMailWho maps addresses to slugs, keeps unknowns verbatim', async () => {
    const index = await buildEntityIndex(engine, 'default');
    const { who, entitySlugs } = resolveMailWho({
      from: 'David.Costantino@swatch.com',
      to: 'David.Fragnoli@distico.ch;stranger@nowhere.com',
    }, index);
    expect(who).toEqual(['people/david-costantino', 'people/david-fragnoli', 'stranger@nowhere.com']);
    expect(entitySlugs).toEqual(['people/david-costantino', 'people/david-fragnoli']);
  });

  test('display-name "Last, First" resolves via the name index', async () => {
    const index = await buildEntityIndex(engine, 'default');
    const { entitySlugs } = resolveMailWho({ from: 'Costantino, David' }, index);
    expect(entitySlugs).toEqual(['people/david-costantino']);
  });

  test('duplicate pages of one owner are all covered; canonical who is lexically first', async () => {
    // A bare slug + a brain/people/ slug for the SAME person (the real corpus
    // shape). Both carry the same address → both should be covered.
    await engine.putPage('brain/people/david-costantino', {
      type: 'person', title: 'David Costantino',
      compiled_truth: 'Email: David.Costantino@swatch.com.',
      frontmatter: { type: 'person' },
    });
    const index = await buildEntityIndex(engine, { sourceIds: ['default'] });
    const emails = index.byEmail.get('david.costantino@swatch.com');
    expect(emails).toEqual(['brain/people/david-costantino', 'people/david-costantino']);
    const { who, entitySlugs } = resolveMailWho({ from: 'David.Costantino@swatch.com' }, index);
    expect(who).toEqual(['brain/people/david-costantino']); // canonical = lexically first
    expect(entitySlugs).toEqual(['brain/people/david-costantino', 'people/david-costantino']);
  });
});

describe('runMailParticipantProjection — coverage + last-seen', () => {
  const MAIL = 'emails/2025-08-27-distico';
  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM timeline_entries');
    await engine.executeRaw(`DELETE FROM pages`);
    await engine.putPage('people/david-costantino', {
      type: 'person', title: 'David Costantino',
      compiled_truth: 'Email: David.Costantino@swatch.com.',
      frontmatter: { type: 'person' },
    });
    await engine.putPage('people/david-fragnoli', {
      type: 'person', title: 'David Fragnoli',
      compiled_truth: 'Email: David.Fragnoli@distico.ch.',
      frontmatter: { type: 'person' },
    });
    await engine.putPage(MAIL, {
      type: 'email', title: 'Printer loan',
      compiled_truth: 'Confirmed.',
      frontmatter: {
        type: 'email',
        from: 'David.Costantino@swatch.com',
        to: 'David.Fragnoli@distico.ch',
        subject: 'Printer loan',
        received: '2025-08-27T09:34:05Z',
      },
    });
  });

  test('projection resolves who and fans out entity contact rows', async () => {
    await runChronicleExtract(engine, { slug: MAIL });
    const res = await runMailParticipantProjection(engine, { sourceId: 'default' });
    expect(res.events_scanned).toBe(1);
    expect(res.events_relinked).toBe(1);
    expect(res.entities_covered).toBe(2);

    // The event.who now holds canonical slugs.
    const ev = await engine.executeRaw<{ who: string[] }>(
      `SELECT frontmatter->'event'->'who' AS who FROM pages WHERE type='event' LIMIT 1`,
    );
    expect(ev[0].who).toEqual(['people/david-costantino', 'people/david-fragnoli']);

    // Both person pages now have a direct timeline row → coverage counts them.
    const cov = await engine.executeRaw<{ n: number }>(
      `SELECT count(DISTINCT page_id)::int AS n FROM timeline_entries te
        JOIN pages p ON p.id = te.page_id WHERE p.type='person'`,
    );
    expect(Number(cov[0].n)).toBe(2);

    // Acceptance: last-seen for the resolved person returns the mail date.
    const ls = await engine.getLastSeen('people/david-costantino', { asof: '2025-09-06' });
    expect(ls.last_date).toBe('2025-08-27');
    expect(ls.days_ago).toBe(10);
  });

  test('idempotent: second run writes no new contact rows', async () => {
    await runChronicleExtract(engine, { slug: MAIL });
    await runMailParticipantProjection(engine, { sourceId: 'default' });
    const before = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM timeline_entries`);
    const res2 = await runMailParticipantProjection(engine, { sourceId: 'default' });
    expect(res2.contact_rows_written).toBe(0);
    const after = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM timeline_entries`);
    expect(Number(after[0].n)).toBe(Number(before[0].n));
  });

  test('extract-time path also resolves who + covers people', async () => {
    // No separate projection pass — runChronicleExtract itself resolves.
    await runChronicleExtract(engine, { slug: MAIL });
    const cov = await engine.executeRaw<{ n: number }>(
      `SELECT count(DISTINCT page_id)::int AS n FROM timeline_entries te
        JOIN pages p ON p.id = te.page_id WHERE p.type='person'`,
    );
    expect(Number(cov[0].n)).toBe(2);
    const ls = await engine.getLastSeen('people/david-fragnoli', { asof: '2025-08-28' });
    expect(ls.last_date).toBe('2025-08-27');
  });
});
